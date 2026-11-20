// What the engine keeps of a bot between two looks (TD-BOT §4), in `bots.state`: only the engine writes it.
import { botInputSchema, type BotEndAction, type BotInput, type BotLevelMove, type BotMarginMode, type BotMarket, type BotSide, type BotTradeReason, type PositionsMode } from '../../shared/bot.ts';
import type { Timeframe } from '../../shared/time.ts';

export interface BotPosition {
  symbol: string;
  side: BotSide;
  /** In the asset. */
  qty: number;
  entry: number;
  /** What it uses: the margin on futures, the cost on spot. */
  margin: number;
  lev: number;
  /** The entry's fee (the exit's is added at the close). */
  fees: number;
  openedAt: number;
  sl: number | null;
  tp: number | null;
  /** Premium: the time of the signal it entered on (its V2 bar), to find what became of it. */
  signalTime?: number;
  /** FIX-BOTMARGIN: the futures margin it opened with (its close keeps it); absent before it: the pair's. */
  mm?: BotMarginMode;
  /**
   * FIX-BOTSHORTS: entered on a Slingshot setup still forming. `start`: the time its V2 search started (the same setup
   * while its V2 moves); `sl` / `tp`: the levels it entered with (one moved on the chart since then stays the user's).
   * Gone at the confirmation (the position then follows the signal) or when the setup is cancelled.
   */
  setup?: PositionSetup;
}

export interface PositionSetup {
  start: number;
  sl: number;
  tp: number;
  /** FIX-BOTV1STOP: the setup's V1 (where Slingshot cancels it): the stop with "Slingshot". */
  v1?: number;
}

export interface GridSlot {
  side: BotSide;
  /** The price it was filled at; null while empty. */
  entry: number | null;
  openedAt: number | null;
  fees: number;
}

export interface GridState {
  lines: number[];
  qty: number;
  lev: number;
  /** FIX-BOTMARGIN: the futures margin of all its orders; absent on a grid from before it: the pair's. */
  mm?: BotMarginMode;
  /** Waiting for the start price (above: the price has to rise to it). */
  waiting: { trigger: number; above: boolean } | null;
  started: boolean;
  slots: GridSlot[];
}

export interface DcaDeal {
  side: BotSide;
  basePrice: number;
  /** Safety orders filled. */
  filled: number;
  qty: number;
  /** Σ price × qty (the average is cost / qty). */
  cost: number;
  margin: number;
  fees: number;
  openedAt: number;
  /** FD-BOTEDIT §2: the cycle's leverage (its safety orders keep it when the settings change); absent before it. */
  lev?: number;
  /** FIX-BOTMARGIN: the cycle's futures margin (its safety orders and its close keep it); absent before it: the pair's. */
  mm?: BotMarginMode;
  /** FIX-BOTDRAG: the levels moved on the chart; the cycle keeps them until it closes (else they come from the settings). */
  sl?: number;
  tp?: number;
}

export interface DcaState {
  cycle: number;
  cooldownUntil: number;
  /** No more cycles (the limit reached, or a stop loss that stops). */
  done: boolean;
  deal: DcaDeal | null;
}

export interface PremiumState {
  /**
   * The timeframe `lastBar`, `nextRead` and the positions' `signalTime` are on (FD-BOTTF): another one in the settings
   * starts the bars again. Absent in the states from before it: the bot's own, adopted at the first look.
   */
  tf?: Timeframe;
  /** The time of the last closed bar read, per symbol. */
  lastBar: Record<string, number>;
  /** Not before this, the candles are read again (a bar is not due yet, or the market is closed). */
  nextRead: Record<string, number>;
  positions: BotPosition[];
  cooldownUntil: number;
  /** AI questions asked today (UTC day). */
  ai: { day: string; n: number };
  /** The last results, in percent of the amount used (for the AI: no sums). */
  recent: number[];
  /** FIX-BOTSHORTS: per symbol and side, the setup (its start) the AI said no to; asked again at its confirmation. */
  aiNo?: Record<string, Partial<Record<BotSide, number>>>;
  /**
   * FIX-BOTSHORTS: per symbol and side, the last setup (its start) the bot entered on: one entry a setup while it forms
   * (an exit before its confirmation does not enter it again; the confirmed signal is an entry of its own).
   */
  setupTaken?: Record<string, Partial<Record<BotSide, number>>>;
  /**
   * FIX-LATEENTRY: per symbol and side, the last signal (its time) the bot entered on: a late entry never takes it again
   * (after its position closed by the bot's own levels, Slingshot may still keep it active).
   */
  signalTaken?: Record<string, Partial<Record<BotSide, number>>>;
  /** FIX-LATEENTRY: per symbol and side, the last signal (its time) the AI said no to: not asked again at each look. */
  signalAiNo?: Record<string, Partial<Record<BotSide, number>>>;
}

export interface BrokerRefs {
  long: string[];
  short: string[];
}

export interface RefsWait {
  side: BotSide;
  /** When the order left; positions opened since then are the bot's when no snapshot was taken. */
  at: number;
  before: string[] | null;
  /** FIX-ETOROPENDING: eToro's id of the order (its state asked while no position shows); absent in older waits. */
  orderId?: string | null;
}

/** An order on its way (real): its key is saved before it leaves, so a restart sends it again with the same key. */
export interface PendingOrder {
  key: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  reduce: boolean;
  at: number;
}

export interface BotState {
  v: 1;
  realized: number;
  fees: number;
  trades: number;
  wins: number;
  /** The user's day (their time zone) and its realized profit. */
  day: string;
  dayRealized: number;
  /** The day the daily loss limit was reached (no entries until the next). */
  dayBlocked: string | null;
  prices: Record<string, { p: number; at: number }>;
  /** Since when no price could be read. */
  noPriceSince: number | null;
  pending: PendingOrder | null;
  /** Exits refused in a row (10 → a problem); unexpected errors in a row (3 → a problem). */
  exitFailures: number;
  errors: number;
  /** When the bot last sent an order on a symbol (no reconciling for 60 s after). */
  lastOrderAt: Record<string, number>;
  /** What was said once and need not be said again, per symbol (the missing history, a foreign position). */
  noted: Record<string, string>;
  /** Until when no new entry is tried on a symbol (the platform refused the last one). */
  entryPause: Record<string, number>;
  /** eToro: the ids of the positions the bot opened, per symbol and side (FD-BOT §10). */
  refs: Record<string, BrokerRefs>;
  /** eToro: an opening whose position did not show yet (the ids seen before it, or none after a restart). */
  refsWait: Record<string, RefsWait>;
  /** The price when the bot was made (a grid's start price says whether to wait for a rise or a fall). */
  refPrice: number | null;
  endAction: BotEndAction | null;
  endReason: string | null;
  grid: GridState | null;
  dca: DcaState | null;
  premium: PremiumState | null;
  /**
   * FD-BOTEDIT: the settings the open positions run with. The same as `bots.config` but during a transition (another
   * account, market, DCA or grid symbol, another grid): then the positions finish or close with these first. Absent in
   * the states from before it: the first look takes the bot's settings.
   */
  basis?: BotInput;
  /** FD-BOTEDIT §3: how the positions of a transition end (the edit's choice, through the API's command). */
  switchMode?: PositionsMode | null;
}

export const newState = (refPrice: number | null): BotState => ({
  v: 1,
  realized: 0,
  fees: 0,
  trades: 0,
  wins: 0,
  day: '',
  dayRealized: 0,
  dayBlocked: null,
  prices: {},
  noPriceSince: null,
  pending: null,
  exitFailures: 0,
  errors: 0,
  lastOrderAt: {},
  noted: {},
  entryPause: {},
  refs: {},
  refsWait: {},
  refPrice,
  endAction: null,
  endReason: null,
  grid: null,
  dca: null,
  premium: null,
});

/** FD-BOTEDIT: the settings of the open positions (`state.basis`), read as the settings are; null when absent or unreadable. */
export function basisOf(st: BotState): BotInput | null {
  if (!st.basis) return null;
  const r = botInputSchema.safeParse(st.basis);
  return r.success ? r.data : null;
}

/**
 * FIX-BOTDRAG: the levels dragged on the chart, onto the positions they were dragged for (the same symbol, side and
 * opening): a Slingshot position's, the open DCA cycle's (on `dcaSymbol`, the symbol its settings trade). Applied again,
 * the same. A grid's stop is a setting (written there).
 */
export function applyLevels(st: BotState, moves: readonly BotLevelMove[], dcaSymbol: string): void {
  for (const m of moves) {
    const set = (x: { sl: number | null } | { sl?: number }, y: { tp: number | null } | { tp?: number }) => {
      if (m.sl !== undefined) x.sl = m.sl;
      if (m.tp !== undefined) y.tp = m.tp;
    };
    for (const p of st.premium?.positions ?? []) if (p.symbol === m.symbol && p.side === m.side && p.openedAt === m.openedAt) set(p, p);
    const d = st.dca?.deal;
    if (d && m.symbol === dcaSymbol && d.side === m.side && d.openedAt === m.openedAt) set(d, d);
  }
}

/** Whether the bot holds anything: a Slingshot position, a DCA cycle, a full grid interval. */
export const holdsPositions = (st: BotState): boolean => Boolean((st.premium?.positions.length ?? 0) > 0 || st.dca?.deal || st.grid?.slots.some((s) => s.entry !== null));

/** A closed trade, as `bot_trades` keeps it. */
export interface ClosedTrade {
  symbol: string;
  side: BotSide;
  qty: number;
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  openedAt: number;
  closedAt: number;
  reason: BotTradeReason;
  /** FD-TRADES: where it was made (the settings its position ran with; no account in Simulare) and its levels. */
  market: BotMarket;
  accountId: number | null;
  lev: number;
  sl: number | null;
  tp: number | null;
}

/** The state from the database: anything unreadable starts again (the positions of a real bot stay on the platform). */
export function parseState(raw: string | null): BotState {
  try {
    const v = JSON.parse(raw ?? '') as BotState;
    if (v && v.v === 1) return { ...newState(null), ...v };
  } catch {
    // a new state
  }
  return newState(null);
}

/** The profit of closing `qty` of a position at `price`, after the entry's and the exit's fee. */
export function closePnl(side: BotSide, entry: number, price: number, qty: number, entryFees: number, exitFee: number): number {
  return (side === 'long' ? 1 : -1) * (price - entry) * qty - entryFees - exitFee;
}

/** What a position would make if closed at `price` (no exit fee). */
export const openPnl = (side: BotSide, entry: number, price: number, qty: number): number => (side === 'long' ? 1 : -1) * (price - entry) * qty;
