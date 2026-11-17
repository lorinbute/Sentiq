// The bots as the API serves them (FD-BOT §1, §7; TD-BOT §5): the list, the details, the form's check, making one, and
// what the user may do to it. The API writes the settings and asks; the engine alone moves positions (TD-BOT §1).
import {
  areaOf,
  botInputSchema,
  botCurrency,
  dcaPlan,
  END_ACTION_RO,
  gridPlan,
  isUsdQuote,
  LEVERAGE_FUTURES,
  MARGIN_FUTURES,
  MARGIN_HINT_PAPER_RO,
  MARGIN_HINT_RO,
  MARGIN_RO,
  MAX_ACTIVE_BOTS,
  MIN_TRADE_PROFIT,
  perpetualOf,
  rrText,
  SPOT_LONG,
  STRATEGY_RO,
  TRADE_REASON_RO,
  type BotCheck,
  type BotDetail,
  type BotEdit,
  type BotEndAction,
  type BotPatch,
  type BotEventRow,
  type BotInput,
  type BotLevel,
  type BotLevelMove,
  type BotMarginMode,
  type BotMarket,
  type BotPositionView,
  type BotSide,
  type BotTradeRow,
  type BotTransition,
  type BotView,
  type PositionsMode,
  transitionOf,
  wantsShort,
} from '../../shared/bot.ts';
import { isPaperExchange, providerById } from '../../shared/providers.ts';
import { TRADING } from '../../shared/trading.ts';
import type { Db, SqlValue } from '../db/database.ts';
import { HISTORY_MAX_ROWS, marginOf, pnlPercent, type HistoryMarket, type TradeHistoryRow } from '../exchange/trade-history.ts';
import { ConflictError, NotFoundError } from '../http/errors.ts';
import { formatIssues, ValidationError } from '../settings.ts';
import { dealAvg, dealLevels, nextSafety } from './dca.ts';
import { parseCommand, parseInput, readQuote, type BotCommand, type BotEngine, type BotRow } from './engine.ts';
import { num, price } from './format.ts';
import { scoreReach } from './score.ts';
import { applyLevels, basisOf, holdsPositions, newState, openPnl, parseState, type BotState } from './state.ts';
import { commissionText } from '../../shared/paper.ts';

const fmtNum = num;
const fmtPrice = price;

/** What the bot has in play (margin on futures, the cost on spot), and what its positions would make at the last prices. */
export function exposure(input: BotInput, st: BotState): { committed: number; unrealized: number | null; positions: BotPositionView[] } {
  const positions: BotPositionView[] = [];
  let committed = 0;
  let unrealized: number | null = 0;
  const priceOf = (sym: string) => st.prices[sym]?.p ?? null;
  const add = (p: BotPositionView) => {
    positions.push(p);
    committed += p.margin;
    if (unrealized !== null) unrealized = p.unrealized === null ? null : unrealized + p.unrealized;
  };
  for (const p of st.premium?.positions ?? []) {
    const price = priceOf(p.symbol);
    add({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, price, sl: p.sl, tp: p.tp, unrealized: price === null ? null : openPnl(p.side, p.entry, price, p.qty), leverage: p.lev, margin: p.margin, openedAt: p.openedAt });
  }
  const sym = input.symbols[0] as string;
  const price = priceOf(sym);
  const deal = st.dca?.deal;
  if (deal && input.strategy === 'dca') {
    const lv = dealLevels(input.dca, deal);
    const avg = dealAvg(deal);
    // FD-BOTEDIT §2: an open cycle keeps its leverage.
    add({ symbol: sym, side: deal.side, qty: deal.qty, entry: avg, price, sl: lv.sl, tp: lv.tp, unrealized: price === null ? null : openPnl(deal.side, avg, price, deal.qty), leverage: deal.lev ?? input.leverage, margin: deal.margin, openedAt: deal.openedAt });
  }
  const g = st.grid;
  if (g) {
    let net = 0;
    let cost = 0;
    let margin = 0;
    let pnl = 0;
    let opened = Infinity;
    for (const s of g.slots) {
      if (s.entry === null) continue;
      const dir = s.side === 'long' ? 1 : -1;
      net += dir * g.qty;
      cost += dir * g.qty * s.entry;
      margin += (g.qty * s.entry) / g.lev;
      if (price !== null) pnl += openPnl(s.side, s.entry, price, g.qty);
      opened = Math.min(opened, s.openedAt ?? Infinity);
    }
    if (margin > 0) add({ symbol: sym, side: net >= 0 ? 'long' : 'short', qty: Math.abs(net), entry: net !== 0 ? cost / net : 0, price, sl: null, tp: null, unrealized: price === null ? null : pnl, leverage: g.lev, margin, openedAt: Number.isFinite(opened) ? opened : 0 });
  }
  return { committed, unrealized, positions };
}

/** A price level as the chart can draw it: a positive number, else none. */
const level = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v > 0 ? v : null);

/**
 * A bot's settings, the ones its open positions run with (`runOf`) and its state, with the levels dragged on the chart
 * that the engine has not read yet (FIX-BOTDRAG: they show at once). Null when the settings cannot be read.
 */
function stateOf(row: BotRow): { input: BotInput; run: BotInput; changes: string[]; st: BotState } | null {
  const input = parseInput(row);
  if (!input) return null;
  const st = parseState(row.state);
  const { run, changes } = runOf(input, st);
  const moves = parseCommand(row.command)?.levels;
  if (moves?.length) applyLevels(st, moves, run.symbols[0] ?? '');
  return { input, run, changes, st };
}

/** The positions with their levels as the chart draws them: a grid's open intervals together, its stop on the side it holds, no take profit. */
function levelPositions(run: BotInput, st: BotState): BotPositionView[] {
  const grid = run.strategy === 'grid' ? run.grid : null;
  return exposure(run, st).positions.map((p) => (grid ? { ...p, sl: p.side === 'long' ? grid.stopBelow : grid.stopAbove, tp: null } : p));
}

const COLUMNS = 'id, user_id, name, strategy, execution, account_id, market, area, symbols, tf, config, status, status_reason, command, state, starts_at, ends_at, created_at, updated_at, ran_at';

/**
 * FD-BOTEDIT: what the engine runs the open positions with: the settings of the positions (`state.basis`) during a
 * transition, else the bot's (a change that needs none applies at the next look). A state from before has none: the
 * bot's settings, which could not change otherwise until then.
 */
export function runOf(input: BotInput, st: BotState): { run: BotInput; changes: string[] } {
  const basis = basisOf(st) ?? input;
  const changes = transitionOf(basis, input);
  return { run: changes.length ? basis : input, changes };
}

/** Where a bot trades on an account: each (account, market, symbol) of its settings and of its open positions (FD-BOTEDIT §4). */
function inPlay(input: BotInput | null, st: BotState): { accountId: number; market: BotInput['market']; symbol: string }[] {
  const out: { accountId: number; market: BotInput['market']; symbol: string }[] = [];
  if (input?.exec === 'real' && input.accountId !== null) for (const symbol of input.symbols) out.push({ accountId: input.accountId, market: input.market, symbol });
  const run = input ? runOf(input, st).run : basisOf(st);
  if (run?.exec === 'real' && run.accountId !== null) for (const p of exposure(run, st).positions) out.push({ accountId: run.accountId, market: run.market, symbol: p.symbol });
  return out;
}

/** An edit's context (FD-BOTEDIT): the bot as it is, the settings of its open positions, the user's choice for them. */
interface EditContext {
  row: BotRow;
  st: BotState;
  /** The settings of the open positions (`state.basis`, or the bot's when the state has none yet). */
  basis: BotInput;
  positions: PositionsMode | undefined;
}

export class BotService {
  private readonly db: Db;
  private readonly engine: BotEngine;
  private readonly now: () => number;

  constructor(db: Db, engine: BotEngine) {
    this.db = db;
    this.engine = engine;
    this.now = engine.now;
  }

  private get d() {
    return this.engine.deps;
  }

  private async own(userId: number, id: number): Promise<BotRow> {
    const row = await this.db.get<BotRow>(`SELECT ${COLUMNS} FROM bots WHERE id = ? AND user_id = ?`, [id, userId]);
    if (!row) throw new NotFoundError('Botul nu există.');
    return row;
  }

  private async accountsOf(userId: number) {
    return new Map((await this.d.accounts.list(userId)).map((a) => [a.id, a]));
  }

  private view(row: BotRow, accounts: Map<number, { id: number; label: string; exchange: string; env: string }>): BotView {
    const input = parseInput(row);
    const st = parseState(row.state);
    const symbols = input?.symbols ?? (JSON.parse(row.symbols) as string[]);
    const x = input ? exposure(runOf(input, st).run, st) : { committed: 0, unrealized: null, positions: [] };
    const acc = row.account_id !== null ? accounts.get(row.account_id) : undefined;
    return {
      id: row.id,
      name: row.name,
      strategy: row.strategy,
      exec: row.execution,
      market: row.market,
      area: row.area,
      symbols,
      tf: row.tf,
      account: acc ? { id: acc.id, label: acc.label, exchange: acc.exchange, env: acc.env } : null,
      status: row.status,
      statusReason: row.status_reason,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      currency: botCurrency(row.market, symbols),
      maxAmount: input?.maxAmount ?? 0,
      committed: x.committed,
      realized: st.realized,
      unrealized: x.positions.length ? x.unrealized : 0,
      trades: st.trades,
      wins: st.wins,
      openPositions: x.positions.length,
      createdAt: row.created_at,
      ranAt: row.ran_at,
    };
  }

  async list(userId: number): Promise<BotView[]> {
    const rows = await this.db.all<BotRow>(`SELECT ${COLUMNS} FROM bots WHERE user_id = ? ORDER BY CASE WHEN status = N'ended' THEN 1 ELSE 0 END, created_at DESC, id DESC`, [userId]);
    const accounts = rows.some((r) => r.account_id !== null) ? await this.accountsOf(userId) : new Map();
    return rows.map((r) => this.view(r, accounts));
  }

  /**
   * FD-TRADES: what the user's bots did on an account (Real): the trades closed there since `from` (the newest
   * HISTORY_MAX_ROWS, and one more to tell the list was cut), and the positions they hold there now, with their levels. A bot moved to another account keeps its
   * earlier trades on the one they were made on (`bot_trades.account_id`).
   */
  async accountTrades(userId: number, accountId: number, exchange: string, from: number): Promise<TradeHistoryRow[]> {
    // At eToro a share bought with leverage, or sold short, is a CFD.
    const marketOf = (market: BotMarket, lev: number | null, side: BotSide): HistoryMarket => (market === 'stock' ? (exchange === 'etoro' && ((lev ?? 1) > 1 || side === 'short') ? 'cfd' : 'stock') : market);
    const closed = await this.db.all<{
      id: number;
      bot_id: number;
      name: string;
      symbol: string;
      side: BotSide;
      qty: number;
      entry: number;
      exit: number;
      pnl: number;
      opened_at: number;
      closed_at: number;
      reason: BotTradeRow['reason'];
      market: BotMarket | null;
      lev: number | null;
      sl: number | null;
      tp: number | null;
    }>(
      `SELECT TOP (${HISTORY_MAX_ROWS + 1}) t.id, t.bot_id, b.name, t.symbol, t.side, t.qty, t.entry, t.[exit], t.pnl, t.opened_at, t.closed_at, t.reason, t.market, t.lev, t.sl, t.tp
       FROM bot_trades t JOIN bots b ON b.id = t.bot_id WHERE b.user_id = ? AND t.account_id = ? AND t.closed_at >= ? ORDER BY t.closed_at DESC, t.id DESC`,
      [userId, accountId, from],
    );
    const rows: TradeHistoryRow[] = closed.map((t) => {
      const market = t.market ?? 'spot';
      // Spot has no leverage; an older DCA or grid trade's is not known.
      const lev = market === 'spot' ? 1 : t.lev;
      return {
        key: `b|${t.id}`,
        source: 'bot',
        bot: { id: t.bot_id, name: t.name },
        open: false,
        symbol: t.symbol,
        market: marketOf(market, lev, t.side),
        side: t.side,
        qty: t.qty,
        leverage: lev,
        entry: t.entry,
        exit: t.exit,
        sl: t.sl,
        tp: t.tp,
        pnl: t.pnl,
        pnlPct: lev === null ? null : pnlPercent(t.pnl, t.qty, t.entry, lev),
        // FIX-HISTAMOUNT: the value at entry over the leverage (spot: its cost); unknown for an older DCA / grid trade.
        margin: marginOf(t.qty, t.entry, lev),
        currency: botCurrency(market, [t.symbol]),
        openedAt: t.opened_at,
        closedAt: t.closed_at,
        reason: TRADE_REASON_RO[t.reason] ?? t.reason,
      };
    });
    for (const { row, run, positions } of await this.realPositions(userId)) {
      if (run.accountId !== accountId) continue;
      for (const [i, p] of positions.entries()) {
        const lev = run.market === 'spot' ? 1 : p.leverage;
        rows.push({
          key: `o|${row.id}|${i}`,
          source: 'bot',
          bot: { id: row.id, name: row.name },
          open: true,
          symbol: p.symbol,
          market: marketOf(run.market, lev, p.side),
          side: p.side,
          qty: p.qty,
          leverage: lev,
          entry: p.entry,
          exit: null,
          sl: p.sl,
          tp: p.tp,
          pnl: p.unrealized,
          pnlPct: pnlPercent(p.unrealized, p.qty, p.entry, lev),
          // FIX-HISTAMOUNT: the bot's own margin of the position.
          margin: p.margin > 0 ? p.margin : null,
          currency: botCurrency(run.market, [p.symbol]),
          openedAt: p.openedAt || null,
          closedAt: null,
          reason: null,
        });
      }
    }
    return rows;
  }

  /**
   * The positions the user's real bots hold now, each bot with the settings its positions run with (FD-BOTEDIT: in a
   * transition, the old account's) and their levels. A grid's open intervals together: the stop on the side it holds as
   * the stop loss, no take profit (its lines are many take profits).
   */
  private async realPositions(userId: number): Promise<{ row: BotRow; run: BotInput & { accountId: number }; positions: BotPositionView[] }[]> {
    const bots = await this.db.all<BotRow>(`SELECT ${COLUMNS} FROM bots WHERE user_id = ? AND status <> N'ended' ORDER BY id`, [userId]);
    const out: { row: BotRow; run: BotInput & { accountId: number }; positions: BotPositionView[] }[] = [];
    for (const row of bots) {
      const at = stateOf(row);
      if (!at) continue;
      const { run, st } = at;
      if (run.exec !== 'real' || run.accountId === null) continue;
      out.push({ row, run: { ...run, accountId: run.accountId }, positions: levelPositions(run, st) });
    }
    return out;
  }

  /** FIX-BOTLEVELS: the stop losses / take profits the user's real bots keep for the positions they hold (the chart's lines). */
  async levels(userId: number): Promise<BotLevel[]> {
    const out: BotLevel[] = [];
    for (const { row, run, positions } of await this.realPositions(userId)) {
      for (const p of positions) {
        const sl = level(p.sl);
        const tp = level(p.tp);
        if (!(p.qty > 0 && p.entry > 0) || (sl === null && tp === null)) continue;
        out.push({ bot: { id: row.id, name: row.name }, accountId: run.accountId, active: row.status !== 'problem', market: run.market, symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, sl, tp, openedAt: p.openedAt });
      }
    }
    return out;
  }

  async detail(userId: number, id: number): Promise<BotDetail> {
    const row = await this.own(userId, id);
    const input = parseInput(row);
    if (!input) throw new NotFoundError('Setările botului nu se mai pot citi.');
    // FIX-BOTDRAG: with the levels dragged on the chart that the engine has not read yet.
    const st = stateOf(row)?.st ?? parseState(row.state);
    const accounts = row.account_id !== null ? await this.accountsOf(userId) : new Map();
    const history = await this.db.all<{ id: number; symbol: string; side: 'long' | 'short'; qty: number; entry: number; exit: number; pnl: number; fees: number; opened_at: number; closed_at: number; reason: BotTradeRow['reason'] }>(
      'SELECT TOP (200) id, symbol, side, qty, entry, [exit], pnl, fees, opened_at, closed_at, reason FROM bot_trades WHERE bot_id = ? ORDER BY closed_at DESC, id DESC',
      [id],
    );
    const events = await this.db.all<{ id: number; at: number; kind: BotEventRow['kind']; symbol: string | null; message: string; detail: string | null }>(
      'SELECT TOP (300) id, at, kind, symbol, message, detail FROM bot_events WHERE bot_id = ? ORDER BY id DESC',
      [id],
    );
    const g = st.grid;
    const deal = st.dca?.deal ?? null;
    // FD-BOTEDIT: the open positions with the settings they run with; a transition under way, with what it waits for (not
    // on a bot that ends: the stop decides what becomes of them).
    const { run, changes } = runOf(input, st);
    const switching = row.status !== 'ending' && changes.length && (holdsPositions(st) || st.pending) ? { changes, mode: modeOf(input, parseCommand(row.command)?.positions ?? st.switchMode ?? undefined) } : null;
    return {
      ...this.view(row, accounts),
      input,
      switching,
      positions: exposure(run, st).positions,
      grid: g ? { lines: g.lines, qty: g.qty, armed: g.waiting !== null, trigger: g.waiting?.trigger ?? null, slots: g.slots.map((s) => ({ side: s.side, entry: s.entry })) } : null,
      dca:
        st.dca && run.strategy === 'dca'
          ? {
              cycle: st.dca.cycle,
              cooldownUntil: st.dca.cooldownUntil > this.now() ? st.dca.cooldownUntil : null,
              deal: deal ? { side: deal.side, basePrice: deal.basePrice, avg: dealAvg(deal), qty: deal.qty, filled: deal.filled, ...dealLevels(run.dca, deal), next: nextSafety(run.dca, deal) } : null,
            }
          : null,
      history: history.map((t) => ({ id: t.id, symbol: t.symbol, side: t.side, qty: t.qty, entry: t.entry, exit: t.exit, pnl: t.pnl, fees: t.fees, openedAt: t.opened_at, closedAt: t.closed_at, reason: t.reason })),
      events: events.map((e) => {
        let detail = null;
        try {
          detail = e.detail ? JSON.parse(e.detail) : null;
        } catch {
          detail = null;
        }
        return { id: e.id, at: e.at, kind: e.kind, symbol: e.symbol, message: e.message, detail };
      }),
    };
  }

  /**
   * The form's summary (FD-BOT §1): what the bot will do, the money it uses, and what is wrong with it. At an edit
   * (FD-BOTEDIT §4), also what becomes of the open positions, and the bot's own positions are not foreign.
   */
  async check(userId: number, input: BotInput, edit?: EditContext): Promise<BotCheck> {
    const now = this.now();
    const errors: string[] = [];
    const warnings: string[] = [];
    const summary: string[] = [];
    // FD-BOTEDIT: the edited bot's open positions (on their account and market), and whether the new settings keep them.
    const held = edit ? exposure(edit.basis, edit.st).positions : [];
    const changes = edit ? transitionOf(edit.basis, input) : [];
    const own = new Set(edit && edit.basis.exec === 'real' && edit.basis.accountId === input.accountId && edit.basis.market === input.market && !changes.length ? held.map((p) => p.symbol) : []);
    const conflict = await this.conflict(userId, input, edit?.row.id ?? null);
    if (conflict) errors.push(conflict);
    // FD-PAPER §7: a simulation runs on a Paper Trading profile (an account like the others), no longer apart.
    if (input.exec === 'paper') errors.push('Simularea se face acum cu un cont Paper Trading: alege-l la „Contul” (Tranzacții → Adaugă un cont → Paper Trading).');
    const tz = (await this.d.settings.forUser(userId)).timezone;
    const cur = botCurrency(input.market, input.symbols);
    const futures = input.market === 'futures';
    // FIX-PAPERLEV: on a Paper Trading profile every market has leverage, margin and shorts (as futures).
    const capsAll = input.exec === 'real' ? await this.d.trading.caps(userId) : [];
    const onPaper = capsAll.some((a) => a.accountId === input.accountId && isPaperExchange(a.exchange));
    const margined = futures || onPaper;
    const lev = margined ? input.leverage : 1;
    if (!margined && input.leverage !== 1) errors.push(LEVERAGE_FUTURES);
    if (!margined && input.marginMode !== 'isolated') errors.push(MARGIN_FUTURES);
    if (input.market === 'spot' && !onPaper && wantsShort(input)) errors.push(SPOT_LONG);

    // The prices (and so that every symbol exists where the prices come from).
    let price: number | null = null;
    for (const [i, sym] of input.symbols.entries()) {
      try {
        const q = await readQuote(this.d, userId, input.market, sym, false);
        if (i === 0 && q !== 'closed') price = q.price;
        // FIX-2ZPRICE: a thin pair's price is its last trade.
        if (q !== 'closed' && q.lastTrade)
          warnings.push(`Pe ${providerById(q.exchange ?? '')?.name ?? q.exchange}, ${sym} n-a avut tranzacții în ultimele minute: botul ia prețul ultimei tranzacții (${fmtPrice(q.price)}). La o pereche cu puține tranzacții, prețul de execuție poate fi departe de el.`);
      } catch (err) {
        if (input.market === 'stock') warnings.push(`Prețul lui ${sym} nu se poate citi acum (${(err as Error).message}).`);
        else errors.push(`${sym} nu se poate citi la sursa de prețuri: ${(err as Error).message}`);
      }
    }
    if (input.market === 'stock' && input.strategy === 'premium' && this.d.stocks) {
      for (const sym of input.symbols) {
        const allowed = await this.d.stocks.timeframesFor(sym, userId);
        if (!allowed.includes(input.tf)) errors.push(`${sym} pe ${input.tf} cere cheia ta Twelve Data (Setări → Date acțiuni); fără ea, botul merge pe 1d și 1w.`);
      }
    }

    // The account and its platform's minimums (real).
    let minCost: number | null = null;
    let minAmount: number | null = null;
    /** FIX-BOTMARGIN: the account sets the margin itself (Bybit). */
    let accountMargin = false;
    /** FD-PAPER: the account is a Paper Trading profile (its name and commission, for the summary). */
    let paperAccount: { label: string; commission: string } | null = null;
    if (input.exec === 'real') {
      const caps = capsAll.find((a) => a.accountId === input.accountId);
      const platform = caps ? (providerById(caps.exchange)?.name ?? caps.exchange) : '';
      if (caps && isPaperExchange(caps.exchange)) {
        const view = await this.d.accounts.view(caps.accountId);
        paperAccount = { label: caps.label, commission: view?.paper ? commissionText(view.paper.commissionType, view.paper.commissionValue) : '' };
      }
      const stocks = input.market === 'stock';
      if (!caps) errors.push('Contul ales nu există.');
      else if (caps.kind !== (stocks ? 'stocks' : 'crypto')) errors.push(stocks ? `${caps.label} nu e un cont de acțiuni.` : `${caps.label} nu e un cont crypto.`);
      else if (!caps.enabled) errors.push(`Tranzacționarea e oprită pe contul ${caps.label}: pornește-o din pagina Tranzacții.`);
      else if (!caps.markets.includes(input.market)) errors.push(`Contul ${caps.label} nu tranzacționează pe ${stocks ? 'acțiuni' : futures ? 'futures' : 'spot'} (pornește-o din Tranzacții, cu o cheie care are dreptul).`);
      else {
        // FD-BOT §10: shares go short only at eToro (Trading 212 has no short; Alpaca nets one position per symbol), and
        // eToro opens a short only with a stop loss.
        if (stocks) {
          const etoro = TRADING[caps.exchange as keyof typeof TRADING]?.etoro === true;
          const short = wantsShort(input);
          if (short && !etoro && !paperAccount) errors.push(`La ${platform}, botul face doar long: short pe acțiuni doar la eToro sau pe un profil Paper Trading.`);
          if (short && etoro && input.strategy === 'dca' && input.dca.stopLoss === null) errors.push('eToro cere stop loss la un short: pune stop loss-ul ciclului.');
          if (short && etoro && input.strategy === 'grid' && input.grid.stopAbove === null) errors.push('eToro cere stop loss la un short: pune „Oprește peste” (e stop loss-ul fiecărui interval short).');
          warnings.push('Pe acțiuni, botul tranzacționează doar cât bursa e deschisă (sesiunea obișnuită). Sumele lui sunt în USD; un cont în altă monedă plătește în moneda lui.');
        }
        for (const sym of input.symbols) {
          const tradeSym = futures ? perpetualOf(sym) : sym;
          try {
            const info = await this.d.trading.instrument(userId, input.accountId as number, input.market, tradeSym);
            if (sym === input.symbols[0]) {
              minCost = info.minCost;
              minAmount = info.minAmount;
              // FIX-BOTMARGIN: the margin the account takes from Sentiq (the unified accounts: Cross only; Bybit: its own).
              accountMargin = margined && info.marginModes === null;
              if (accountMargin) warnings.push(`Pe ${platform}, marja e cea aleasă în contul ${platform}: botul nu o schimbă.`);
              else if (margined && info.marginModes && !info.marginModes.includes(input.marginMode))
                errors.push(`Pe ${platform}, contul acesta ia din Sentiq ordine futures doar cu marjă ${info.marginModes.map((m) => MARGIN_RO[m]).join(' / ')}: alege „${MARGIN_RO[info.marginModes[0] as BotMarginMode]}” la „Marja”.`);
            }
            if (margined && info.maxLeverage !== null && input.leverage > info.maxLeverage) errors.push(`Levierul maxim pe ${tradeSym} e ${info.maxLeverage}×.`);
            // FD-BOT §9: on one-way futures the bot would mix with a position that is not its own; it waits for it to go.
            if (futures && !own.has(sym) && (info.position || info.hedgePositions?.long || info.hedgePositions?.short)) warnings.push(`Pe ${tradeSym} e deja o poziție deschisă: botul nu intră cât timp ea e acolo (s-ar amesteca cu a lui). Nu deschide de mână poziții pe simbolul unui bot.`);
          } catch (err) {
            errors.push(`${platform} nu are ${tradeSym}${futures ? ' pe futures' : ''}: ${(err as Error).message}`);
          }
        }
      }
      if (!paperAccount) warnings.push(`Botul trimite ordine reale și închide pozițiile el însuși, la piață. Cu serverul Sentiq oprit, nu poate închide nimic: pierderea pe zi${futures ? ', oprirea la o pierdere și levierul limitează' : ' și oprirea la o pierdere limitează'} riscul.`);
    }
    if (margined && input.leverage > 10) warnings.push(`Levier ${input.leverage}×: o mișcare de ${fmtNum(100 / input.leverage)}% împotriva poziției îi consumă marja.`);

    // What the strategy will do.
    let capital = input.maxAmount;
    let grid: BotCheck['grid'] = null;
    let dca: BotCheck['dca'] = null;
    if (input.strategy === 'grid') {
      const g = input.grid;
      const at = price ?? (g.lower + g.upper) / 2;
      grid = gridPlan(g, input.maxAmount, lev, input.fee, at);
      summary.push(
        `Între ${fmtPrice(g.lower)} și ${fmtPrice(g.upper)}, ${g.grids} grile ${g.spacing === 'geometric' ? 'geometrice' : 'aritmetice'}: ${fmtNum(grid.qty, 8)} ${input.market === 'stock' ? 'acțiuni' : (input.symbols[0]?.split('/')[0] ?? '')} pe grilă, câștig pe grilă ${fmtNum(grid.profit.min)}–${fmtNum(grid.profit.max)}% după comisioane.`,
      );
      // FD-BOTEDIT §4: a grid that goes on (no transition) is not started again.
      const going = edit && !changes.length ? edit.st.grid : null;
      if (going?.waiting) summary.push(`Grila așteaptă în continuare prețul de pornire (${fmtPrice(going.waiting.trigger)}).`);
      else if (going?.started) summary.push('Grila merge mai departe cu intervalele ei.');
      else {
        if (g.direction === 'neutral') summary.push('Pornește fără poziție: long sub preț, short peste el.');
        else if (price !== null) summary.push(grid.atStart > 0 ? `La pornire ${g.direction === 'long' ? 'cumpără' : 'vinde'} ${grid.atStart} ${grid.atStart === 1 ? 'grilă' : 'grile'} la piață (${fmtNum(grid.startCost)} ${cur}${margined ? ' marjă' : ''}).` : 'La pornire nu e nimic de cumpărat: prețul e peste grilă.');
        if (g.trigger !== null) summary.push(`Așteaptă până când prețul atinge ${fmtPrice(g.trigger)}.`);
      }
      // FD-BOTEDIT §2: a stop the price is already past closes everything.
      const past = price === null ? null : g.stopBelow !== null && price <= g.stopBelow ? `sub „Oprește sub” (${fmtPrice(g.stopBelow)})` : g.stopAbove !== null && price >= g.stopAbove ? `peste „Oprește peste” (${fmtPrice(g.stopAbove)})` : null;
      if (past) warnings.push(`Prețul de acum (${fmtPrice(price as number)}) e deja ${past}: ${going?.started ? 'la următoarea verificare' : 'imediat după pornire'}, botul închide tot și se încheie.`);
      if (g.stopBelow !== null || g.stopAbove !== null) summary.push(`Se oprește și închide tot ${[g.stopBelow !== null ? `sub ${fmtPrice(g.stopBelow)}` : '', g.stopAbove !== null ? `peste ${fmtPrice(g.stopAbove)}` : ''].filter(Boolean).join(' sau ')}.`);
      if (price !== null && (price < g.lower || price > g.upper)) warnings.push(`Prețul de acum (${fmtPrice(price)}) e în afara grilei: botul nu face nimic până intră în ea.`);
      if (minCost !== null && grid.minOrder < minCost) errors.push(`Ordinul unei grile (${fmtNum(grid.minOrder)} ${cur}) e sub minimul platformei (${fmtNum(minCost)} ${cur}): mai puține grile sau o sumă mai mare.`);
      if (minAmount !== null && grid.qty < minAmount) errors.push(`Cantitatea pe grilă (${fmtNum(grid.qty, 8)}) e sub minimul platformei (${minAmount}): mai puține grile sau o sumă mai mare.`);
    } else if (input.strategy === 'dca') {
      const d = input.dca;
      dca = dcaPlan(d, price ?? 1, lev);
      capital = dca.at(-1)?.total ?? d.baseOrder;
      const last = dca.at(-1);
      summary.push(
        `Ordinul de bază ${fmtNum(d.baseOrder)} ${cur}${d.safetyOrders ? `, apoi ${d.safetyOrders} ${d.safetyOrders === 1 ? 'ordin' : 'ordine'} de siguranță până la ${d.direction === 'long' ? '−' : '+'}${fmtNum(last?.deviation ?? 0)}%` : ''}; take profit ${fmtNum(d.takeProfit)}% din prețul mediu${d.stopLoss !== null ? `, stop loss ${fmtNum(d.stopLoss)}% din prețul de bază` : ''}.`,
      );
      summary.push(`Capitalul unui ciclu: ${fmtNum(capital)} ${cur}${margined ? ` (marjă, poziția până la ${fmtNum(capital * lev)} ${cur})` : ''}. ${d.repeat ? `Ciclurile se repetă${d.maxCycles !== null ? `, cel mult ${d.maxCycles}` : ''}${d.cooldownMin ? `, cu ${d.cooldownMin} min pauză` : ''}.` : 'Un singur ciclu.'}`);
      if (price === null) dca = null;
      const smallest = Math.min(d.baseOrder, d.safetyOrders ? d.safetyOrder : Infinity) * lev;
      if (minCost !== null && smallest < minCost) errors.push(`Cel mai mic ordin (${fmtNum(smallest)} ${cur}) e sub minimul platformei (${fmtNum(minCost)} ${cur}).`);
    } else {
      const p = input.premium;
      const dirRo = p.direction === 'both' ? 'long și short' : p.direction;
      // FD-BOTDIR: each side with its threshold on the market's score.
      const when = p.direction === 'both' ? `: long când scorul pieței e cel puțin ${p.longMin}, short când e cel mult ${p.shortMax}` : p.direction === 'long' ? `, când scorul pieței e cel puțin ${p.longMin}` : `, când scorul pieței e cel mult ${p.shortMax}`;
      // FIX-BOTSHORTS: at the setup (its levels moved at the confirmation), or on the confirmed signal.
      const at =
        p.entry === 'setup'
          ? `Intră la setup-ul Slingshot ${dirRo} de pe ${input.tf}, la închiderea primei lumânări cu setup-ul în formare${when}${p.levels === 'slingshot' ? '; stop loss-ul stă la V1 (unde Slingshot anulează setup-ul), iar la confirmare SL / TP-ul se mută la cele ale semnalului' : ''}.`
          : `Intră pe semnalele Slingshot ${dirRo} confirmate de pe ${input.tf}${when}.`;
      summary.push(`${at}${p.ai === 'confirm' ? ' AI-ul confirmă fiecare intrare.' : ''}`);
      const reach = scoreReach(p.weights);
      if (p.direction !== 'short' && p.longMin > reach) warnings.push(`Cu ponderile alese, scorul pieței ajunge cel mult la ${fmtNum(reach, 1)}: cu minimul ${p.longMin}, botul nu intră niciodată long.`);
      if (p.direction !== 'long' && p.shortMax < 100 - reach) warnings.push(`Cu ponderile alese, scorul pieței coboară cel mult până la ${fmtNum(100 - reach, 1)}: cu maximul ${p.shortMax}, botul nu intră niciodată short.`);
      // FIX-BOTBUDGET: the budget, the most a trade takes, the open trades' maximum, and how the bot shares the budget.
      const perTrade = Math.min(p.maxPerTrade, input.maxAmount);
      const room = Math.min(p.maxOpen, input.symbols.length);
      summary.push(
        `Bugetul: ${fmtNum(input.maxAmount)} ${cur}; pe tranzacție cel mult ${fmtNum(perTrade)} ${cur}${margined && lev > 1 ? ` (poziția până la ${fmtNum(perTrade * lev)} ${cur}, la ${lev}×)` : ''}; cel mult ${room} ${room === 1 ? 'tranzacție deschisă' : 'tranzacții deschise'} odată${p.maxOpen > input.symbols.length ? ` (câte simboluri are botul)` : ''}. Botul împarte bugetul liber între tranzacțiile pe care le mai poate deschide${p.ai === 'confirm' ? ', iar AI-ul alege suma fiecăreia în interval' : ''}; nu intră într-o tranzacție care la take profit ar aduce mai puțin de ${MIN_TRADE_PROFIT} USD după comisioane. ${p.levels === 'slingshot' ? 'SL și TP: ale semnalului Slingshot.' : `SL ${fmtNum(p.slPct)}% și TP ${fmtNum(p.tpPct)}% de la intrare (risc : câștig ${rrText(p.slPct, p.tpPct)}).`}`,
      );
      // FIX-BOTBUDGET: how far the take profit must be for the most a trade takes to bring the minimum (in dollars).
      if (isUsdQuote(cur) && perTrade > 0) {
        const needPct = (MIN_TRADE_PROFIT / (perTrade * lev)) * 100 + 2 * input.fee;
        if (p.levels === 'percent' && p.tpPct < needPct)
          warnings.push(`Cu suma maximă pe tranzacție (${fmtNum(perTrade)} ${cur}${lev > 1 ? `, la ${lev}×` : ''}), take profit-ul de ${fmtNum(p.tpPct)}% aduce cel mult ${fmtNum((perTrade * lev * (p.tpPct - 2 * input.fee)) / 100)} ${cur} după comisioane: sub ${MIN_TRADE_PROFIT} USD, deci botul nu intră.`);
        if (p.levels === 'slingshot') summary.push(`Ca o tranzacție să aducă ${MIN_TRADE_PROFIT} USD, take profit-ul semnalului trebuie să fie la cel puțin ${fmtNum(needPct, 2)}% de la intrare (cu suma maximă pe tranzacție); la unul mai aproape, botul nu intră.`);
      }
      if (p.ai === 'confirm' && !(await this.d.ai.config(userId)).key) warnings.push(`„AI confirmă” cere o cheie AI (Setări → AI): fără ea, ${p.aiFallback === 'skip' ? 'botul nu intră deloc' : 'intrările merg după reguli'}.`);
      if (minCost !== null && perTrade * lev < minCost) errors.push(`O tranzacție de ${fmtNum(perTrade * lev)} ${cur} e sub minimul platformei (${fmtNum(minCost)} ${cur}).`);
    }

    // FIX-BOTMARGIN: the margin of the positions (Bybit's account has its own: said in the warnings).
    const hint = (onPaper ? MARGIN_HINT_PAPER_RO : MARGIN_HINT_RO)[input.marginMode];
    if (margined && !accountMargin) summary.push(`Marja: ${MARGIN_RO[input.marginMode]} (${hint.charAt(0).toLowerCase()}${hint.slice(1, -1)}).`);

    // The period (FD-BOTEDIT §4: a bot that has started, only its end).
    const when = (t: number) => new Intl.DateTimeFormat('ro-RO', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(t);
    const start = input.startsAt !== null && input.startsAt > now ? input.startsAt : null;
    const started = edit !== undefined && edit.row.status !== 'scheduled';
    const until = input.endsAt !== null ? `până pe ${when(input.endsAt)}; la sfârșit: ${END_ACTION_RO[input.endAction].toLowerCase()}` : 'fără sfârșit';
    if (input.endsAt !== null && input.endsAt <= now && (!edit || input.endsAt !== parseInput(edit.row)?.endsAt)) errors.push('Sfârșitul e în trecut.');
    summary.push(started ? `${until.charAt(0).toUpperCase()}${until.slice(1)}.` : `${start !== null ? `Pornește pe ${when(start)}` : 'Pornește acum'}, ${until}.`);
    if (input.dailyLoss !== null || input.lossStop !== null)
      summary.push([input.dailyLoss !== null ? `După o pierdere de ${fmtNum(input.dailyLoss)} ${cur} într-o zi, nicio intrare până a doua zi.` : '', input.lossStop !== null ? `La o pierdere de ${fmtNum(input.lossStop)} ${cur}, închide tot și se oprește.` : ''].filter(Boolean).join(' '));
    if (paperAccount) summary.push(`Paper Trading: ordinele merg în profilul „${paperAccount.label}”${paperAccount.commission ? ` (comision ${paperAccount.commission})` : ''}; niciun ordin real.`);
    const transition = edit ? await this.transition(userId, input, edit, changes, held.length, summary, errors) : undefined;
    return { price, capital, errors, warnings, summary, grid, dca, ...(edit ? { transition } : {}) };
  }

  /**
   * FD-BOTEDIT §3–§4: what the edit does to the open positions, said in the summary. Without a transition they go on (a
   * Slingshot symbol taken out keeps its position until it exits; the maximum cannot go under what is in play).
   */
  private async transition(userId: number, input: BotInput, edit: EditContext, changes: string[], open: number, summary: string[], errors: string[]): Promise<BotTransition | null> {
    const { st, basis } = edit;
    // Right after a deploy (FD-BOTEDIT §5): the engine has not noted the settings of the open positions yet; it would take
    // the new ones for them (a transition missed, a DCA cycle's leverage changed).
    if (!basisOf(st) && (holdsPositions(st) || st.pending !== null) && (changes.length || (input.strategy === 'dca' && input.leverage !== basis.leverage)))
      errors.push('Botul se pregătește pentru setări noi; încearcă din nou peste 30 de secunde.');
    if (!changes.length) {
      if (input.strategy !== 'grid') {
        const { committed } = exposure(basis, st);
        if (input.maxAmount < committed - 1e-9) errors.push(`Suma maximă nu poate coborî sub cât e angajat acum (${fmtNum(committed)}).`);
      }
      const out = [...new Set((st.premium?.positions ?? []).map((p) => p.symbol))].filter((s) => !input.symbols.includes(s));
      if (out.length) summary.push(`${out.join(', ')}: ${out.length === 1 ? 'scos din bot; poziția lui deschisă iese' : 'scoase din bot; pozițiile lor deschise ies'} după regulile ${out.length === 1 ? 'ei' : 'lor'}, fără intrări noi, apoi ${out.length === 1 ? 'simbolul dispare' : 'simbolurile dispar'} din bot.`);
      return null;
    }
    // A grid's intervals count one by one; an order on its way is something open too.
    const n = st.grid ? st.grid.slots.filter((s) => s.entry !== null).length : open;
    const pending = st.pending !== null;
    const grid = input.strategy === 'grid';
    // The choice already made for a transition under way stays the default (another edit does not change it unseen).
    const mode = modeOf(input, edit.positions ?? parseCommand(edit.row.command)?.positions ?? st.switchMode ?? undefined);
    const what = changes.join('; ');
    if (n === 0 && !pending) {
      summary.push(`Setările noi (${what}) se aplică la următoarea verificare (≤ 30 s)${grid ? ': grila se face din nou de la prețul de atunci' : ''}.`);
      return { changes, open: 0, modes: [], mode };
    }
    let where = '';
    if (basis.exec === 'real') {
      const acc = basis.accountId !== null ? (await this.accountsOf(userId)).get(basis.accountId) : undefined;
      where = acc && isPaperExchange(acc.exchange) ? `, pe profilul Paper Trading ${acc.label}` : `, cu ordine reale pe contul ${acc?.label ?? 'vechi'}`;
    }
    const what1 = grid ? (n === 1 ? 'intervalul plin' : `cele ${n} intervale pline`) : n === 1 ? 'poziția deschisă acum' : `cele ${n} poziții deschise acum`;
    summary.push(
      mode === 'close'
        ? `Pentru setările noi (${what}), botul închide la piață ${what1}${where} la următoarea verificare (≤ 30 s), apoi ${grid ? 'face grila nouă de la prețul de atunci' : 'merge cu setările noi'}.`
        : `Pentru setările noi (${what}), ${what1} se termină întâi cu setările vechi${where}; botul nu deschide nimic nou până atunci, apoi merge cu cele noi.`,
    );
    if (pending) summary.push('Un ordin pe drum se termină întâi, cu aceeași cheie.');
    return { changes, open: n, modes: grid ? ['close'] : ['finish', 'close'], mode };
  }

  /** FD-BOTEDIT §4: another active real bot on the account, market and symbol (its settings', or its open positions'). */
  private async conflict(userId: number, input: BotInput, except: number | null): Promise<string | null> {
    if (input.exec !== 'real') return null;
    const rows = await this.db.all<{ id: number; name: string; config: string; state: string }>("SELECT id, name, config, state FROM bots WHERE user_id = ? AND status <> N'ended'", [userId]);
    for (const b of rows) {
      if (b.id === except) continue;
      const places = inPlay(parseInput(b), parseState(b.state));
      const shared = input.symbols.find((s) => places.some((p) => p.accountId === input.accountId && p.market === input.market && p.symbol === s));
      if (shared) return `Botul „${b.name}” tranzacționează deja ${shared} pe acest cont: doi boți s-ar încurca pe aceeași poziție.`;
    }
    return null;
  }

  /** An edit's context; the bot must not have ended. */
  private async editContext(userId: number, id: number, positions: PositionsMode | undefined): Promise<EditContext & { current: BotInput }> {
    const row = await this.own(userId, id);
    if (row.status === 'ended') throw new ConflictError('Botul s-a încheiat: nu se mai poate edita. „Duplică” face unul nou.');
    const current = parseInput(row);
    if (!current) throw new ConflictError('Setările botului nu se mai pot citi.');
    const st = parseState(row.state);
    return { row, st, basis: basisOf(st) ?? current, positions, current };
  }

  /** FD-BOTEDIT: the new settings of an edit, checked as a new bot's; the type, the area and a start that happened stay. */
  private nextOf(ctx: EditContext & { current: BotInput }, next: BotInput): BotInput {
    if (next.strategy !== ctx.row.strategy) throw new ValidationError('Tipul botului nu se schimbă: „Duplică” face un bot nou.');
    if (areaOf(next.market) !== ctx.row.area) throw new ValidationError('Aria botului (crypto sau acțiuni) nu se schimbă: „Duplică” face un bot nou.');
    const now = this.now();
    const startsAt = ctx.row.status === 'scheduled' ? (next.startsAt !== null && next.startsAt > now ? next.startsAt : now) : ctx.current.startsAt;
    const r = botInputSchema.safeParse({ ...next, startsAt });
    if (!r.success) throw new ValidationError(`Setări invalide: ${formatIssues(r.error.issues)}`, r.error.issues);
    return r.data;
  }

  /** The edit form's check (POST /api/bots/:id/check). */
  async checkEdit(userId: number, id: number, e: BotEdit): Promise<BotCheck> {
    const ctx = await this.editContext(userId, id, e.positions);
    return this.check(userId, this.nextOf(ctx, e.input), ctx);
  }

  async create(userId: number, input: BotInput): Promise<BotDetail> {
    const now = this.now();
    const active = (await this.db.get<{ n: number }>("SELECT count(*) AS n FROM bots WHERE user_id = ? AND status <> N'ended'", [userId]))?.n ?? 0;
    if (active >= MAX_ACTIVE_BOTS) throw new ConflictError(`Cel mult ${MAX_ACTIVE_BOTS} boți activi: oprește sau șterge unul.`);
    const conflict = await this.conflict(userId, input, null);
    if (conflict) throw new ConflictError(conflict);
    const check = await this.check(userId, input);
    if (check.errors.length) throw new ValidationError(check.errors.join(' '));
    const startsAt = input.startsAt !== null && input.startsAt > now ? input.startsAt : now;
    const stored: BotInput = { ...input, startsAt };
    const status = startsAt > now ? 'scheduled' : 'running';
    const id = await this.db.tx(async () => {
      const r = await this.db.run(
        `INSERT INTO bots(user_id, name, strategy, execution, account_id, market, area, symbols, tf, config, status, state, starts_at, ends_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, input.name, input.strategy, input.exec, input.accountId, input.market, areaOf(input.market), JSON.stringify(input.symbols), input.tf, JSON.stringify(stored), status, JSON.stringify({ ...newState(check.price), basis: stored }), startsAt, input.endsAt, now, now],
      );
      const botId = r.lastInsertRowid;
      const when = new Intl.DateTimeFormat('ro-RO', { timeZone: (await this.d.settings.forUser(userId)).timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(startsAt);
      await this.db.run('INSERT INTO bot_events(bot_id, at, kind, symbol, message, detail) VALUES (?, ?, ?, NULL, ?, NULL)', [
        botId,
        now,
        status === 'running' ? 'start' : 'info',
        status === 'running' ? `Botul ${STRATEGY_RO[input.strategy]} a pornit.` : `Botul e programat să pornească pe ${when}.`,
      ]);
      return botId;
    });
    return this.detail(userId, id);
  }

  /**
   * FD-BOTEDIT: every setting; what the open positions cannot keep waits for them (the engine, `state.basis`). A page from
   * before the deploy sends the old patch: it applies over the settings.
   */
  async edit(userId: number, id: number, e: BotEdit | BotPatch): Promise<BotDetail> {
    const body = 'input' in e ? e : null;
    const ctx = await this.editContext(userId, id, body?.positions);
    const next = this.nextOf(ctx, body ? body.input : this.patched(ctx.current, e as BotPatch));
    const check = await this.check(userId, next, ctx);
    if (check.errors.length) throw new ValidationError(check.errors.join(' '));
    const t = check.transition ?? null;
    const now = this.now();
    const set = 'name = ?, execution = ?, account_id = ?, market = ?, symbols = ?, tf = ?, config = ?, starts_at = ?, ends_at = ?, updated_at = ?';
    const values: SqlValue[] = [next.name, next.exec, next.accountId, next.market, JSON.stringify(next.symbols), next.tf, JSON.stringify(next), next.startsAt, next.endsAt, now];
    // The choice for the open positions goes with the settings, in one write (the engine reads both at its next look).
    const changed = t?.modes.length ? await this.writeCommand(id, userId, { positions: t.mode }, set, values, "status <> N'ended'") : (await this.db.run(`UPDATE bots SET ${set} WHERE id = ? AND user_id = ? AND status <> N'ended'`, [...values, id, userId])).changes > 0;
    if (!changed) throw new ConflictError('Botul s-a încheiat între timp.');
    const more = t?.modes.length ? ` Pozițiile deschise cu setările vechi ${t.mode === 'close' ? 'se închid la piață' : 'se termină întâi'} (${t.changes.join('; ')}), apoi botul merge cu cele noi.` : '';
    await this.event(id, 'info', `Setările au fost schimbate.${more}`);
    return this.detail(userId, id);
  }

  /** Before FD-BOTEDIT, the edit's patch: over the bot's settings (checked after). */
  private patched(current: BotInput, e: BotPatch): BotInput {
    if (e.premium !== undefined && current.strategy !== 'premium') throw new ValidationError('Doar un bot Slingshot are aceste setări.');
    const next: Record<string, unknown> = { ...current, name: e.name, endsAt: e.endsAt, endAction: e.endAction, dailyLoss: e.dailyLoss, lossStop: e.lossStop, fee: e.fee };
    if (e.maxAmount !== undefined) next.maxAmount = e.maxAmount;
    if (e.leverage !== undefined) next.leverage = e.leverage;
    if (e.premium !== undefined) next.premium = e.premium;
    if (e.tf !== undefined) next.tf = e.tf;
    return next as BotInput;
  }

  /**
   * The API's command merged with one the engine has not read yet (FD-BOTEDIT: an edit's choice for the positions and a
   * stop or a "Reia" go together), written only if it did not change meanwhile; with more columns and a condition.
   */
  private async writeCommand(id: number, userId: number, patch: BotCommand | ((current: BotCommand) => BotCommand), set: string, values: SqlValue[], where: string): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      const row = await this.db.get<{ command: string | null }>('SELECT command FROM bots WHERE id = ? AND user_id = ?', [id, userId]);
      if (!row) return false;
      const current = parseCommand(row.command) ?? {};
      const command = JSON.stringify({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
      const r = await this.db.run(`UPDATE bots SET ${set ? `${set}, ` : ''}command = ? WHERE id = ? AND user_id = ? AND ISNULL(command, N'') = ? AND ${where}`, [...values, command, id, userId, row.command ?? '']);
      if (r.changes) return true;
    }
    return false;
  }

  /**
   * FIX-BOTDRAG: a stop loss / take profit of a real bot's open position dragged on the chart. A Slingshot position's or
   * a DCA cycle's goes to the engine (the command: it applies them at its next look; the chart shows them at once); a
   * grid's stop is its setting. Answers with the levels as the chart draws them.
   */
  async moveLevel(userId: number, id: number, move: BotLevelMove): Promise<BotLevel[]> {
    const row = await this.own(userId, id);
    if (row.status === 'ended') throw new ConflictError('Botul s-a încheiat.');
    const at = stateOf(row);
    if (!at) throw new ConflictError('Setările botului nu se mai pot citi.');
    const { input, run, changes, st } = at;
    if (run.exec !== 'real' || run.accountId === null) throw new ConflictError('Doar nivelurile unui bot real sunt pe grafic.');
    const grid = run.strategy === 'grid';
    const pos = levelPositions(run, st).find((p) => p.symbol === move.symbol && p.side === move.side && (grid || p.openedAt === move.openedAt));
    if (!pos) throw new ConflictError('Poziția botului s-a închis între timp.');
    const long = move.side === 'long';
    const side = long ? 'long' : 'short';
    const price = st.prices[move.symbol]?.p ?? null;
    const errors: string[] = [];
    if (price !== null && move.sl !== undefined && (long ? move.sl >= price : move.sl <= price)) errors.push(`Stop loss-ul unui ${side} trebuie să fie ${long ? 'sub' : 'peste'} prețul curent (${fmtPrice(price)}).`);
    if (price !== null && move.tp !== undefined && (long ? move.tp <= price : move.tp >= price)) errors.push(`Take profit-ul unui ${side} trebuie să fie ${long ? 'peste' : 'sub'} prețul curent (${fmtPrice(price)}).`);
    if (grid && move.tp !== undefined) errors.push('O grilă nu are take profit: fiecare grilă se închide la linia ei.');
    if (errors.length) throw new ValidationError(errors.join(' '));
    const now = this.now();
    const what = [
      ...(move.sl !== undefined ? [`SL ${move.symbol} ${side} ${pos.sl !== null ? `${fmtPrice(pos.sl)} → ` : ''}${fmtPrice(move.sl)}`] : []),
      ...(move.tp !== undefined ? [`TP ${move.symbol} ${side} ${pos.tp !== null ? `${fmtPrice(pos.tp)} → ` : ''}${fmtPrice(move.tp)}`] : []),
    ];
    if (grid) {
      if (input.strategy !== 'grid' || changes.length) throw new ConflictError('Botul închide grila veche (setări noi): stop-ul ei nu se mai mută.');
      const r = botInputSchema.safeParse({ ...input, grid: { ...input.grid, [long ? 'stopBelow' : 'stopAbove']: move.sl } });
      if (!r.success) throw new ValidationError(r.error.issues.map((i) => i.message).join(' '), r.error.issues);
      const w = await this.db.run("UPDATE bots SET config = ?, updated_at = ? WHERE id = ? AND user_id = ? AND config = ? AND status <> N'ended'", [JSON.stringify(r.data), now, id, userId, row.config]);
      if (!w.changes) throw new ConflictError('Setările botului s-au schimbat între timp: trage din nou.');
      await this.event(id, 'info', `Mutat de pe grafic: „${long ? 'Oprește sub' : 'Oprește peste'}” ${what.join(', ').replace(/^SL /, '')}.`);
      return this.levels(userId);
    }
    // The same position's moves not read yet: the last one counts.
    const same = (m: BotLevelMove) => m.symbol === move.symbol && m.side === move.side && m.openedAt === move.openedAt;
    const ok = await this.writeCommand(
      id,
      userId,
      (cur) => {
        const prev = cur.levels?.find(same);
        return { levels: [...(cur.levels ?? []).filter((m) => !same(m)), { ...prev, ...move }] };
      },
      'updated_at = ?',
      [now],
      "status <> N'ended'",
    );
    if (!ok) throw new ConflictError('Botul s-a încheiat între timp.');
    await this.event(id, 'info', `Mutat de pe grafic: ${what.join(', ')}.`);
    return this.levels(userId);
  }

  async pause(userId: number, id: number): Promise<BotDetail> {
    await this.own(userId, id);
    const r = await this.db.run("UPDATE bots SET status = N'paused', status_reason = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND status IN (N'running', N'scheduled')", [this.now(), id, userId]);
    if (!r.changes) throw new ConflictError('Botul nu se poate pune pe pauză acum.');
    await this.event(id, 'info', 'Pus pe pauză: nicio intrare nouă; ieșirile continuă.');
    return this.detail(userId, id);
  }

  async resume(userId: number, id: number): Promise<BotDetail> {
    await this.own(userId, id);
    const now = this.now();
    const ok = await this.writeCommand(id, userId, { clearPending: true }, "status = CASE WHEN starts_at > ? THEN N'scheduled' ELSE N'running' END, status_reason = NULL, updated_at = ?", [now, now], "status IN (N'paused', N'problem')");
    if (!ok) throw new ConflictError('Botul nu e pe pauză.');
    await this.event(id, 'info', 'Reluat.');
    return this.detail(userId, id);
  }

  async stop(userId: number, id: number, action: BotEndAction): Promise<BotDetail> {
    const row = await this.own(userId, id);
    if (row.strategy === 'grid' && action === 'finish') throw new ValidationError('O grilă nu are tranzacții de terminat: alege „Închide pozițiile” sau „Lasă pozițiile deschise”.');
    const ok = await this.writeCommand(id, userId, { end: action, reason: 'Oprit de utilizator.' }, "status = N'ending', status_reason = NULL, updated_at = ?", [this.now()], "status <> N'ended'");
    if (!ok) throw new ConflictError('Botul s-a încheiat deja.');
    await this.event(id, 'info', `Oprire cerută: ${END_ACTION_RO[action].toLowerCase()}.`);
    return this.detail(userId, id);
  }

  async remove(userId: number, id: number): Promise<void> {
    await this.own(userId, id);
    const r = await this.db.run("DELETE FROM bots WHERE id = ? AND user_id = ? AND status = N'ended'", [id, userId]);
    if (!r.changes) throw new ConflictError('Doar un bot încheiat se poate șterge: oprește-l întâi.');
  }

  private async event(id: number, kind: BotEventRow['kind'], message: string): Promise<void> {
    await this.db.run('INSERT INTO bot_events(bot_id, at, kind, symbol, message, detail) VALUES (?, ?, ?, NULL, ?, NULL)', [id, this.now(), kind, message]);
  }
}

/** FD-BOTEDIT §3: how a transition's positions end: a grid's close, the others' as chosen (by default, they finish). */
function modeOf(input: BotInput, chosen: PositionsMode | undefined): PositionsMode {
  return input.strategy === 'grid' ? 'close' : (chosen ?? 'finish');
}
