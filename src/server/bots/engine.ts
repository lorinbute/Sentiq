// The trading bots' engine (FD-BOT §8, TD-BOT §4): every 30 s, on the instance that runs the jobs, each active bot of an
// active user reads its prices, checks a real account against what it holds, exits (always), enters (only while it runs,
// within its period), and saves what it did. One bot's failure never stops the others.
import { fxCompact, fxKindOf } from '../../shared/fx.ts';
import { randomUUID } from 'node:crypto';
import { TRADING } from '../../shared/trading.ts';
import { areaOf, botInputSchema, LIQ_SAFETY, liqDistance, liveOf, perpetualOf, reached, transitionOf, type BotEndAction, type BotEventDetail, type BotEventKind, type BotInput, type BotLevelMove, type BotMarginMode, type BotScore, type BotSide, type BotStatus, type BotTradeReason, type DcaConfig, type GridConfig, type PositionsMode, type PremiumConfig } from '../../shared/bot.ts';
import { htfCandleCount, runSlingshot, type Candle, type SlingshotResult, type SlingshotSetup, type SlingshotSignal } from '../../shared/indicator/slingshot.ts';
import { dayKey, tfSeconds, type Timeframe } from '../../shared/time.ts';
import type { AiService } from '../ai/service.ts';
import type { CalendarService } from '../calendar/service.ts';
import type { Db } from '../db/database.ts';
import type { AccountsService, Portfolio } from '../exchange/accounts.ts';
import type { TradingService } from '../exchange/trading/service.ts';
import type { Logger } from '../log.ts';
import { MarketError, type MarketData } from '../market/market.ts';
import type { MarketSource } from '../market/source.ts';
import type { StockData } from '../market/stocks.ts';
import type { DailySentimentService } from '../sentiment/daily.ts';
import type { SettingsService } from '../settings.ts';
import type { InstrumentInfo } from '../../shared/trading.ts';
import { afterClose, dcaOver, dcaStep, dealLevels, newDca } from './dca.ts';
import { floorToStep, RealExec, type BotOrder, type Executor, type Fill } from './exec.ts';
import { closeAllUnits, gridMoves, gridStopped, initGrid, netUnits, startMoves, triggered, type GridMove } from './grid.ts';
import { askAi, highImpact, readMood, readSymbolNews, type MarketMood, type SymbolNews } from './inputs.ts';
import { barEvents, exitAt, fitFunds, fundsFor, LATE_TOLERANCE, lateSignals, levelsFor, setupFate, withMargin, setupsOn, signalFate, sizeFor, type Sized } from './premium.ts';
import { areaAgainst, favoured, limitOf, marketScore, passes } from './score.ts';
import { money, num, price, qty, signed } from './format.ts';
import { applyLevels, basisOf, closePnl, holdsPositions, openPnl, parseState, type BotPosition, type BotState, type ClosedTrade, type DcaDeal, type GridState, type PendingOrder, type PositionSetup, type PremiumState } from './state.ts';

const MIN = 60_000;
/** No price for this long: a problem (FD-BOT §9). */
const NO_PRICE_MS = 10 * MIN;
/** After its own order on a symbol, the bot does not check the account there for this long (the platform catches up). */
const RECONCILE_GRACE_MS = MIN;
/** Less than this share of what the bot holds: the rest was closed outside it. */
const RECONCILE_TOLERANCE = 0.98;
const EXIT_FAILURES_MAX = 10;
const NO_PRICE = 'Prețul nu se poate citi de 10 minute.';
/** After the platform refused an entry: no new entry on that symbol for this long. */
const ENTRY_PAUSE_MS = 5 * MIN;
const ERRORS_MAX = 3;
const AI_PER_DAY = 30;
const EVENTS_KEPT = 1000;
const PRUNE_EVERY_MS = 60 * MIN;
/** Before a high-impact event the window is the user's; after it, 15 minutes (FD-BOT §6). */
const AFTER_EVENT_MS = 15 * MIN;

export interface BotRow {
  id: number;
  user_id: number;
  name: string;
  strategy: BotInput['strategy'];
  execution: BotInput['exec'];
  account_id: number | null;
  market: BotInput['market'];
  area: 'crypto' | 'stocks';
  symbols: string;
  tf: Timeframe;
  config: string;
  status: BotStatus;
  status_reason: string | null;
  command: string | null;
  state: string;
  starts_at: number;
  ends_at: number | null;
  created_at: number;
  updated_at: number;
  ran_at: number | null;
  /** FD-PUSH: the bot's bell (its trades on its owner's devices). */
  notify?: boolean | number | null;
}

/**
 * What the API asks the engine (TD-BOT §1): to end with an action, to forget an order of a problem, or (FD-BOTEDIT §3) how
 * the positions the new settings cannot keep end.
 */
export interface BotCommand {
  end?: BotEndAction;
  reason?: string;
  clearPending?: boolean;
  positions?: PositionsMode;
  /** FIX-BOTDRAG: stop losses / take profits dragged on the chart, for the positions they name. */
  levels?: BotLevelMove[];
}

/** What an order is for: applied once it went through (also after a restart, when it is sent again with its key). */
type Purpose =
  | { kind: 'p_open'; symbol: string; side: BotSide; sl: number; tp: number; lev: number; signalTime?: number; mm?: BotMarginMode; setup?: PositionSetup }
  | { kind: 'p_close'; symbol: string; side: BotSide; reason: BotTradeReason }
  | { kind: 'g_moves'; moves: GridMove[]; start: boolean }
  | { kind: 'g_close'; reason: BotTradeReason; side?: BotSide }
  | { kind: 'd_open'; margin: number; lev: number; mm?: BotMarginMode }
  | { kind: 'd_add'; ks: number[]; margin: number }
  | { kind: 'd_close'; reason: BotTradeReason };

type Pending = PendingOrder & { purpose: Purpose; lev: number; price: number; sl?: number | null; tp?: number | null; mm?: BotMarginMode };

export interface BotEngineDeps {
  db: Db;
  log: Logger;
  settings: SettingsService;
  market: MarketData;
  stocks: StockData | null;
  source: MarketSource;
  daily: DailySentimentService;
  calendar: CalendarService;
  ai: AiService;
  trading: TradingService;
  accounts: AccountsService;
  now?: () => number;
  uuid?: () => string;
  /** Tests: the closed bar and Slingshot on it, made by hand (as `runSlingshot` takes hand-made series). */
  bars?: (userId: number, input: BotInput, sym: string, now: number) => Promise<Bar | null>;
  /** FD-PUSH: after a look is saved, what it opened and closed (the bot's bell sends them to its owner's devices). */
  ran?: (row: BotRow, events: { kind: BotEventKind; symbol: string | null; message: string; detail: BotEventDetail | null }[], trades: ClosedTrade[]) => Promise<void>;
}

// FD-PAPER §7: a bot still simulating (from before Paper Trading) does not run: it waits to be moved onto a profile.
export const ACTIVE_BOTS = `SELECT b.* FROM bots b JOIN users u ON u.id = b.user_id WHERE b.status <> N'ended' AND b.execution = N'real' AND u.disabled_at IS NULL ORDER BY b.id`;

export { readPrice, readQuote, type Quote } from '../market/quote.ts';
/** FIX-BOTPRICE: how old a share's price a bot's look may take (its look is every 30 s). */
export const BOT_STOCK_PRICE_MS = 25_000;
import { readPrice, readQuote } from '../market/quote.ts';

export function parseInput(row: Pick<BotRow, 'config'>): BotInput | null {
  try {
    const r = botInputSchema.safeParse(JSON.parse(row.config));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** A command without what was read of it (the same key, the same value): null when nothing is left. */
export function commandLeft(current: string, seen: string): string | null {
  const cur = parseCommand(current) ?? {};
  const read = (parseCommand(seen) ?? {}) as Record<string, unknown>;
  const left = Object.fromEntries(Object.entries(cur).filter(([k, v]) => JSON.stringify(read[k]) !== JSON.stringify(v)));
  return Object.keys(left).length ? JSON.stringify(left) : null;
}

export function parseCommand(raw: string | null): BotCommand | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BotCommand;
  } catch {
    return null;
  }
}

export class BotEngine {
  readonly deps: BotEngineDeps;
  readonly now: () => number;
  readonly uuid: () => string;
  readonly instruments = new Map<string, { info: InstrumentInfo; at: number }>();
  private readonly pruned = new Map<number, number>();

  constructor(deps: BotEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? randomUUID;
  }

  /** One look at every active bot. */
  async run(signal?: AbortSignal): Promise<void> {
    const rows = await this.deps.db.all<BotRow>(ACTIVE_BOTS);
    // The day's moods are read once a run per user and area (a decision on several bots of one user reads them once).
    const moods = new Map<string, Promise<MarketMood>>();
    for (const row of rows) {
      if (signal?.aborted) break;
      await this.look(row, moods);
    }
  }

  /** One bot (exported for the tests and for the bot just made, which looks at once). */
  async look(row: BotRow, moods = new Map<string, Promise<MarketMood>>()): Promise<void> {
    const run = new BotRun(this, row, moods);
    try {
      await run.go();
    } catch (err) {
      run.unexpected(err as Error);
    }
    await run.save();
    // FD-PUSH: told once saved (a look that failed to save tells nothing); a failure to tell never stops the bots.
    if (this.deps.ran) {
      const { events, trades } = run.outcome();
      if (events.length || trades.length) await this.deps.ran(row, events, trades).catch((err: Error) => this.deps.log.warn(`push: bot ${row.id}: ${err.message}`));
    }
    const last = this.pruned.get(row.id) ?? 0;
    if (this.now() - last > PRUNE_EVERY_MS) {
      this.pruned.set(row.id, this.now());
      await this.deps.db.run(`DELETE FROM bot_events WHERE bot_id = ? AND id NOT IN (SELECT TOP (${EVENTS_KEPT}) id FROM bot_events WHERE bot_id = ? ORDER BY id DESC)`, [row.id, row.id]);
    }
  }
}

export interface Bar {
  r: SlingshotResult;
  closed: number;
  closedTime: number;
  close: number;
  /** FIX-LATEENTRY: the candles Slingshot ran on (a late signal's entry: its confirming bar's close). */
  candles?: readonly Candle[];
  /** FIX-BOTV1STOP: the closed bar's range (a setup's stop reached on it between two looks). */
  high?: number;
  low?: number;
}

class BotRun {
  private readonly e: BotEngine;
  private readonly row: BotRow;
  private readonly moods: Map<string, Promise<MarketMood>>;
  private readonly now: number;
  private readonly st: BotState;
  /** The settings of `bots.config`: what the bot is to do. */
  private readonly config: BotInput | null;
  /** What this look runs with: the settings, or during a transition the open positions' with the live ones (FD-BOTEDIT). */
  private input: BotInput | null;
  /** FD-BOTEDIT §3: a transition under way (how its positions end), and what asks for it. */
  private switching: PositionsMode | null = null;
  private changes: string[] = [];
  private readonly events: { kind: BotEventKind; symbol: string | null; message: string; detail: BotEventDetail | null }[] = [];
  private readonly trades: ClosedTrade[] = [];
  private status: BotStatus;
  private reason: string | null;
  private commandSeen: string | null;
  private clearCommand = false;
  private exec: Executor | null = null;
  private tz = 'UTC';
  /** An order is waiting to be tried again, or the bot hit a problem: nothing more this look. */
  private halted = false;
  private portfolio: Portfolio | null | undefined = undefined;
  /** FIX-PAPERLEV: the account is a Paper Trading profile (every market there: leverage, margin, one position a symbol). */
  private paper = false;
  /** FIX-BOTSHORTS: what this look's entries took from the account (its portfolio is read once a look). */
  private spent = 0;

  constructor(e: BotEngine, row: BotRow, moods: Map<string, Promise<MarketMood>>) {
    this.e = e;
    this.row = row;
    this.moods = moods;
    this.now = e.now();
    this.st = parseState(row.state);
    this.config = parseInput(row);
    this.input = this.config;
    this.status = row.status;
    this.reason = row.status_reason;
    this.commandSeen = row.command;
  }

  private get d() {
    return this.e.deps;
  }

  /** FIX-DECIMALS: a bot on forex / commodities writes its rates with four decimals under 10 (EUR/USD 1,0845). */
  private get fx(): boolean {
    return this.config?.market === 'stock' && this.config.symbols.some((s) => fxKindOf(s) !== null);
  }

  /** FD-PUSH: what this look opened (its notes) and closed (its trades). */
  outcome(): { events: { kind: BotEventKind; symbol: string | null; message: string; detail: BotEventDetail | null }[]; trades: ClosedTrade[] } {
    return { events: this.events, trades: this.trades };
  }

  private note(kind: BotEventKind, message: string, symbol: string | null = null, detail: BotEventDetail | null = null): void {
    this.events.push({ kind, symbol, message: message.slice(0, 600), detail });
  }

  private setStatus(status: BotStatus, reason: string | null): void {
    this.status = status;
    this.reason = reason;
  }

  /** The bot cannot go on by itself (also while ending: a close whose fate is unknown is not sent again blindly). */
  private problem(message: string): void {
    this.halted = true;
    // Said once: the same problem found again at the next look is not news.
    if (this.status === 'problem' && this.reason === message) return;
    this.setStatus('problem', message);
    this.note('problem', message);
  }

  unexpected(err: Error): void {
    this.st.errors += 1;
    this.d.log.warn(`bot ${this.row.id}: ${err.message}`);
    this.note('problem', `Eroare neașteptată: ${err.message}`);
    if (this.st.errors >= ERRORS_MAX && this.status !== 'ending' && this.status !== 'ended') this.setStatus('problem', `Eroare neașteptată, de ${ERRORS_MAX} ori la rând: ${err.message}`);
  }

  async go(): Promise<void> {
    const config = this.config;
    if (!config) {
      this.setStatus('ended', 'Setările botului nu se mai pot citi.');
      return;
    }
    const settings = await this.d.settings.forUser(this.row.user_id);
    this.tz = settings.timezone;

    // The API's command: to end, or to forget an order after a problem (TD-BOT §1).
    const cmd = parseCommand(this.row.command);
    if (cmd) {
      this.clearCommand = true;
      if (cmd.clearPending) {
        this.st.pending = null;
        this.st.exitFailures = 0;
        this.st.errors = 0;
      }
      if (cmd.end && this.status === 'ending') {
        this.st.endAction = cmd.end;
        this.st.endReason = cmd.reason ?? 'Oprit de utilizator.';
      }
      if (cmd.positions) this.st.switchMode = cmd.positions;
    }
    // FD-BOTEDIT: the settings of the open positions against the bot's.
    this.settle(config);
    // FIX-BOTDRAG: the levels dragged on the chart, before any price is read (the DCA cycle's symbol: its settings').
    if (cmd?.levels?.length) applyLevels(this.st, cmd.levels, (this.input as BotInput).symbols[0] ?? '');

    // FD-PAPER §7: positions opened in a simulation before Paper Trading (a transition from it, never finished) are
    // not on any account: the bot no longer follows them and goes on with its settings.
    if (this.switching && (this.input as BotInput).exec !== 'real') {
      this.dropHeld();
      this.note('info', 'Pozițiile simulate cu setările vechi nu mai sunt urmărite: simularea se face acum doar cu un cont Paper Trading.');
      this.switchTo(config);
    }
    // The account of the bot (during a transition, the open positions' own).
    let access = await this.access(this.input as BotInput);
    if (access === null && this.switching) {
      // FD-BOTEDIT §5: the old account is gone; what the bot held there stays on the platform.
      this.dropHeld();
      this.note('info', 'Contul cu pozițiile făcute cu setările vechi a fost șters: pozițiile de acolo rămân pe platformă.');
      this.switchTo(config);
      access = await this.access(config);
    }
    const input = this.input as BotInput;
    if (access === null) {
      this.setStatus('ended', 'Contul a fost șters: pozițiile rămân pe platformă.');
      this.note('end', 'Contul a fost șters: botul s-a încheiat. Pozițiile lui rămân pe platformă.');
      return;
    }
    this.retf(input);
    this.paper = access.exchange === 'paper';
    this.exec = new RealExec({
      trading: this.d.trading,
      userId: this.row.user_id,
      accountId: input.accountId as number,
      market: input.market,
      etoro: TRADING[access.exchange as keyof typeof TRADING]?.etoro === true,
      paper: this.paper,
      refs: this.st.refs,
      refsWait: this.st.refsWait,
      feePct: input.fee,
      instruments: this.e.instruments,
      now: this.e.now,
    });

    // The period.
    if (this.status === 'scheduled') {
      if (this.now < this.row.starts_at) return;
      this.setStatus('running', null);
      this.note('start', 'Botul a pornit.');
    }
    if (this.row.ends_at !== null && this.now >= this.row.ends_at && (this.status === 'running' || this.status === 'paused' || this.status === 'problem')) {
      this.setStatus('ending', null);
      this.st.endAction = input.endAction;
      this.st.endReason = 'Perioada s-a terminat.';
      this.note('info', `Perioada s-a terminat: ${input.endAction === 'close' ? 'botul închide pozițiile' : input.endAction === 'finish' ? 'botul termină tranzacțiile deschise, fără altele noi' : 'pozițiile rămân deschise'}.`);
    }
    if (this.status === 'ending' && !this.st.endAction) this.st.endAction = input.endAction;
    if (this.status === 'ending' && this.st.endAction === 'leave') return this.end(this.st.endReason ?? 'Oprit.', this.hasPositions() ? 'Pozițiile rămân deschise.' : null);
    // Nothing open: nothing to close or to finish (also with the market closed or no price).
    if (this.status === 'ending' && !this.hasPositions() && !this.st.pending) return this.end(this.st.endReason ?? 'Oprit.', null);

    // The day (the user's), for the daily loss.
    const day = dayKey(this.now, this.tz);
    if (this.st.day !== day) {
      this.st.day = day;
      this.st.dayRealized = 0;
    }

    // FIX-ETOROPENDING: an eToro opening refused or cancelled goes also while the market is closed (no price needed).
    if (input.exec === 'real' && input.strategy === 'premium') await this.dropVoidOpenings();

    if (!(await this.readPrices(input))) return;

    // An order that did not go through last time goes first, with its key.
    if (this.st.pending) {
      await this.resend(this.st.pending as Pending);
      if (this.halted) return;
    }

    if (input.exec === 'real') await this.reconcile(input);
    if (this.halted) return;
    // A problem sends nothing until "Reia": an order whose fate is unknown may have gone through (FD-BOT §3).
    if (this.status === 'problem') return;

    this.limits(input);
    const ending = this.status === 'ending';
    // FD-BOTEDIT §3: a transition opens nothing; with "close" (a grid always) it closes. A stop decides by itself.
    const closing = ending ? this.st.endAction === 'close' : this.switching === 'close';
    const entries = this.status === 'running' && this.st.dayBlocked !== day && !this.switching;
    if (input.strategy === 'grid') await this.grid(input, input.grid, entries, closing || ending);
    else if (input.strategy === 'dca') await this.dca(input, input.dca, entries, closing);
    else await this.premium(input, input.premium, entries, closing);
    if (this.halted) return;

    // A loss limit reached on this look, or the closing finished; a transition with nothing left open is done.
    this.limits(input);
    if (this.status === 'ending' && !this.hasPositions()) this.end(this.st.endReason ?? 'Oprit.', null);
    else if (this.switching && this.status !== 'ending' && this.status !== 'ended' && !this.hasPositions() && !this.st.pending) this.switchTo(config);
  }

  /** The bot's account; null when it is gone (or not the user's). */
  private async access(input: BotInput): Promise<{ exchange: string } | null> {
    const access = input.exec === 'real' && input.accountId !== null ? await this.d.accounts.tradingAccess(input.accountId) : null;
    return access && access.userId === this.row.user_id ? access : null;
  }

  /**
   * FD-BOTEDIT: the settings the open positions run with (`state.basis`) against the bot's. The same: the bot's from now
   * on. Otherwise (`transitionOf`) a transition: with nothing open the new settings at once, else the positions finish or
   * close first, with their settings and the live ones of the new (`liveOf`). A state from before takes the bot's
   * settings, which could not change in the ways that need a transition until then.
   */
  private settle(config: BotInput): void {
    const st = this.st;
    let basis = basisOf(st);
    if (!basis) {
      basis = config;
      const deal = st.dca?.deal;
      if (deal && deal.lev === undefined) deal.lev = config.market === 'futures' ? config.leverage : 1;
    }
    const changes = transitionOf(basis, config);
    if (!changes.length) {
      st.basis = config;
      st.switchMode = null;
      this.input = config;
      return;
    }
    if (!this.hasPositions() && !st.pending) return this.switchTo(config, changes);
    st.basis = basis;
    this.input = liveOf(basis, config);
    this.changes = changes;
    this.switching = config.strategy === 'grid' ? 'close' : (st.switchMode ?? 'finish');
  }

  /**
   * FD-BOTEDIT §3: the new settings from now on, the strategy as at a start (a new grid, the DCA cycles from 1); the
   * totals, the trades and the journal stay. The marks of the old place go (the refused entries, the eToro ids).
   */
  private switchTo(config: BotInput, changes = this.changes): void {
    const st = this.st;
    st.basis = config;
    st.switchMode = null;
    st.entryPause = {};
    st.lastOrderAt = {};
    st.refs = {};
    st.refsWait = {};
    st.noted = {};
    if (config.strategy === 'grid') {
      st.grid = null;
      st.refPrice = null;
    }
    if (config.strategy === 'dca') st.dca = null;
    this.input = config;
    this.switching = null;
    this.changes = [];
    this.note('info', `Setările noi se aplică de acum (${changes.join('; ')}).`);
  }

  /** The reason of a closing trade: the loss limit, the period's end, a stop, or (FD-BOTEDIT) the new settings. */
  private closeReason(): BotTradeReason {
    if (this.status !== 'ending' && this.switching) return 'edit';
    return this.st.endReason?.startsWith('Pierderea') ? 'loss_limit' : this.row.ends_at !== null && this.now >= this.row.ends_at ? 'end' : 'stop';
  }

  /** What a closing says in the journal. */
  private closeWhy(): string {
    return this.status !== 'ending' && this.switching ? `Setările noi (${this.changes.join('; ')}) cer închiderea pozițiilor deschise cu cele vechi.` : (this.st.endReason ?? 'Oprit.');
  }

  /** The symbols the bot looks at: its settings', and (Premium, FD-BOTEDIT §2) those of its open positions and of an order on its way. */
  private tracked(input: BotInput): string[] {
    const out = new Set(input.symbols);
    for (const p of this.st.premium?.positions ?? []) out.add(p.symbol);
    if (this.st.pending) out.add(this.st.pending.symbol);
    return [...out];
  }

  /**
   * FD-BOTTF: the signals' timeframe changed since the last look. As at the start, only the bars that close from now on;
   * the open positions keep their SL / TP, and the signal they entered on (on the old timeframe) is no longer followed.
   */
  private retf(input: BotInput): void {
    const ps = this.st.premium;
    if (input.strategy !== 'premium' || !ps || ps.tf === input.tf) return;
    const was = ps.tf;
    ps.tf = input.tf;
    // A state from before FD-BOTTF: its bars are the bot's own.
    if (was === undefined) return;
    ps.lastBar = {};
    ps.nextRead = {};
    for (const sym of input.symbols) {
      const key = this.st.noted[sym];
      if (key === 'history' || key?.startsWith('read:')) delete this.st.noted[sym];
    }
    let followed = false;
    // FIX-BOTSHORTS: a setup is followed on its timeframe, as a signal.
    delete ps.aiNo;
    delete ps.setupTaken;
    for (const pos of ps.positions) {
      if (pos.signalTime === undefined && !pos.setup) continue;
      delete pos.signalTime;
      delete pos.setup;
      followed = true;
    }
    const pending = this.st.pending as Pending | null;
    if (pending?.purpose.kind === 'p_open' && (pending.purpose.signalTime !== undefined || pending.purpose.setup)) {
      delete pending.purpose.signalTime;
      delete pending.purpose.setup;
      followed = true;
    }
    this.note(
      'info',
      `Timeframe-ul semnalelor e acum ${input.tf} (era ${was}): botul ia semnalele de pe lumânările de ${input.tf} care se închid de acum.${followed ? ` Pozițiile deschise își păstrează SL / TP-ul; semnalul de ${was} pe care au intrat nu se mai urmărește.` : ''}`,
    );
  }

  private end(reason: string, more: string | null): void {
    this.setStatus('ended', reason);
    this.note('end', `Botul s-a încheiat. ${reason}${more ? ` ${more}` : ''}`);
  }

  // ---------------- prices ----------------

  /** The price of each symbol now; false when the bot can do nothing this look. */
  private async readPrices(input: BotInput): Promise<boolean> {
    let missing = false;
    let closedMarket = false;
    const symbols = this.tracked(input);
    for (const sym of symbols) {
      try {
        const p = await this.price(input, sym);
        if (p === 'closed') {
          closedMarket = true;
          continue;
        }
        this.st.prices[sym] = { p, at: this.now };
      } catch (err) {
        missing = true;
        this.d.log.warn(`bot ${this.row.id} price ${sym}: ${(err as Error).message}`);
      }
    }
    if (!missing) {
      this.st.noPriceSince = null;
      // The prices are back: a problem that was only theirs is over by itself.
      if (this.status === 'problem' && this.reason === NO_PRICE) {
        this.setStatus('running', null);
        this.note('info', 'Prețul se citește din nou: botul merge mai departe.');
      }
      return !closedMarket || symbols.some((s) => this.fresh(s) !== null);
    }
    this.st.noPriceSince ??= this.now;
    if (this.now - this.st.noPriceSince >= NO_PRICE_MS && this.status !== 'problem' && this.status !== 'ending') {
      this.setStatus('problem', NO_PRICE);
      this.note('problem', 'Prețul nu se poate citi de 10 minute: botul nu face nimic până revine.');
    }
    return symbols.some((s) => this.fresh(s) !== null);
  }

  private async price(input: BotInput, sym: string): Promise<number | 'closed'> {
    // FIX-BOT24 (the user: „botul rulează 24 din 24”; eToro trades 24/5, and a share may be of any exchange): a real bot
    // on eToro runs at every hour, at eToro's own price of the instrument; eToro decides whether an order executes (one
    // left pending is followed, FIX-ETOROPENDING). Without eToro's price: the last one known (Nasdaq), at any hour.
    if (input.market === 'stock' && this.exec instanceof RealExec && this.exec.etoro) {
      const p = await this.exec.platformPrice(sym).catch((err: unknown) => {
        this.d.log.warn(`bot ${this.row.id} eToro price ${sym}: ${(err as Error).message}`);
        return null;
      });
      if (p !== null && p > 0) return p;
      return readPrice(this.d, this.row.user_id, input.market, sym, false, BOT_STOCK_PRICE_MS, 'bot');
    }
    // FIX-BOTPRICE: a share's price at most 25 s old (Nasdaq, free), so a stop loss or take profit is seen within a look.
    return readPrice(this.d, this.row.user_id, input.market, sym, true, BOT_STOCK_PRICE_MS, 'bot');
  }

  /** This look's price of a symbol (null: none now). */
  private fresh(sym: string): number | null {
    const v = this.st.prices[sym];
    return v && v.at === this.now ? v.p : null;
  }

  // ---------------- orders ----------------

  /** Sends an order for a purpose and applies it; false when it did not go through. */
  private async send(o: BotOrder, purpose: Purpose): Promise<boolean> {
    if (this.halted || !this.exec) return false;
    if (!(o.qty > 0)) return false;
    const key = this.e.uuid();
    // Real: the key is saved, with the quantity that leaves, before the order leaves (a restart sends it again with it).
    const ready =
      this.input?.exec === 'real'
        ? async (qty: number) => {
            const pending: Pending = { key, symbol: o.symbol, side: o.side, qty, reduce: o.reduce, at: this.now, purpose, lev: o.lev, price: o.price, sl: o.sl ?? null, tp: o.tp ?? null, ...(o.mm ? { mm: o.mm } : {}) };
            this.st.pending = pending;
            await this.saveState();
          }
        : undefined;
    return this.finish(await this.exec.order(o, key, ready), purpose, o);
  }

  private async resend(p: Pending): Promise<void> {
    if (!this.exec) return;
    const price = this.fresh(p.symbol) ?? p.price;
    const o: BotOrder = { symbol: p.symbol, side: p.side, qty: p.qty, reduce: p.reduce, lev: p.lev, price, sl: p.sl ?? null, tp: p.tp ?? null, at: p.at, ...(p.mm ? { mm: p.mm } : {}) };
    this.noteOnce(p.symbol, `resend:${p.key}`, 'order', `Ordinul de la ${new Date(p.at).toISOString().slice(11, 16)} UTC se trimite din nou, cu aceeași cheie.`);
    await this.finish(await this.exec.order(o, p.key, undefined, true), p.purpose, o);
  }

  private async finish(r: Awaited<ReturnType<Executor['order']>>, purpose: Purpose, o: BotOrder): Promise<boolean> {
    if (r.ok) {
      this.st.pending = null;
      this.st.lastOrderAt[o.symbol] = this.now;
      if (o.reduce) this.st.exitFailures = 0;
      this.apply(purpose, r.fill);
      return true;
    }
    const exit = purpose.kind === 'p_close' || purpose.kind === 'g_close' || purpose.kind === 'd_close';
    switch (r.kind) {
      case 'retry':
        this.noteOnce(o.symbol, `retry:${r.message}`, 'order', `Ordinul n-a plecat acum (${r.message}): se încearcă din nou la fiecare verificare, cu aceeași cheie.`);
        this.halted = true;
        return false;
      case 'refused':
        this.st.pending = null;
        if (exit) {
          this.st.exitFailures += 1;
          this.note('order', `Ieșirea a fost refuzată: ${r.message}`, o.symbol);
          if (this.st.exitFailures >= EXIT_FAILURES_MAX) this.problem(`Ieșirea a fost refuzată de ${EXIT_FAILURES_MAX} ori la rând: ${r.message}`);
        } else {
          // No new entry on the symbol for a while (the same refusal every 30 s says nothing new), said once.
          this.st.entryPause[o.symbol] = this.now + ENTRY_PAUSE_MS;
          this.noteOnce(o.symbol, `refused:${r.message}`, 'skip', `Intrarea a fost refuzată: ${r.message} Botul mai încearcă peste ${ENTRY_PAUSE_MS / MIN} minute.`);
        }
        return false;
      case 'gone':
        this.st.pending = null;
        this.end('Contul a fost șters: pozițiile rămân pe platformă.', null);
        this.halted = true;
        return false;
      default:
        this.st.pending = null;
        this.problem(`${r.message} Verifică pozițiile în Tranzacții, apoi apasă „Reia”.`);
        return false;
    }
  }

  private apply(purpose: Purpose, fill: Fill): void {
    const st = this.st;
    switch (purpose.kind) {
      case 'p_open': {
        const ps = this.premiumState();
        const pos: BotPosition = {
          symbol: purpose.symbol,
          side: purpose.side,
          qty: fill.qty,
          entry: fill.price,
          margin: (fill.qty * fill.price) / purpose.lev,
          lev: purpose.lev,
          fees: fill.fee,
          openedAt: this.now,
          sl: purpose.sl,
          tp: purpose.tp,
          signalTime: purpose.signalTime,
          ...(purpose.mm ? { mm: purpose.mm } : {}),
          ...(purpose.setup ? { setup: purpose.setup } : {}),
        };
        ps.positions.push(pos);
        if (purpose.setup) ((ps.setupTaken ??= {})[purpose.symbol] ??= {})[purpose.side] = purpose.setup.start;
        st.fees += fill.fee;
        return;
      }
      case 'p_close': {
        const ps = this.premiumState();
        const i = ps.positions.findIndex((p) => p.symbol === purpose.symbol && p.side === purpose.side);
        if (i < 0) return;
        const pos = ps.positions[i] as BotPosition;
        ps.positions.splice(i, 1);
        const pnl = this.closeTrade(pos.symbol, pos.side, pos.qty, pos.entry, fill.price, pos.fees, fill.fee, pos.openedAt, purpose.reason, { lev: pos.lev, sl: pos.sl, tp: pos.tp });
        ps.recent = [...(ps.recent ?? []), pos.margin > 0 ? (pnl / pos.margin) * 100 : 0].slice(-5);
        if (pnl < 0 && this.input?.strategy === 'premium' && this.input.premium.cooldownMin > 0) ps.cooldownUntil = this.now + this.input.premium.cooldownMin * MIN;
        return;
      }
      case 'g_moves': {
        const g = st.grid;
        if (!g) return;
        for (const m of purpose.moves) {
          const s = g.slots[m.i];
          if (!s) continue;
          const fee = (g.qty * fill.price * (this.input?.fee ?? 0)) / 100;
          if (m.open) {
            s.entry = fill.price;
            s.openedAt = this.now;
            s.fees = fee;
            st.fees += fee;
          } else if (s.entry !== null) {
            this.closeTrade(this.input?.symbols[0] ?? '', s.side, g.qty, s.entry, fill.price, s.fees, fee, s.openedAt ?? this.now, 'grid', this.gridLevels(g, m.i, s.side));
            s.entry = null;
            s.openedAt = null;
            s.fees = 0;
          }
        }
        if (purpose.start) g.started = true;
        return;
      }
      case 'g_close': {
        const g = st.grid;
        if (!g) return;
        for (const [i, s] of g.slots.entries()) {
          if (s.entry === null || (purpose.side && s.side !== purpose.side)) continue;
          const fee = (g.qty * fill.price * (this.input?.fee ?? 0)) / 100;
          this.closeTrade(this.input?.symbols[0] ?? '', s.side, g.qty, s.entry, fill.price, s.fees, fee, s.openedAt ?? this.now, purpose.reason, this.gridLevels(g, i, s.side));
          s.entry = null;
          s.openedAt = null;
          s.fees = 0;
        }
        return;
      }
      case 'd_open': {
        const ds = (st.dca ??= newDca());
        const side = this.input?.strategy === 'dca' ? this.input.dca.direction : 'long';
        ds.cycle += 1;
        ds.deal = { side, basePrice: fill.price, filled: 0, qty: fill.qty, cost: fill.qty * fill.price, margin: purpose.margin, fees: fill.fee, openedAt: this.now, lev: purpose.lev, ...(purpose.mm ? { mm: purpose.mm } : {}) };
        st.fees += fill.fee;
        return;
      }
      case 'd_add': {
        const deal = st.dca?.deal;
        if (!deal) return;
        deal.filled = Math.max(deal.filled, ...purpose.ks);
        deal.qty += fill.qty;
        deal.cost += fill.qty * fill.price;
        deal.margin += purpose.margin;
        deal.fees += fill.fee;
        st.fees += fill.fee;
        return;
      }
      case 'd_close': {
        const ds = st.dca;
        const deal = ds?.deal;
        if (!ds || !deal || this.input?.strategy !== 'dca') return;
        this.closeTrade(this.input.symbols[0] as string, deal.side, deal.qty, deal.cost / deal.qty, fill.price, deal.fees, fill.fee, deal.openedAt, purpose.reason, this.dcaLevels(deal));
        st.dca = afterClose(this.input.dca, ds, purpose.reason === 'tp' ? 'tp' : purpose.reason === 'sl' ? 'sl' : 'other', this.now);
        return;
      }
    }
  }

  /**
   * Books a closed trade; its profit. FD-TRADES: with the market and the account of the settings its position ran with
   * (`input`: in a transition, those of the positions), and its leverage and levels.
   */
  private closeTrade(symbol: string, side: BotSide, qty: number, entry: number, exit: number, entryFees: number, exitFee: number, openedAt: number, reason: BotTradeReason, levels: Levels): number {
    const pnl = closePnl(side, entry, exit, qty, entryFees, exitFee);
    this.st.realized += pnl;
    this.st.dayRealized += pnl;
    this.st.fees += exitFee;
    this.st.trades += 1;
    if (pnl > 0) this.st.wins += 1;
    const input = this.input;
    const market = input?.market ?? this.row.market;
    const accountId = input ? (input.exec === 'real' ? input.accountId : null) : this.row.execution === 'real' ? this.row.account_id : null;
    this.trades.push({ symbol, side, qty, entry, exit, pnl, fees: entryFees + exitFee, openedAt, closedAt: this.now, reason, market, accountId, ...levels });
    return pnl;
  }

  /** FD-TRADES: a grid interval's levels: the line it closes at (the high one on a long), the stop on its side. */
  private gridLevels(g: GridState, i: number, side: BotSide): Levels {
    const cfg = this.input?.strategy === 'grid' ? this.input.grid : null;
    return { lev: g.lev, tp: (side === 'long' ? g.lines[i + 1] : g.lines[i]) ?? null, sl: cfg ? (side === 'long' ? cfg.stopBelow : cfg.stopAbove) : null };
  }

  /** FD-TRADES: a DCA cycle's leverage and levels now (its TP follows the average price). */
  private dcaLevels(deal: DcaDeal): Levels {
    const input = this.input;
    if (input?.strategy !== 'dca') return { lev: deal.lev ?? 1, sl: null, tp: null };
    const lv = dealLevels(input.dca, deal);
    return { lev: deal.lev ?? input.leverage, sl: lv.sl, tp: lv.tp };
  }

  private premiumState(): PremiumState {
    return (this.st.premium ??= { ...(this.input ? { tf: this.input.tf } : {}), lastBar: {}, nextRead: {}, positions: [], cooldownUntil: 0, ai: { day: '', n: 0 }, recent: [] });
  }

  // ---------------- positions, limits ----------------

  private hasPositions(): boolean {
    return holdsPositions(this.st);
  }

  /** FIX-PAPERLEV: leverage and margin apply (futures; on a Paper Trading profile, every market). */
  private margined(input: BotInput): boolean {
    return input.market === 'futures' || this.paper;
  }

  /** FIX-ETOROLEV: the leverage applies (where margin does, and at eToro: every position there opens with one). */
  private leveraged(input: BotInput): boolean {
    return this.margined(input) || this.separateGrids();
  }

  /** The margin mode an opening goes with (FIX-BOTMARGIN), where there is one to choose. */
  private marginOf(input: BotInput): BotMarginMode | undefined {
    return this.margined(input) ? input.marginMode : undefined;
  }

  /** One position a symbol, the two sides netted (one-way futures; FIX-PAPERLEV: a Paper Trading profile's every market). */
  private oneWay(input: BotInput): boolean {
    return input.market === 'futures' || this.paper;
  }

  /** Forgets what the bot holds (positions no longer on its account, or never on one). */
  private dropHeld(): void {
    this.st.grid = null;
    if (this.st.dca) this.st.dca.deal = null;
    if (this.st.premium) this.st.premium.positions = [];
    this.st.pending = null;
  }

  /** What the open positions would make now (null when a price is missing). */
  private unrealized(): number | null {
    const st = this.st;
    let sum = 0;
    for (const p of st.premium?.positions ?? []) {
      const price = this.fresh(p.symbol) ?? st.prices[p.symbol]?.p;
      if (price === undefined) return null;
      sum += openPnl(p.side, p.entry, price, p.qty);
    }
    const sym = this.input?.symbols[0] ?? '';
    const price = this.fresh(sym) ?? st.prices[sym]?.p;
    const deal = st.dca?.deal;
    if (deal) {
      if (price === undefined) return null;
      sum += (deal.side === 'long' ? 1 : -1) * (price * deal.qty - deal.cost);
    }
    for (const s of st.grid?.slots ?? []) {
      if (s.entry === null) continue;
      if (price === undefined) return null;
      sum += openPnl(s.side, s.entry, price, st.grid?.qty ?? 0);
    }
    return sum;
  }

  /** The daily loss (no entries until tomorrow) and the loss that stops the bot (FD-BOT §3). */
  private limits(input: BotInput): void {
    if (this.status === 'ended') return;
    const open = this.unrealized() ?? 0;
    if (input.dailyLoss !== null && this.st.dayBlocked !== this.st.day && this.st.dayRealized + open <= -input.dailyLoss) {
      this.st.dayBlocked = this.st.day;
      this.note('info', 'Pierderea maximă pe zi a fost atinsă: nicio intrare nouă până mâine. Ieșirile continuă.');
    }
    if (input.lossStop !== null && this.status !== 'ending' && this.status !== 'problem' && this.st.realized + open <= -input.lossStop) {
      this.setStatus('ending', null);
      this.st.endAction = 'close';
      this.st.endReason = 'Pierderea la care se oprește a fost atinsă.';
      this.note('info', 'Pierderea la care se oprește a fost atinsă: botul închide tot și se încheie.');
    }
  }

  // ---------------- the account (real) ----------------

  private async account(): Promise<Portfolio | null> {
    if (this.portfolio !== undefined) return this.portfolio;
    try {
      const id = this.input?.accountId ?? null;
      this.portfolio = id !== null ? await this.d.accounts.portfolio(id) : null;
    } catch (err) {
      this.d.log.warn(`bot ${this.row.id} portfolio: ${(err as Error).message}`);
      this.portfolio = null;
    }
    return this.portfolio;
  }

  /**
   * What the account holds of a symbol, each side apart (a hedge account, eToro's positions): the futures positions; on
   * spot the asset's total; for shares the holding plus eToro's positions (a short, a leveraged long). Null when unknown.
   */
  private async holdings(input: BotInput, sym: string): Promise<{ long: number; short: number } | null> {
    const pf = await this.account();
    if (!pf) return null;
    const sides = (rows: Portfolio['positions']) => ({
      long: rows.filter((p) => p.side !== 'short').reduce((a, p) => a + Math.abs(p.size ?? p.contracts), 0),
      short: rows.filter((p) => p.side === 'short').reduce((a, p) => a + Math.abs(p.size ?? p.contracts), 0),
    });
    // FIX-PAPERLEV: a Paper Trading profile's spot is positions too (no coins held apart).
    if (input.market === 'futures' || (this.paper && input.market === 'spot')) {
      if (pf.errors.positions || pf.stale.positions) return null;
      return sides(pf.positions.filter((p) => p.symbol === (input.market === 'futures' ? perpetualOf(sym) : sym)));
    }
    if (pf.errors.balances || pf.stale.balances) return null;
    // FD-FXCOMMODITIES: an account keeps a pair or a commodity in its compact form (EUR/USD → EURUSD, as eToro).
    const asset = input.market === 'stock' ? fxCompact(sym) : sym.split('/')[0];
    const held = pf.balances.filter((b) => b.asset === asset).reduce((a, b) => a + b.total, 0);
    if (input.market === 'spot') return { long: held, short: 0 };
    if (pf.errors.positions || pf.stale.positions) return null;
    const open = sides(pf.positions.filter((p) => p.symbol === `${asset}/USD`));
    return { long: held + open.long, short: open.short };
  }

  /**
   * How much of a side the bot still holds on the account: at eToro its own positions by id (the user's on the same
   * share do not count, FD-BOT §10), elsewhere the account's holding of that side. Null when unknown.
   */
  private async mine(input: BotInput, sym: string, side: BotSide): Promise<number | null> {
    if (this.exec instanceof RealExec && this.exec.etoro) {
      try {
        return await this.exec.ownUnits(sym, side);
      } catch (err) {
        this.d.log.warn(`bot ${this.row.id} eToro positions ${sym}: ${(err as Error).message}`);
        return null;
      }
    }
    const h = await this.holdings(input, sym);
    return h === null ? null : h[side];
  }

  /**
   * FIX-ETOROPENDING: an opening eToro refused or cancelled never opened: the position the bot noted for it goes, without
   * a result (no trade, no profit or loss). Asked at eToro, so also while the market is closed.
   */
  private async dropVoidOpenings(): Promise<void> {
    const ps = this.st.premium;
    if (!(this.exec instanceof RealExec && this.exec.etoro && ps)) return;
    for (const sym of new Set(ps.positions.map((p) => p.symbol))) {
      const o = await this.exec.opening(sym).catch((err: unknown) => {
        this.d.log.warn(`bot ${this.row.id} eToro opening ${sym}: ${(err as Error).message}`);
        return null;
      });
      if (o?.state !== 'void') continue;
      const last = ps.positions.filter((p) => p.symbol === sym && p.side === o.side).reduce<(typeof ps.positions)[number] | null>((a, p) => (!a || p.openedAt > a.openedAt ? p : a), null);
      if (!last) continue;
      ps.positions.splice(ps.positions.indexOf(last), 1);
      this.note('order', `eToro nu a deschis poziția ${o.side}${o.message ? ` (${o.message.replace(/\.$/, '')})` : ''}: botul a scos-o, fără profit sau pierdere.`, sym);
    }
  }

  /** A position of the bot that is no longer on the account was closed outside it (FD-BOT §8). */
  private async reconcile(input: BotInput): Promise<void> {
    const recent = (sym: string) => this.now - (this.st.lastOrderAt[sym] ?? 0) < RECONCILE_GRACE_MS;
    if (input.strategy === 'premium') {
      const ps = this.st.premium;
      for (const pos of [...(ps?.positions ?? [])]) {
        if (recent(pos.symbol)) continue;
        const mine = await this.mine(input, pos.symbol, pos.side);
        if (mine === null || mine >= pos.qty * RECONCILE_TOLERANCE) continue;
        this.external(pos.symbol, pos.side, pos.qty, mine, pos.entry, pos.fees, pos.openedAt, { lev: pos.lev, sl: pos.sl, tp: pos.tp }, () => {
          if (mine <= 0) ps!.positions.splice(ps!.positions.indexOf(pos), 1);
          else {
            pos.fees *= mine / pos.qty;
            pos.margin *= mine / pos.qty;
            pos.qty = mine;
          }
        });
      }
      return;
    }
    const sym = input.symbols[0] as string;
    if (recent(sym)) return;
    if (input.strategy === 'dca') {
      const ds = this.st.dca;
      const deal = ds?.deal;
      if (!ds || !deal) return;
      const mine = await this.mine(input, sym, deal.side);
      if (mine === null || mine >= deal.qty * RECONCILE_TOLERANCE) return;
      this.external(sym, deal.side, deal.qty, mine, deal.cost / deal.qty, deal.fees, deal.openedAt, this.dcaLevels(deal), () => {
        if (mine <= 0) this.st.dca = afterClose(input.dca, ds, 'other', this.now);
        else {
          deal.cost *= mine / deal.qty;
          deal.fees *= mine / deal.qty;
          deal.margin *= mine / deal.qty;
          deal.qty = mine;
        }
      });
      return;
    }
    const g = this.st.grid;
    if (!g?.started) return;
    const want = { long: 0, short: 0 };
    for (const s of g.slots) if (s.entry !== null) want[s.side] += g.qty;
    if (want.long === 0 && want.short === 0) return;
    const longHeld = want.long > 0 ? await this.mine(input, sym, 'long') : 0;
    const shortHeld = want.short > 0 ? await this.mine(input, sym, 'short') : 0;
    if (longHeld === null || shortHeld === null) return;
    const h = { long: longHeld, short: shortHeld };
    // One-way futures net the two sides: there only the side the grid holds is compared.
    const ok = this.oneWay(input) ? (want.long >= want.short ? h.long >= (want.long - want.short) * RECONCILE_TOLERANCE : h.short >= (want.short - want.long) * RECONCILE_TOLERANCE) : h.long >= want.long * RECONCILE_TOLERANCE && h.short >= want.short * RECONCILE_TOLERANCE;
    if (!ok) this.problem('Poziția grilei s-a schimbat în afara botului (închisă de mână, lichidată). Verifică în Tranzacții, apoi oprește sau reia botul.');
  }

  /** Books the part closed outside the bot at the price now. */
  private external(sym: string, side: BotSide, qty: number, left: number, entry: number, fees: number, openedAt: number, levels: Levels, update: () => void): void {
    const price = this.fresh(sym) ?? this.st.prices[sym]?.p ?? entry;
    const gone = qty - Math.max(0, left);
    this.closeTrade(sym, side, gone, entry, price, fees * (gone / qty), 0, openedAt, 'external', levels);
    update();
    this.note('exit', `${left > 0 ? 'O parte din poziție' : 'Poziția'} ${side} nu mai e în cont (închisă din afara botului: de mână, de platformă sau lichidată). Socotită închisă la ${fmtP(price, this.fx)}.`, sym);
  }

  /** A futures position on a symbol where the bot holds nothing (one-way: the bot would mix with it). */
  private async foreign(input: BotInput, sym: string): Promise<boolean> {
    if (input.exec !== 'real' || !this.oneWay(input)) return false;
    // The account read earlier in this look still shows a position the bot has closed since (an exit on a signal the
    // other way, then that side's entry): read again, with what the orders sent so far changed in it.
    if (this.st.lastOrderAt[sym] === this.now) {
      this.portfolio = undefined;
      this.spent = 0;
    }
    const h = await this.holdings(input, sym);
    return h !== null && h.long + h.short > 1e-12;
  }

  // ---------------- Grid ----------------

  private async grid(input: BotInput & { strategy: 'grid' }, cfg: GridConfig, open: boolean, ending: boolean): Promise<void> {
    const sym = input.symbols[0] as string;
    const entries = open && !this.entryPaused(sym);
    const p = this.fresh(sym);
    if (p === null) return;
    // FIX-BOTMARGIN: every order of a grid goes with its margin (a grid from before it: none, the pair's).
    const order = (units: number): BotOrder => ({ symbol: sym, side: units > 0 ? 'buy' : 'sell', qty: Math.abs(units) * (this.st.grid?.qty ?? 0), reduce: false, lev: this.st.grid?.lev ?? input.leverage, price: p, ...(this.st.grid?.mm ? { mm: this.st.grid.mm } : {}) });
    if (!this.st.grid) this.st.grid = await this.stepped(initGrid(cfg, input.maxAmount, input.leverage, p, this.st.refPrice, this.marginOf(input)), sym);
    let g = this.st.grid;
    if (!(g.qty > 0)) return this.problem('Cantitatea pe interval e sub pasul platformei: grila nu poate porni. Fă una nouă cu mai puține grile sau o sumă mai mare („Duplică”).');

    const closeAll = async (reason: BotTradeReason): Promise<boolean> => {
      if (this.separateGrids()) {
        // eToro: each side's positions closed by their own order.
        let ok = true;
        for (const side of ['long', 'short'] as const) {
          const n = g.slots.filter((s) => s.side === side && s.entry !== null).length;
          if (n > 0) ok = (await this.send({ ...order(side === 'long' ? -n : n), reduce: true }, { kind: 'g_close', reason, side })) && ok;
        }
        return ok;
      }
      const units = closeAllUnits(g);
      if (units === 0) return true;
      return this.send({ ...order(units), reduce: true }, { kind: 'g_close', reason });
    };

    if (ending) {
      // A grid has no trades to finish: ending closes it, unless its positions are left open.
      if (this.st.endAction !== 'leave') await closeAll(this.closeReason());
      return;
    }
    const stopped = gridStopped(cfg, p);
    if (stopped && g.started) {
      if (await closeAll('grid_stop')) {
        this.setStatus('ending', null);
        this.st.endAction = 'close';
        this.st.endReason = stopped === 'below' ? `Prețul a coborât la „Oprește sub” (${fmtP(cfg.stopBelow as number, this.fx)}).` : `Prețul a urcat la „Oprește peste” (${fmtP(cfg.stopAbove as number, this.fx)}).`;
        this.note('exit', this.st.endReason, sym);
      }
      return;
    }
    if (g.waiting) {
      if (!triggered(g, p)) return;
      this.st.grid = g = await this.stepped(initGrid({ ...cfg, trigger: null }, input.maxAmount, input.leverage, p, p, this.marginOf(input)), sym);
      this.note('info', `Prețul de pornire (${fmtP(cfg.trigger as number, this.fx)}) a fost atins.`, sym);
    }
    if (!g.started) {
      if (!entries) return;
      if (await this.foreign(input, sym)) return this.noteOnce(sym, 'foreign', 'skip', `Există deja o poziție pe ${perpetualOf(sym)} care nu e a botului: grila nu pornește.`);
      const moves = startMoves(cfg.direction, g, p);
      if (!moves.length) {
        g.started = true;
        this.note('info', `Grila a pornit la ${fmtP(p, this.fx)}: ${g.slots.length} intervale, ${fmtQ(g.qty)} pe interval, nimic de cumpărat la pornire.`, sym);
        return;
      }
      if (await this.moveGrid(input, cfg, g, moves, p, true)) this.note('enter', `Grila a pornit la ${fmtP(p, this.fx)}: ${moves.length} ${moves.length === 1 ? 'interval umplut' : 'intervale umplute'} la piață, ${fmtQ(g.qty)} pe interval.`, sym, { price: p, qty: g.qty * moves.length });
      return;
    }
    // In a pause, only the grids that empty move (FD-BOT §3).
    const moves = gridMoves(g, p).filter((m) => entries || !m.open);
    if (!moves.length) return;
    const units = netUnits(g, moves);
    const closes = moves.filter((m) => !m.open).length;
    const opens = moves.length - closes;
    const ok = units === 0 && !this.separateGrids() ? (this.apply({ kind: 'g_moves', moves, start: false }, { qty: 0, price: p, fee: 0 }), true) : await this.moveGrid(input, cfg, g, moves, p, false);
    if (ok) this.note(closes ? 'exit' : 'enter', `Grila la ${fmtP(p, this.fx)}: ${[opens ? `${opens} ${opens === 1 ? 'interval umplut' : 'intervale umplute'}` : '', closes ? `${closes} ${closes === 1 ? 'interval golit' : 'intervale golite'}` : ''].filter(Boolean).join(', ')}.`, sym, { price: p });
  }

  /** eToro keeps every position apart: a grid's moves go as separate orders (opens, closes, each side), never netted. */
  private separateGrids(): boolean {
    return this.exec instanceof RealExec && this.exec.etoro;
  }

  /**
   * The grids the price reached: one net order (a short's stop loss with it), or at eToro one order per side and kind
   * (FD-BOT §10). The purpose of each order is its own grids.
   */
  private async moveGrid(input: BotInput & { strategy: 'grid' }, cfg: GridConfig, g: GridState, moves: GridMove[], p: number, start: boolean): Promise<boolean> {
    const sym = input.symbols[0] as string;
    const groups = this.separateGrids()
      ? (['long', 'short'] as const).flatMap((side) => [true, false].map((open) => moves.filter((m) => g.slots[m.i]?.side === side && m.open === open))).filter((x) => x.length > 0)
      : [moves];
    let all = true;
    for (const group of groups) {
      if (this.halted) return false;
      const units = netUnits(g, group);
      const long = g.slots[group[0]?.i ?? 0]?.side === 'long';
      // At eToro a group is all opens or all closes of one side; netted elsewhere, a mixed order is no close.
      const reduce = this.separateGrids() && !group[0]?.open;
      const opensShort = !long && Boolean(group[0]?.open);
      // FIX-ETOROLEV: a leveraged long's opening carries its stop loss too (eToro asks for one over 1×).
      const opensLong = long && Boolean(group[0]?.open);
      const sl = opensShort ? cfg.stopAbove : opensLong && g.lev > 1 ? cfg.stopBelow : null;
      const ok = await this.send({ symbol: sym, side: units > 0 ? 'buy' : 'sell', qty: Math.abs(units) * g.qty, reduce, lev: g.lev, price: p, sl, ...(g.mm ? { mm: g.mm } : {}) }, { kind: 'g_moves', moves: group, start });
      all &&= ok;
    }
    return all;
  }

  /**
   * Real: a grid's unit in whole steps of the platform (KuCoin's BTC perpetual: 0.001), or the account would hold less
   * than the bot thinks and every check of it would find the difference.
   */
  private async stepped(g: GridState, sym: string): Promise<GridState> {
    if (this.exec instanceof RealExec) g.qty = floorToStep(g.qty, await this.exec.step(sym));
    return g;
  }

  // ---------------- DCA ----------------

  private async dca(input: BotInput & { strategy: 'dca' }, cfg: DcaConfig, open: boolean, closing: boolean): Promise<void> {
    const sym = input.symbols[0] as string;
    const entries = open && !this.entryPaused(sym);
    const p = this.fresh(sym);
    if (p === null) return;
    const ds = (this.st.dca ??= newDca());
    // FD-BOTEDIT §2: an open cycle keeps its side and its leverage; a new one takes the settings'. FIX-BOTMARGIN: its margin
    // too (a cycle from before it: none, the pair's).
    const lev = ds.deal?.lev ?? (this.leveraged(input) ? input.leverage : 1);
    const mm = ds.deal ? ds.deal.mm : this.marginOf(input);
    const withMm = mm ? { mm } : {};
    const side = ds.deal?.side ?? cfg.direction;
    const buy = side === 'long' ? 'buy' : 'sell';
    const sell = side === 'long' ? 'sell' : 'buy';
    if (closing) {
      if (ds.deal) await this.send({ symbol: sym, side: sell, qty: ds.deal.qty, reduce: true, lev, price: p, ...withMm }, { kind: 'd_close', reason: this.closeReason() });
      return;
    }
    // No cycle open and none to follow (the repeat off, the limit reached): the bot is done (not during a transition,
    // which starts the cycles again).
    if (!ds.deal && !this.switching && dcaOver(cfg, ds)) {
      this.setStatus('ending', null);
      this.st.endAction = 'close';
      this.st.endReason = 'Ciclurile s-au terminat.';
      return;
    }
    const action = dcaStep(cfg, ds, p, this.now, entries);
    if (!action) return;
    if (action.kind === 'open') {
      if (await this.foreign(input, sym)) return this.noteOnce(sym, 'foreign', 'skip', `Există deja o poziție pe ${perpetualOf(sym)} care nu e a botului: ciclul nu pornește.`);
      // A short's stop loss goes with it (eToro asks for one; FIX-ETOROLEV: and for a leverage over 1×): the cycle's, from
      // this base price.
      const sl = cfg.stopLoss === null ? null : cfg.direction === 'short' ? p * (1 + cfg.stopLoss / 100) : lev > 1 ? p * (1 - cfg.stopLoss / 100) : null;
      if (await this.send({ symbol: sym, side: buy, qty: (action.margin * lev) / p, reduce: false, lev, price: p, sl, ...withMm }, { kind: 'd_open', margin: action.margin, lev, ...withMm }))
        this.note('enter', `Ciclul ${ds.cycle} a pornit: ordinul de bază la ${fmtP(p, this.fx)}.`, sym, { side: cfg.direction, price: p });
      return;
    }
    if (action.kind === 'add') {
      // A safety order the platform just refused waits like an entry.
      if (this.entryPaused(sym)) return;
      const sl = ds.deal && (side === 'short' || lev > 1) ? dealLevels(cfg, ds.deal).sl : null;
      if (await this.send({ symbol: sym, side: buy, qty: (action.margin * lev) / p, reduce: false, lev, price: p, sl, ...withMm }, { kind: 'd_add', ks: action.ks, margin: action.margin }))
        this.note('enter', `${action.ks.length === 1 ? `Ordinul de siguranță ${action.ks[0]}` : `Ordinele de siguranță ${action.ks.join(', ')}`} la ${fmtP(p, this.fx)}.`, sym, { side, price: p });
      return;
    }
    const deal = ds.deal;
    if (!deal) return;
    const pnlBefore = this.st.realized;
    if (await this.send({ symbol: sym, side: sell, qty: deal.qty, reduce: true, lev, price: p, ...withMm }, { kind: 'd_close', reason: action.reason })) {
      const pnl = this.st.realized - pnlBefore;
      const stops = !this.switching && this.st.dca?.done && action.reason === 'sl' && cfg.slAction === 'stop';
      this.note('exit', `${action.reason === 'tp' ? 'Take profit' : 'Stop loss'} la ${fmtP(p, this.fx)}: ciclul ${ds.cycle} s-a închis cu ${fmtSigned(pnl)}.${stops ? ' Botul se oprește (acțiunea la stop loss).' : ''}`, sym, { side, price: p, pnl });
      if (this.st.dca?.done && !this.st.dca.deal && !this.switching) {
        this.setStatus('ending', null);
        this.st.endAction = 'close';
        this.st.endReason = action.reason === 'sl' && cfg.slAction === 'stop' ? 'Stop loss-ul unui ciclu oprește botul.' : 'Ciclurile s-au terminat.';
      }
    }
  }

  // ---------------- Slingshot Premium ----------------

  private async premium(input: BotInput & { strategy: 'premium' }, cfg: PremiumConfig, entries: boolean, closing: boolean): Promise<void> {
    const ps = this.premiumState();
    // FIX-BOTMARGIN: a position closes with the margin it opened with (one from before it: none, the pair's).
    const closeOrder = (pos: BotPosition, price: number): BotOrder => ({ symbol: pos.symbol, side: pos.side === 'long' ? 'sell' : 'buy', qty: pos.qty, reduce: true, lev: pos.lev, price, ...(pos.mm ? { mm: pos.mm } : {}) });
    const close = async (pos: BotPosition, reason: BotTradeReason, price: number, why: string): Promise<boolean> => {
      const before = this.st.realized;
      const ok = await this.send(closeOrder(pos, price), { kind: 'p_close', symbol: pos.symbol, side: pos.side, reason });
      if (ok) {
        const pnl = this.st.realized - before;
        this.note('exit', `${why} Poziția ${pos.side} închisă la ${fmtP(price, this.fx)} cu ${fmtSigned(pnl)}.`, pos.symbol, { side: pos.side, price, pnl });
      }
      return ok;
    };

    if (closing) {
      const reason = this.closeReason();
      for (const pos of [...ps.positions]) {
        const p = this.fresh(pos.symbol);
        if (p !== null) await close(pos, reason, p, this.closeWhy());
        if (this.halted) return;
      }
      return;
    }

    // Exits at the price now: the stop loss, the take profit.
    for (const pos of [...ps.positions]) {
      const p = this.fresh(pos.symbol);
      if (p === null) continue;
      const hit = exitAt(pos, p);
      if (hit) await close(pos, hit, p, hit === 'sl' ? `Stop loss atins (${fmtP(pos.sl as number, this.fx)}).${atV1(pos)}` : `Take profit atins (${fmtP(pos.tp as number, this.fx)}).`);
      if (this.halted) return;
    }

    // The bars that closed since the last look: the bot's symbols, and those taken out of it while a position of the bot
    // is open there (only its exits, FD-BOTEDIT §2).
    const tfMs = tfSeconds(input.tf) * 1000;
    const symbols = this.tracked(input);
    for (const sym of symbols) {
      if (this.halted) return;
      if (this.now < (ps.nextRead[sym] ?? 0)) continue;
      let bar: Bar | null;
      try {
        bar = await this.bar(input, sym);
      } catch (err) {
        this.noteOnce(sym, `read:${(err as Error).message}`, 'info', `Lumânările nu se pot citi: ${(err as Error).message}`);
        ps.nextRead[sym] = this.now + MIN;
        continue;
      }
      if (!bar) {
        ps.nextRead[sym] = this.now + Math.min(tfMs, 15 * MIN);
        continue;
      }
      const seen = ps.lastBar[sym];
      // FIX-LATEENTRY (the user: „5 minute de așteptare pentru a verifica lumânările unui simbol e foarte mult. Mută la
      // 1 minut”): every symbol read again each minute, whatever the timeframe; a bar Twelve Data has not published yet
      // is caught a minute later, not a timeframe later.
      ps.nextRead[sym] = this.now + MIN;
      if (seen === undefined || bar.closedTime <= seen) {
        // The first look (FD-BOT §9: no bar of before the start is taken as new) or no new bar: only a signal still
        // active whose price is still good (FIX-LATEENTRY).
        if (seen === undefined) ps.lastBar[sym] = bar.closedTime;
        if (input.symbols.includes(sym)) await this.onBar(input, cfg, sym, bar, entries, close, true, false);
        continue;
      }
      ps.lastBar[sym] = bar.closedTime;
      if (bar.r.warnings.includes('INSUFFICIENT_HISTORY')) this.noteOnce(sym, 'history', 'info', 'Istoricul e prea scurt pentru Slingshot: semnalele pot lipsi.');
      await this.onBar(input, cfg, sym, bar, entries, close, input.symbols.includes(sym));
    }
    // What was kept for a symbol the bot no longer looks at.
    const kept = new Set(symbols);
    for (const marks of [ps.lastBar, ps.nextRead, this.st.noted, this.st.entryPause]) for (const sym of Object.keys(marks)) if (!kept.has(sym)) delete marks[sym];
    for (const marks of [ps.aiNo, ps.setupTaken, ps.signalTaken, ps.signalAiNo]) if (marks) for (const sym of Object.keys(marks)) if (!kept.has(sym)) delete marks[sym];
  }

  /** The platform refused the last entry on the symbol a moment ago. */
  private entryPaused(sym: string): boolean {
    return this.now < (this.st.entryPause[sym] ?? 0);
  }

  private noteOnce(sym: string, key: string, kind: BotEventKind, message: string, detail: BotEventDetail | null = null): void {
    if (this.st.noted[sym] === key) return;
    this.st.noted[sym] = key;
    this.note(kind, message, sym, detail);
  }

  /** The candles of the bot's timeframe and Slingshot on them, as the chart has them (the user's settings and history). */
  private async bar(input: BotInput, sym: string): Promise<Bar | null> {
    if (this.d.bars) return this.d.bars(this.row.user_id, input, sym, this.now);
    const settings = await this.d.settings.forUser(this.row.user_id);
    const params = settings.indicator;
    const tf = input.tf;
    const chartSec = tfSeconds(tf);
    const msSec = params.msTf ? tfSeconds(params.msTf) : chartSec;
    const count = (await this.d.source.forUser(this.row.user_id)).candles;
    let candles;
    let htf = null;
    if (input.market === 'stock' && fxKindOf(sym)) {
      // FD-FXCOMMODITIES: a pair's or a commodity's candles from Twelve Data (the user's key), every timeframe it has.
      const stocks = this.d.stocks;
      if (!stocks) throw new Error('datele pentru acțiuni nu sunt disponibile');
      // FIX-TDBOTS: the bot's reads come first in the user's Twelve Data credits.
      candles = await stocks.fxCandles(sym, tf, count, this.row.user_id, false, 'bot');
      if (msSec > chartSec && params.msTf) {
        htf = (await stocks.fxCandles(sym, params.msTf as Timeframe, htfCandleCount(count, chartSec, msSec, params.msSwing), this.row.user_id, false, 'bot').catch(() => null))?.candles ?? null;
      }
    } else if (input.market === 'stock') {
      const stocks = this.d.stocks;
      if (!stocks) throw new Error('datele pentru acțiuni nu sunt disponibile');
      const allowed = await stocks.timeframesFor(sym, this.row.user_id);
      if (!allowed.includes(tf)) throw new Error(`timeframe-ul ${tf} cere cheia ta Twelve Data (Setări → Date acțiuni)`);
      const c = await stocks.candles(sym, tf, count, this.row.user_id, false, 'bot');
      candles = c;
      if (msSec > chartSec && params.msTf && allowed.includes(params.msTf as Timeframe)) {
        htf = (await stocks.candles(sym, params.msTf as Timeframe, htfCandleCount(count, chartSec, msSec, params.msSwing), this.row.user_id, false, 'bot').catch(() => null))?.candles ?? null;
      }
    } else {
      const exchange = await this.d.source.forSymbol(this.row.user_id, sym, tf);
      candles = await this.d.market.candles(exchange, sym, tf, count);
      if (msSec > chartSec && params.msTf) {
        htf = (await this.d.market.candles(exchange, sym, params.msTf, htfCandleCount(count, chartSec, msSec, params.msSwing)).catch(() => null))?.candles ?? null;
      }
    }
    const closed = candles.lastClosedIndex;
    if (closed < 0) return null;
    const r = runSlingshot({ candles: candles.candles, htfCandles: htf, chartTfSec: chartSec, msTfSec: msSec, params, nowMs: this.now });
    const bar = candles.candles[closed];
    if (!bar) return null;
    return { r, closed, closedTime: bar.t, close: bar.c, high: bar.h, low: bar.l, candles: candles.candles };
  }

  private async onBar(
    input: BotInput & { strategy: 'premium' },
    cfg: PremiumConfig,
    sym: string,
    bar: Bar,
    entries: boolean,
    close: (pos: BotPosition, reason: BotTradeReason, price: number, why: string) => Promise<boolean>,
    listed: boolean,
    newBar = true,
  ): Promise<void> {
    const ps = this.premiumState();
    const ev = barEvents(bar.r, bar.closed);
    const p = this.fresh(sym) ?? bar.close;
    // FIX-LATEENTRY: the signals of the open positions are taken (a late entry never takes them again).
    for (const pos of ps.positions) if (pos.symbol === sym && pos.signalTime !== undefined) ((ps.signalTaken ??= {})[sym] ??= {})[pos.side] = pos.signalTime;
    // FIX-LATEENTRY: a look without a new bar: only the late entries.
    if (!newBar) {
      if (listed && entries) await this.enter(input, cfg, sym, bar, p, entries, this.late(cfg, sym, bar, p, []));
      return;
    }

    // FIX-BOTSHORTS: the positions entered on a setup still forming: its confirmation brings the signal's levels, its
    // end without a signal closes them.
    const adopted = new Set<SlingshotSignal>();
    for (const pos of ps.positions.filter((x) => x.symbol === sym && x.setup)) {
      await this.follow(input, cfg, pos, bar, p, close, adopted);
      if (this.halted) return;
    }

    // Exits by the bar: Slingshot's take profit signal, the trend turning, its own SL / TP touched between two looks,
    // a signal the other way.
    for (const pos of ps.positions.filter((x) => x.symbol === sym)) {
      const fate = pos.signalTime !== undefined && !pos.setup ? signalFate(bar.r, pos.side, pos.signalTime, bar.closed) : null;
      const opposite = ev.signals.some((s) => s.side !== pos.side);
      let exit: { reason: BotTradeReason; why: string } | null = null;
      if (ev.tpSignal[pos.side] && cfg.exitOnTpSignal) exit = { reason: 'tp_signal', why: 'Semnalul de take profit Slingshot.' };
      else if (fate === 'flip' && cfg.exitOnFlip) exit = { reason: 'flip', why: 'Trendul s-a întors (semnalul a fost invalidat).' };
      else if (fate === 'sl' && cfg.levels === 'slingshot') exit = { reason: 'sl', why: 'Slingshot a marcat stop loss-ul atins pe lumânare.' };
      else if (fate === 'tp' && cfg.levels === 'slingshot') exit = { reason: 'tp', why: 'Slingshot a marcat take profit-ul atins pe lumânare.' };
      else if (opposite && cfg.exitOnOpposite) exit = { reason: 'opposite', why: 'Semnal în direcția opusă.' };
      if (exit) await close(pos, exit.reason, p, exit.why);
      if (this.halted) return;
    }

    // A symbol taken out of the bot: its position's exits only.
    if (!listed) return;
    // The signals confirmed on the bar (not the one a position on its setup just took), and with "La setup" the setups
    // forming on it (FIX-BOTSHORTS): a side without a signal on the bar, the bot's direction, while it can enter.
    const candidates: Candidate[] = ev.signals.filter((s) => !adopted.has(s)).map((s) => ({ side: s.side, sl: s.sl, tp: s.tp, time: s.time }));
    if (cfg.entry === 'setup' && entries) {
      for (const x of setupsOn(bar.r, bar.closed)) {
        if (ev.signals.some((s) => s.side === x.side) || (cfg.direction !== 'both' && cfg.direction !== x.side)) continue;
        // One entry a setup: its own position, or an exit before its confirmation (FIX-BOTSHORTS).
        if (ps.setupTaken?.[sym]?.[x.side] === x.startTime) continue;
        // FIX-BOTV1STOP: its stop at the V1, where Slingshot cancels it; its take profit the chart's.
        candidates.push({ side: x.side, sl: x.v1, tp: x.tp, time: x.v2Time, setup: x });
      }
    }
    // FIX-LATEENTRY: a signal of a bar not looked at, still active, at a price still good (a side without one on the bar).
    if (entries) candidates.push(...this.late(cfg, sym, bar, p, candidates));
    await this.enter(input, cfg, sym, bar, p, entries, candidates);
  }

  /** FIX-LATEENTRY: the late signals as candidates: a side without one already, the bot's direction, not taken before. */
  private late(cfg: PremiumConfig, sym: string, bar: Bar, p: number, already: Candidate[]): Candidate[] {
    const ps = this.premiumState();
    if (ps.positions.some((x) => x.symbol === sym)) return [];
    return lateSignals(bar.r, bar.closed, bar.candles, p)
      .filter((s) => !already.some((c) => c.side === s.side) && (cfg.direction === 'both' || cfg.direction === s.side) && ps.signalTaken?.[sym]?.[s.side] !== s.time)
      .map((s) => ({ side: s.side, sl: s.sl, tp: s.tp, time: s.time, late: { at: s.at, confirmTime: s.confirmTime } }));
  }

  /** The candidates of a look: decided, the market's side first, the first one that passes entered. */
  private async enter(input: BotInput & { strategy: 'premium' }, cfg: PremiumConfig, sym: string, bar: Bar, p: number, entries: boolean, candidates: Candidate[]): Promise<void> {
    const ps = this.premiumState();
    if (!candidates.length) return;
    // Both sides on one bar: the rules first, for each; the side the market favours is tried first, and only it asks
    // the AI (one position per symbol).
    const tried: { s: Candidate; d: Decision }[] = [];
    for (const s of candidates) tried.push({ s, d: await this.decide(input, cfg, sym, s, bar, p, entries) });
    const rank = (t: (typeof tried)[number]) => (t.d.score ? favoured(t.s.side, t.d.score.score) : -1);
    tried.sort((a, b) => rank(b) - rank(a));
    let entered = false;
    for (const { s, d: rules } of tried) {
      if (this.halted) return;
      let d = rules;
      if (!d.skip && entered) d = { ...d, skip: 'botul a intrat deja pe semnalul celălalt.' };
      if (!d.skip) d = await this.confirm(input, cfg, sym, s, bar, p, d);
      if (d.skip) {
        const side = s.side.toUpperCase();
        // A setup is tried again at every bar it forms on: the same reason is said once (FIX-BOTSHORTS).
        if (s.setup) this.noteOnce(sym, `setup:${s.side}:${s.setup.startTime}:${d.skip.replace(/[\d.,]+/g, '#')}`, d.kind ?? 'skip', `${side} (în formare): ${d.skip}`, d.detail);
        // FIX-LATEENTRY: a late signal is tried at every look while it stays good: the same reason is said once.
        else if (s.late) this.noteOnce(sym, `late:${s.side}:${s.time}:${d.skip.replace(/[\d.,]+/g, '#')}`, d.kind ?? 'skip', `${side} (semnal de la ${hm(s.late.confirmTime)} UTC): ${d.skip}`, d.detail);
        else this.note(d.kind ?? 'skip', `${side}: ${d.skip}`, sym, d.detail);
        continue;
      }
      const sized = d.sized!;
      const mm = this.marginOf(input);
      const withMm = mm ? { mm } : {};
      const setup = s.setup ? { setup: { start: s.setup.startTime, sl: d.sl!, tp: d.tp!, v1: s.setup.v1 } } : {};
      const ok = await this.send(
        { symbol: sym, side: s.side === 'long' ? 'buy' : 'sell', qty: sized.qty, reduce: false, lev: sized.lev, price: p, sl: d.sl, tp: d.tp, ...withMm },
        { kind: 'p_open', symbol: sym, side: s.side, sl: d.sl!, tp: d.tp!, lev: sized.lev, signalTime: s.time, ...withMm, ...setup },
      );
      if (ok) {
        entered = true;
        // FIX-LATEENTRY: this signal is taken: never entered again, late.
        if (!s.setup) ((ps.signalTaken ??= {})[sym] ??= {})[s.side] = s.time;
        if (input.exec === 'real') this.spent += fundsFor(sized, input.fee);
        // The leverage said on futures, and off them (a Paper Trading profile) when above 1×.
        const lev = input.market === 'futures' || (this.leveraged(input) && sized.lev > 1) ? ` ${sized.lev}×` : '';
        const early = s.setup
          ? ` Intrare la setup (semnalul încă în formare)${cfg.levels === 'slingshot' ? `: stop loss-ul e la ${s.side === 'short' ? 'maximul' : 'minimul'} V1, unde Slingshot anulează setup-ul; la confirmare, SL / TP-ul se mută la cele ale semnalului` : ''}.`
          : s.late
            ? ` Intrare târzie: semnalul s-a confirmat la ${hm(s.late.confirmTime)} UTC, la ${fmtP(s.late.at, this.fx)}; prețul de acum e cel mult cu ${Math.round(LATE_TOLERANCE * 100)}% din drumul spre take profit mai rău.`
            : '';
        // FIX-BOTBUDGET: the amount it took from the budget (and the position it makes with the leverage).
        const cur = this.currencyOf(input, sym);
        const amount = ` Suma: ${money(sized.margin, cur)} ${cur}${sized.lev > 1 ? `, poziția ${money(sized.notional, cur)} ${cur}` : ''}.`;
        this.note('enter', `${s.side.toUpperCase()} la ${fmtP(p, this.fx)}${lev}: SL ${fmtP(d.sl!, this.fx)}, TP ${fmtP(d.tp!, this.fx)}, scor ${fmtN(d.score!.score)}.${early}${amount}${sized.notes.length ? ` ${sized.notes.join(' ')}` : ''}`, sym, { ...d.detail, qty: sized.qty, leverage: sized.lev, margin: sized.margin });
      }
    }
  }

  /**
   * FIX-BOTSHORTS: a position on a setup at a closed bar. Confirmed: the signal's SL / TP (one the user moved stays
   * theirs; percents from the entry stay), then it follows the signal; one already past closes now. Still forming: it
   * follows its V2. Ended without a signal: closed with "Ieși când trendul se întoarce", else kept with its levels.
   */
  private async follow(
    input: BotInput & { strategy: 'premium' },
    cfg: PremiumConfig,
    pos: BotPosition,
    bar: Bar,
    p: number,
    close: (pos: BotPosition, reason: BotTradeReason, price: number, why: string) => Promise<boolean>,
    adopted: Set<SlingshotSignal>,
  ): Promise<void> {
    const setup = pos.setup as PositionSetup;
    const side = pos.side.toUpperCase();
    const fate = setupFate(bar.r, pos.side, setup.start, bar.closed);
    if (fate === 'forming') {
      const now = setupsOn(bar.r, bar.closed).find((x) => x.side === pos.side && x.startTime === setup.start);
      if (now) pos.signalTime = now.v2Time;
      return;
    }
    if (fate === 'cancelled') {
      // FIX-BOTV1STOP: its stop reached on the bar between two looks (the V1: the setup ended by it): out by the stop.
      const extreme = pos.side === 'short' ? bar.high : bar.low;
      if (pos.sl !== null && extreme !== undefined && reached(extreme, pos.sl, pos.side === 'short')) {
        await close(pos, 'sl', p, `Stop loss-ul (${fmtLevel(pos.sl, this.fx)}) a fost atins pe lumânare.${atV1(pos)}`);
        return;
      }
      // An exit the platform refused keeps the setup: the next bar tries it again.
      if (cfg.exitOnFlip) await close(pos, 'flip', p, `Setup-ul ${side} nu s-a confirmat (s-a anulat).`);
      else {
        delete pos.setup;
        this.note('info', `Setup-ul ${side} nu s-a confirmat (s-a anulat): poziția rămâne cu SL / TP-ul ei.`, pos.symbol);
      }
      return;
    }
    const s = fate.signal;
    adopted.add(s);
    delete pos.setup;
    pos.signalTime = s.time;
    if (cfg.levels !== 'slingshot') {
      this.note('info', `Semnalul ${side} s-a confirmat; SL / TP-ul rămân cele de la intrare (procentele tale).`, pos.symbol);
      return;
    }
    const was = { sl: pos.sl, tp: pos.tp };
    const kept: string[] = [];
    if (pos.sl === setup.sl) pos.sl = s.sl;
    else kept.push('SL-ul');
    if (pos.tp === setup.tp) pos.tp = s.tp;
    else kept.push('TP-ul');
    const moved = [was.sl !== pos.sl ? `SL ${fmtLevel(was.sl, this.fx)} → ${fmtLevel(pos.sl, this.fx)}` : '', was.tp !== pos.tp ? `TP ${fmtLevel(was.tp, this.fx)} → ${fmtLevel(pos.tp, this.fx)}` : ''].filter(Boolean);
    const yours = kept.length ? ` ${kept.join(' și ')} ${kept.length > 1 ? 'mutate de tine rămân' : 'mutat de tine rămâne'}.` : '';
    // The levels as they are (no R:R); a stop the liquidation would come before is said.
    const liq = this.leveraged(input) && pos.lev > 1 && pos.sl !== null && Math.abs(pos.entry - pos.sl) / pos.entry >= LIQ_SAFETY * liqDistance(pos.lev) ? ` Stop loss-ul e dincolo de distanța sigură față de lichidare (levier ${pos.lev}×).` : '';
    this.note('info', `Semnalul ${side} s-a confirmat: ${moved.length ? moved.join(', ') : 'SL / TP-ul sunt aceleași'}.${yours}${liq}`, pos.symbol, { side: pos.side, ...(pos.sl !== null ? { sl: pos.sl } : {}), ...(pos.tp !== null ? { tp: pos.tp } : {}) });
    const hit = exitAt(pos, p);
    if (hit) await close(pos, hit, p, hit === 'sl' ? `Prețul a trecut deja de stop loss-ul semnalului (${fmtLevel(pos.sl, this.fx)}).` : `Prețul a trecut deja de take profit-ul semnalului (${fmtLevel(pos.tp, this.fx)}).`);
  }

  /** The checks of FD-BOT §6, in their order; the first one that says no stops the entry. */
  private async decide(
    input: BotInput & { strategy: 'premium' },
    cfg: PremiumConfig,
    sym: string,
    s: Candidate,
    bar: Bar,
    price: number,
    entries: boolean,
  ): Promise<Decision> {
    const ps = this.premiumState();
    const detail: BotEventDetail = { side: s.side, price };
    if (!entries) return { skip: this.switching ? SWITCHING : (NO_ENTRIES[this.status] ?? 'pierderea maximă pe zi e atinsă: nicio intrare până mâine.'), kind: 'signal', detail };
    if (cfg.direction !== 'both' && cfg.direction !== s.side) return { skip: `botul face doar ${cfg.direction}.`, kind: 'signal', detail };
    if (ps.positions.some((x) => x.symbol === sym)) return { skip: 'botul are deja o poziție pe simbol.', kind: 'signal', detail };
    if (this.entryPaused(sym)) return { skip: 'platforma a refuzat ultima intrare pe simbol: botul mai așteaptă câteva minute.', kind: 'signal', detail };
    const lv = levelsFor(cfg, s, price);
    if ('error' in lv) return { skip: lv.error, detail };
    Object.assign(detail, { sl: lv.sl, tp: lv.tp });
    if (cfg.newsWindowMin > 0) {
      const events = await highImpact(this.d.calendar, this.row.user_id, this.now - AFTER_EVENT_MS, this.now + cfg.newsWindowMin * MIN);
      const first = events[0];
      if (first) return { skip: `eveniment cu impact mare ${first.ts > this.now ? `peste ${Math.max(1, Math.round((first.ts - this.now) / MIN))} min` : 'chiar acum'}: ${first.title}.`, detail };
    }
    const mood = this.areaFor(input, sym, await this.mood(areaOf(input.market)));
    if (cfg.areaVeto && areaAgainst(s.side, mood.area)) return { skip: `aria ${input.market === 'stock' ? 'Acțiuni' : 'Crypto'} e ${s.side === 'long' ? 'negativă' : 'pozitivă'} (${Math.round(mood.area!.index)}).`, detail };
    const coin = input.market === 'stock' ? sym : (sym.split('/')[0] as string);
    const news = await readSymbolNews(this.d.daily, this.row.user_id, coin, this.now);
    const structure = barEvents(bar.r, bar.closed).structure;
    // FD-BOTDIR: the market's score, the same for either side; each side has its threshold.
    const market = marketScore({ day: mood.day, area: mood.area, general: mood.general, symbol: news.score, slingshot: { structure: structure === null ? 'none' : structure === 'msBullish' ? 'up' : 'down' } }, cfg.weights);
    const score: BotScore = { score: market.score, limit: { side: s.side, value: limitOf(s.side, cfg) }, parts: market.parts };
    detail.score = score;
    if (!passes(s.side, score.score, cfg))
      return { skip: s.side === 'long' ? `scorul pieței ${fmtN(score.score)} e sub minimul pentru long (${cfg.longMin}).` : `scorul pieței ${fmtN(score.score)} e peste maximul pentru short (${cfg.shortMax}).`, detail, score };
    // Room for the trade. FIX-BOTBUDGET: the open trades' maximum is at most one a symbol.
    const room = Math.min(cfg.maxOpen, input.symbols.length);
    if (ps.positions.length >= room) return { skip: `sunt deja ${ps.positions.length} tranzacții deschise (cel mult ${room}).`, detail, score };
    if (this.now < ps.cooldownUntil) return { skip: `pauză după o pierdere, până la ${new Date(ps.cooldownUntil).toISOString().slice(11, 16)} UTC.`, detail, score };
    const committed = ps.positions.reduce((a, x) => a + x.margin, 0);
    // FIX-BOTBUDGET: the free budget shared among the trades still to open, at most the maximum a trade (FIX-NOMINPROFIT:
    // no least profit at the take profit).
    const sized = sizeFor({ cfg, futures: this.leveraged(input), budget: input.maxAmount, committed, slots: room - ps.positions.length, leverage: input.leverage, price, sl: lv.sl, tp: lv.tp, feePct: input.fee });
    if ('error' in sized) return { skip: sized.error, detail, score };
    return { detail, score, sl: lv.sl, tp: lv.tp, sized, news };
  }

  /** The currency a bot's symbol counts in: a pair's quote (USDT), USD for a share. */
  private currencyOf(input: BotInput, sym: string): string {
    return input.market === 'stock' ? 'USD' : (sym.split('/')[1]?.split(':')[0] ?? 'USDT');
  }

  /**
   * After the rules (FD-BOT §6, checks 8–9): a position that is not the bot's, the account's money (FIX-BOTSHORTS: less
   * than the trade asks, it goes with what is there; both before the AI, which is not asked for an entry that cannot be
   * made), then the AI's last look (once a setup: its no holds until the confirmation).
   */
  private async confirm(input: BotInput & { strategy: 'premium' }, cfg: PremiumConfig, sym: string, s: Candidate, bar: Bar, price: number, rules: Decision): Promise<Decision> {
    const ps = this.premiumState();
    let d = rules;
    if (await this.foreign(input, sym)) return { ...d, skip: `există deja o poziție pe ${perpetualOf(sym)} care nu e a botului.` };
    if (input.exec === 'real' && d.sized) {
      const free = await this.freeFunds(input, sym);
      if (free !== null && free < fundsFor(d.sized, input.fee)) {
        const fit = fitFunds(d.sized, free, input.fee, price);
        const c = this.currencyOf(input, sym);
        const cur = ` ${c}`;
        const left = money(Math.max(0, free), c);
        if (!fit) return { ...d, skip: 'în cont nu e nimic disponibil.' };
        // The AI chooses within what the account has.
        d = { ...d, sized: { ...fit, upper: fit.margin, notes: [...fit.notes, `Suma a fost micșorată la cât e disponibil în cont (${left}${cur}).`] } };
      }
    }
    const { detail, score } = d;
    const lv = { sl: d.sl as number, tp: d.tp as number };
    const structure = barEvents(bar.r, bar.closed).structure;
    // The AI can only stop an entry the rules approved.
    if (cfg.ai === 'confirm' && score) {
      if (s.setup && ps.aiNo?.[sym]?.[s.side] === s.setup.startTime) return { ...d, skip: 'AI-ul a spus deja nu pentru acest setup: e întrebat din nou la confirmare.' };
      // FIX-LATEENTRY: a signal the AI refused is not asked about again at the next looks.
      if (!s.setup && ps.signalAiNo?.[sym]?.[s.side] === s.time) return { ...d, skip: 'AI-ul a spus deja nu pentru acest semnal.' };
      const mood = this.areaFor(input, sym, await this.mood(areaOf(input.market)));
      const news = d.news ?? (await readSymbolNews(this.d.daily, this.row.user_id, input.market === 'stock' ? sym : (sym.split('/')[0] as string), this.now));
      const day = new Date(this.now).toISOString().slice(0, 10);
      if (ps.ai.day !== day) ps.ai = { day, n: 0 };
      let verdict: Awaited<ReturnType<typeof askAi>>;
      if (ps.ai.n >= AI_PER_DAY) verdict = { error: `limita de ${AI_PER_DAY} întrebări pe zi a fost atinsă.` };
      else {
        ps.ai.n += 1;
        const events = await highImpact(this.d.calendar, this.row.user_id, this.now, this.now + 24 * 60 * MIN);
        const ms = bar.r.ms;
        verdict = await askAi(
          this.d.ai,
          this.d.log,
          this.row.user_id,
          {
            symbol: sym,
            side: s.side,
            tf: input.tf,
            stage: s.setup ? 'setup' : 'signal',
            ...(s.late ? { late: s.late } : {}),
            price,
            sl: lv.sl,
            tp: lv.tp,
            levels: cfg.levels,
            trend: bar.r.uptrend[bar.closed] ? 'up' : 'down',
            structure: `${structure === 'msBullish' ? 'ultima rupere în sus' : structure === 'msBearish' ? 'ultima rupere în jos' : 'fără rupere'}${ms?.upper ? `, rezistență ${fmtP(ms.upper.price, this.fx)}` : ''}${ms?.lower ? `, suport ${fmtP(ms.lower.price, this.fx)}` : ''}`,
            score,
            mood,
            news,
            events,
            recent: ps.recent ?? [],
            // FIX-BOTBUDGET: how much it may take, the bot's proposal, what is free and how many trades it is shared by.
            ...(d.sized
              ? { alloc: { max: d.sized.upper, suggested: d.sized.margin, free: input.maxAmount - ps.positions.reduce((a, x) => a + x.margin, 0), slots: Math.max(1, Math.min(cfg.maxOpen, input.symbols.length) - ps.positions.length), lev: d.sized.lev, currency: this.currencyOf(input, sym) } }
              : {}),
          },
          this.now,
        );
      }
      if ('error' in verdict) {
        if (cfg.aiFallback === 'skip') return { ...d, skip: `AI-ul nu a răspuns (${verdict.error}): fără intrare.` };
        this.note('info', `AI-ul nu a răspuns (${verdict.error}): intrarea merge după reguli.`, sym);
      } else {
        detail.ai = verdict.verdict;
        if (verdict.verdict.decision === 'skip') {
          if (s.setup) ((ps.aiNo ??= {})[sym] ??= {})[s.side] = s.setup.startTime;
          else ((ps.signalAiNo ??= {})[sym] ??= {})[s.side] = s.time;
          return { ...d, skip: `AI-ul a spus nu (${verdict.verdict.confidence}%): ${verdict.verdict.reason}` };
        }
        // FIX-BOTBUDGET: the AI's amount, within the bounds.
        if (d.sized && typeof verdict.verdict.amount === 'number' && verdict.verdict.amount > 0) {
          const sized = withMargin(d.sized, verdict.verdict.amount, price);
          d = { ...d, sized: { ...sized, notes: [...sized.notes, 'Suma aleasă de AI.'] } };
        }
      }
    }
    return d;
  }

  /**
   * FD-FXCOMMODITIES (the user: no area filter): a pair or a commodity has no area (Crypto or Acțiuni): it neither stops
   * an entry nor counts in the score (its part "fără date").
   */
  private areaFor(input: BotInput, sym: string, mood: MarketMood): MarketMood {
    return input.market === 'stock' && fxKindOf(sym) ? { ...mood, area: null } : mood;
  }

  private mood(area: 'crypto' | 'stocks'): Promise<MarketMood> {
    const key = `${this.row.user_id}|${area}`;
    let m = this.moods.get(key);
    if (!m) {
      m = readMood(this.d.daily, this.row.user_id, this.tz, area, this.now);
      this.moods.set(key, m);
    }
    return m;
  }

  /** The account's free money for an entry: USDT free for futures, the symbol's quote free on spot, a paper profile's cash for shares; null when unknown. */
  private async freeFunds(input: BotInput, sym: string): Promise<number | null> {
    const pf = await this.account();
    if (!pf) return null;
    if (input.market === 'futures') return pf.totals.futuresAvailable === null ? null : pf.totals.futuresAvailable - this.spent;
    // FD-PAPER: a Paper Trading profile of shares has its money as cash (what is free of its positions and orders).
    if (input.market === 'stock') return pf.exchange === 'paper' && pf.cash !== null ? pf.cash - this.spent : null;
    const quote = sym.split('/')[1];
    const row = pf.balances.find((b) => b.asset === quote && (b.account === 'spot' || b.account === 'trade' || b.account === 'unified' || b.account === 'paper'));
    return row ? row.free - this.spent : null;
  }

  // ---------------- saving ----------------

  private async saveState(): Promise<void> {
    await this.d.db.run('UPDATE bots SET state = ? WHERE id = ?', [JSON.stringify(this.st), this.row.id]);
  }

  async save(): Promise<void> {
    if (!this.halted && this.status !== 'problem' && this.events.every((e) => e.kind !== 'problem')) this.st.errors = 0;
    const db = this.d.db;
    await db.tx(async () => {
      await db.run('UPDATE bots SET state = ?, ran_at = ? WHERE id = ?', [JSON.stringify(this.st), this.now, this.row.id]);
      // The status changes only from the one this look started from: a pause or a stop sent meanwhile wins.
      if (this.status !== this.row.status || this.reason !== this.row.status_reason) {
        await db.run('UPDATE bots SET status = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status = ?', [this.status, this.reason?.slice(0, 600) ?? null, this.now, this.row.id, this.row.status]);
      }
      // Only what this look read goes: a command the API added to meanwhile (FD-BOTEDIT: an edit's choice for the
      // positions) keeps the rest for the next look. Locked until the end, so the API's write waits and reads it again.
      if (this.clearCommand && this.commandSeen !== null) {
        const current = (await db.get<{ command: string | null }>('SELECT command FROM bots WITH (UPDLOCK, HOLDLOCK) WHERE id = ?', [this.row.id]))?.command ?? null;
        if (current !== null) await db.run('UPDATE bots SET command = ? WHERE id = ?', [current === this.commandSeen ? null : commandLeft(current, this.commandSeen), this.row.id]);
      }
      for (const t of this.trades) {
        await db.run(
          'INSERT INTO bot_trades(bot_id, symbol, side, qty, entry, [exit], pnl, fees, opened_at, closed_at, reason, account_id, market, lev, sl, tp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [this.row.id, t.symbol, t.side, t.qty, t.entry, t.exit, t.pnl, t.fees, t.openedAt, t.closedAt, t.reason, t.accountId, t.market, t.lev, t.sl, t.tp],
        );
      }
      for (const ev of this.events) {
        await db.run('INSERT INTO bot_events(bot_id, at, kind, symbol, message, detail) VALUES (?, ?, ?, ?, ?, ?)', [this.row.id, this.now, ev.kind, ev.symbol, ev.message, ev.detail ? JSON.stringify(ev.detail) : null]);
      }
    });
  }
}

/** FIX-BOTMARGIN: the margin a new futures position opens with (the settings'); none off futures. */

/** FD-TRADES: a closed trade's leverage and levels (null: it had none). */
interface Levels {
  lev: number;
  sl: number | null;
  tp: number | null;
}

/** FIX-BOTSHORTS: what an entry is tried on: a confirmed signal, or a setup still forming (its levels on the bar). */
type Candidate = Pick<SlingshotSignal, 'side' | 'sl' | 'tp' | 'time'> & {
  setup?: SlingshotSetup;
  /** FIX-LATEENTRY: a signal of an earlier bar: its entry then and when it was confirmed. */
  late?: { at: number; confirmTime: number };
};

/** "20:05" (UTC) of a moment. */
const hm = (t: number): string => new Date(t).toISOString().slice(11, 16);

/** A signal checked: why it is not taken (`skip`), or its levels and size. */
interface Decision {
  skip?: string;
  kind?: BotEventKind;
  detail: BotEventDetail;
  score?: BotScore;
  sl?: number;
  tp?: number;
  sized?: Sized;
  /** The symbol's news read for the score (the AI reads them again otherwise). */
  news?: SymbolNews;
}

/** Why a signal is not taken while the bot cannot enter (running: the daily loss). */
const NO_ENTRIES: Partial<Record<BotStatus, string>> = { paused: 'botul e în pauză.', problem: 'botul are o problemă: nicio intrare până la „Reia”.', ending: 'botul se încheie: fără intrări noi.' };
/** FD-BOTEDIT §3: why a signal is not taken during a transition. */
const SWITCHING = 'botul aplică setările noi: întâi se termină pozițiile deschise cu cele vechi.';

const fmtN = (v: number, d = 1) => num(v, d);
const fmtP = price;
const fmtLevel = (v: number | null, fx: boolean) => (v === null ? '—' : fmtP(v, fx));
/** FIX-BOTV1STOP: a setup's stop at its V1 (not moved on the chart, not the user's percent): reaching it ends the setup. */
const atV1 = (pos: BotPosition): string => (pos.setup?.v1 !== undefined && pos.sl === pos.setup.v1 ? ` E ${pos.side === 'short' ? 'maximul' : 'minimul'} V1: setup-ul ${pos.side.toUpperCase()} s-a invalidat.` : '');
const fmtQ = qty;
const fmtSigned = signed;
