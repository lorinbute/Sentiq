// FD-TRADES, TD-TRADES: an account's trade history, a row per trade (a position from its entry to its exit): the
// Sentiq bots' and the platform's own, each trade once. Pure.
import type { Position } from 'ccxt';
import type { ErrorCode } from './accounts.ts';
import type { ClosedTrade } from './brokers.ts';
import { closedAt, keyOf, netResult, settleOf, type StatsPeriod } from './trade-stats.ts';

/** Spot / futures (crypto), shares, a CFD (eToro, with leverage or short), a coin at a broker, another derivative. */
export type HistoryMarket = 'spot' | 'futures' | 'stock' | 'cfd' | 'crypto' | 'other';

export interface TradeHistoryRow {
  /** Unique in the list. */
  key: string;
  /** A Sentiq bot's, or from the account's history (by hand, from Sentiq's order form, another app). */
  source: 'bot' | 'account';
  bot: { id: number; name: string } | null;
  open: boolean;
  /** As shown: the pair (LTC/USDT) on crypto, the share (NVDA) at a broker. */
  symbol: string;
  market: HistoryMarket;
  /** Null when the platform's history does not say. */
  side: 'long' | 'short' | null;
  qty: number | null;
  leverage: number | null;
  entry: number | null;
  /** Null while open. */
  exit: number | null;
  sl: number | null;
  tp: number | null;
  /** Net, after fees (the platform's: with funding); while open, at the bot's last price. */
  pnl: number | null;
  /** Of the margin (or of the amount invested). */
  pnlPct: number | null;
  /**
   * FIX-HISTAMOUNT: what the trade took from the account, without leverage (its margin; a spot trade's cost), in
   * `currency`; null when it cannot be told.
   */
  margin: number | null;
  currency: string;
  openedAt: number | null;
  closedAt: number | null;
  /** Why it closed, in Romanian (take profit, lichidare…); null when unknown. */
  reason: string | null;
  /** FIX-TRADESOLD: what comes from the orders sent from Sentiq (the platform's history lacks it). */
  fromJournal?: ('leverage' | 'sl' | 'tp')[];
}

export interface TradeHistory {
  period: StatsPeriod;
  from: number;
  to: number;
  rows: TradeHistoryRow[];
  /** There were more rows than were sent. */
  truncated: boolean;
  /** The platform gives a history of closed trades (otherwise only the bots' are listed). */
  supported: boolean;
  /** The platform's history could not be read (the bots' rows are listed all the same). */
  error: { code: ErrorCode; message: string } | null;
  /** The platform's history read is shorter than the period (a broker's page limit). */
  limited: boolean;
  /** IBKR Flex: the account's data ends at the close of this day. */
  asOf: number | null;
  fetchedAt: number;
}

export const HISTORY_MAX_ROWS = 2000;
/** A platform's row is the bot's when it opened while the bot held that trade, give or take this. */
export const MATCH_TOLERANCE_MS = 5 * 60_000;

/** A positive finite number, or null (exchanges write "0.0" or "" for what they do not know). */
const positive = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * FIX-HISTAMOUNT: a trade's margin, quantity × entry ÷ leverage; null without one of them (an unknown leverage is not
 * taken as 1: a futures trade's margin would be its whole value).
 */
export function marginOf(qty: number | null, entry: number | null, lev: number | null): number | null {
  if (qty === null || entry === null || lev === null || !(lev > 0)) return null;
  const m = (Math.abs(qty) * entry) / lev;
  return Number.isFinite(m) && m > 0 ? m : null;
}

/** FIX-HISTAMOUNT: a pair whose value is not in its settlement coin (an inverse contract: BTC/USD settled in BTC). */
const inverse = (symbol: string, currency: string): boolean => symbol.includes('/') && symbol.split('/')[1] !== currency;

/** The result in percent of the margin: quantity × entry ÷ leverage (1 when unknown). */
export function pnlPercent(pnl: number | null, qty: number | null, entry: number | null, lev: number | null): number | null {
  if (pnl === null || qty === null || entry === null) return null;
  const margin = (qty * entry) / (lev !== null && lev > 0 ? lev : 1);
  return margin > 0 ? (pnl / margin) * 100 : null;
}

/** Why the exchange closed it, where its history says so (an ordinary close: null). */
function closeReason(exchange: string, info: Record<string, unknown>): string | null {
  const type = String(info.type ?? '').toUpperCase();
  if (exchange === 'kucoin') return type.includes('LIQUID') ? 'lichidare' : type.includes('ADL') ? 'ADL' : null;
  if (exchange === 'okx') return type === '3' || type === '4' ? 'lichidare' : type === '5' ? 'ADL' : null;
  if (exchange === 'bybit') {
    const exec = String(info.execType ?? '');
    return exec === 'BustTrade' ? 'lichidare' : exec === 'AdlTrade' ? 'ADL' : null;
  }
  return null;
}

/** The pair without its settlement (LTC/USDT:USDT → LTC/USDT), or a share without its currency (NVDA/USD → NVDA). */
export function symbolKey(symbol: string, share = false): string {
  const pair = (symbol.split(':')[0] ?? symbol).toUpperCase();
  return share ? (pair.split('/')[0] ?? pair) : pair;
}

/** A size worked out from prices: to the contract's step where ccxt knows it (0.1 SOL), else to 8 decimals. */
function roundSize(v: number, step: number | null): number {
  // toFixed(10) drops the float noise of the product (3 × 0.1 = 0.30000000000000004).
  return step !== null ? Number((Math.round(v / step) * step).toFixed(10)) : Math.round(v * 1e8) / 1e8;
}

/**
 * FIX-TRADESIZE: the size closed. ccxt's contracts where the exchange gives them; KuCoin classic gives none, but the value
 * closed (`closeCost`, at the close price) or the gross result (`realisedGrossCost`, over the price move) tell it.
 */
function closedSize(p: Position, info: Record<string, unknown>, entry: number | null, exit: number | null): number | null {
  const step = positive(p.contractSize);
  const contracts = positive(p.contracts);
  if (contracts !== null) return contracts * (step ?? 1);
  const cost = Math.abs(Number(info.closeCost));
  if (exit !== null && Number.isFinite(cost) && cost > 0) return roundSize(cost / exit, step);
  const gross = Math.abs(Number(info.realisedGrossCost));
  const move = entry !== null && exit !== null ? Math.abs(exit - entry) : 0;
  if (Number.isFinite(gross) && gross > 0 && move > 0) return roundSize(gross / move, step);
  return null;
}

/**
 * FIX-TRADESIZE: an isolated position's leverage from its margin (KuCoin classic gives none): the value at entry over the
 * margin, to 0.01. A cross position's margin is the account's, so none.
 */
function isolatedLeverage(info: Record<string, unknown>, qty: number | null, entry: number | null): number | null {
  if (String(info.marginMode ?? '').toUpperCase() !== 'ISOLATED' || qty === null || entry === null) return null;
  const margin = positive(info.unHoldMargin);
  return margin !== null ? Math.round(((qty * entry) / margin) * 100) / 100 : null;
}

/**
 * A closed futures position from a crypto exchange's history (ccxt): ccxt puts the close price in `lastPrice`
 * (KuCoin, Bybit, OKX, Bitget). Null without a side or a close time.
 */
export function positionRow(exchange: string, p: Position): TradeHistoryRow | null {
  const info = (p.info ?? {}) as Record<string, unknown>;
  const side = p.side === 'long' || p.side === 'short' ? p.side : null;
  const closed = closedAt(p);
  if (!side || !(closed > 0)) return null;
  // KuCoin classic gives `openTime` (ccxt leaves the timestamp empty); Bybit's timestamp is when the close was recorded.
  const opened = exchange === 'bybit' ? null : (positive(p.timestamp) ?? positive(info.openTime));
  const entry = positive(p.entryPrice);
  const exit = positive(p.lastPrice);
  const qty = closedSize(p, info, entry, exit);
  const leverage = positive(p.leverage) ?? isolatedLeverage(info, qty, entry);
  const result = netResult(p);
  const pnl = Number.isFinite(result) ? result : null;
  // FIX-TRADESIZE: KuCoin's own result as a share of the margin (`roe`, 0.0285 = 2.85 %); other exchanges' fields differ.
  const roe = exchange !== 'kucoin' || info.roe === null || info.roe === undefined || info.roe === '' ? NaN : Number(info.roe);
  const symbol = symbolKey(String(p.symbol ?? '?'));
  const currency = settleOf(p) || 'USDT';
  // FIX-HISTAMOUNT: the position's margin as the platform gives it (KuCoin's isolated one, ccxt's initial margin), else
  // its value at entry over its leverage (a linear contract only).
  const isolated = String(info.marginMode ?? '').toUpperCase() === 'ISOLATED' ? positive(info.unHoldMargin) : null;
  const margin = isolated ?? positive(p.initialMargin) ?? (inverse(symbol, currency) ? null : marginOf(qty, entry, leverage));
  return {
    key: `a|${keyOf(p)}`,
    source: 'account',
    bot: null,
    open: false,
    symbol,
    market: 'futures',
    side,
    qty,
    leverage,
    entry,
    exit,
    sl: null,
    tp: null,
    pnl,
    // A futures position's margin is unknown without its leverage (FIX-TRADESOLD may find it).
    pnlPct: Number.isFinite(roe) ? roe * 100 : leverage === null ? null : pnlPercent(pnl, qty, entry, leverage),
    margin,
    currency,
    openedAt: opened,
    closedAt: closed,
    reason: closeReason(exchange, info),
  };
}

/** A broker's closed trade; `currency`: the account's (the trade's own, when the broker says it). */
export function brokerRow(t: ClosedTrade, currency: string): TradeHistoryRow {
  const qty = t.qty ?? null;
  const entry = t.entry ?? null;
  const leverage = t.leverage ?? null;
  return {
    key: `a|${t.id}`,
    source: 'account',
    bot: null,
    open: false,
    symbol: symbolKey(t.symbol ?? '?', true),
    market: t.market ?? 'stock',
    side: t.side ?? null,
    qty,
    leverage,
    entry,
    exit: t.exit ?? null,
    sl: t.sl ?? null,
    tp: t.tp ?? null,
    pnl: t.pnl,
    pnlPct: t.pnl !== null && t.invested ? (t.pnl / t.invested) * 100 : pnlPercent(t.pnl, qty, entry, leverage),
    // FIX-HISTAMOUNT: what the broker says was invested, else the value over the leverage.
    margin: t.invested && t.invested > 0 ? t.invested : marginOf(qty, entry, leverage),
    currency: t.currency ?? currency,
    openedAt: t.openedAt ?? null,
    closedAt: t.closedAt,
    reason: null,
  };
}

/** Open first (the newest entry on top), then the closed ones, the latest exit on top. */
function byRecency(a: TradeHistoryRow, b: TradeHistoryRow): number {
  if (a.open !== b.open) return a.open ? -1 : 1;
  const ta = (a.open ? a.openedAt : a.closedAt) ?? 0;
  const tb = (b.open ? b.openedAt : b.closedAt) ?? 0;
  return tb - ta || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * The list (FD-TRADES §4): the bots' trades, and the platform's not made by a bot. A platform's row is a bot's when it
 * is on the same symbol, market and side and opened while the bot held that trade (its close, when the platform gives
 * no opening time): a bot's spot trade never hides a futures position. `bot` may reach before `from` (a bot's close
 * just before the period hides a platform's just after). Only the trades closed in [from, to] and the open ones are
 * kept, at most HISTORY_MAX_ROWS (`bot` may hold one more, to tell that there were more).
 */
export function mergeHistory(bot: TradeHistoryRow[], account: TradeHistoryRow[], from: number, to: number, now: number, share = false): { rows: TradeHistoryRow[]; truncated: boolean } {
  const held = bot.map((b) => ({
    key: symbolKey(b.symbol, share),
    market: b.market,
    side: b.side,
    from: (b.openedAt ?? b.closedAt ?? now) - MATCH_TOLERANCE_MS,
    to: (b.open ? now : (b.closedAt ?? now)) + MATCH_TOLERANCE_MS,
  }));
  const isBots = (a: TradeHistoryRow): boolean => {
    const k = symbolKey(a.symbol, share);
    const t = a.openedAt ?? a.closedAt;
    return t !== null && held.some((h) => h.key === k && h.market === a.market && h.side === a.side && t >= h.from && t <= h.to);
  };
  const inPeriod = (r: TradeHistoryRow) => r.open || (r.closedAt !== null && r.closedAt >= from && r.closedAt <= to);
  const all = [...bot.filter(inPeriod), ...account.filter((a) => inPeriod(a) && !isBots(a))].sort(byRecency);
  return { rows: all.slice(0, HISTORY_MAX_ROWS), truncated: all.length > HISTORY_MAX_ROWS };
}

// ---------------------------------------------------------------- FIX-TRADESOLD: what Sentiq sent

/** A `trade_log` row as the history reads it. */
export interface JournalRow {
  action: string;
  created_at: number;
  symbol: string | null;
  market: string | null;
  side: string | null;
  leverage: number | null;
  detail: string | null;
}

/** An SL / TP changed from Sentiq: the closing side, the new level (null: taken off), the eToro position it was on. */
export interface LevelChange {
  kind: 'sl' | 'tp';
  side: string | null;
  value: number | null;
  position: string | null;
}

/** An order or a modification sent from Sentiq (and accepted), with what it says of the levels. */
export interface JournalEntry {
  action: 'order' | 'modify';
  at: number;
  symbol: string;
  market: string | null;
  side: 'buy' | 'sell' | null;
  /** An order that opens or adds to a position (not reduce-only, not a close). */
  opens: boolean;
  leverage: number | null;
  /** The ticket's SL / TP: undefined when it set none (or the separate order for it failed). */
  stopLoss?: number;
  takeProfit?: number;
  changes: LevelChange[];
}

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => x !== null) : []);

/** A journal row as an entry; null when it says nothing usable (another action, no symbol, a detail that cannot be read). */
export function journalEntry(r: JournalRow): JournalEntry | null {
  if ((r.action !== 'order' && r.action !== 'modify') || !r.symbol) return null;
  let detail: Record<string, unknown> | null;
  try {
    detail = obj(JSON.parse(r.detail ?? ''));
  } catch {
    return null;
  }
  if (!detail) return null;
  const side = r.side === 'buy' || r.side === 'sell' ? r.side : null;
  if (r.action === 'order') {
    const t = obj(detail.ticket);
    if (!t) return null;
    // An SL / TP sent as an order of its own after the entry (Binance) counts only if it was placed.
    const failed = new Set(list(obj(detail.result)?.followUps).filter((f) => f.ok === false).map((f) => String(f.what)));
    const lev = positive(t.leverage) ?? positive(r.leverage);
    const sl = failed.has('stop-loss') ? null : positive(t.stopLoss);
    const tp = failed.has('take-profit') ? null : positive(t.takeProfit);
    return {
      action: 'order',
      at: r.created_at,
      symbol: r.symbol,
      market: typeof t.market === 'string' ? t.market : r.market,
      side: t.side === 'buy' || t.side === 'sell' ? t.side : side,
      opens: t.reduceOnly !== true && !t.close,
      leverage: lev,
      ...(sl !== null ? { stopLoss: sl } : {}),
      ...(tp !== null ? { takeProfit: tp } : {}),
      changes: [],
    };
  }
  const results = list(obj(detail.result)?.steps);
  const changes: LevelChange[] = [];
  list(detail.steps).forEach((st, i) => {
    const kind = st.kind === 'sl' || st.kind === 'tp' ? st.kind : null;
    const index = typeof st.change === 'number' ? st.change : i;
    // Applied when one of its steps went through (a new order placed, eToro's position changed).
    if (!kind || !results.some((x) => x.change === index && x.ok === true)) return;
    const after = obj(st.after) ?? {};
    const value = st.removes === true ? null : (positive(after.triggerPrice) ?? positive(kind === 'sl' ? after.stopLoss : after.takeProfit) ?? positive(after.price));
    const ref = typeof st.orderId === 'string' ? /^(?:sl|tp)-(.+)$/.exec(st.orderId)?.[1] ?? null : null;
    changes.push({ kind, side: typeof st.side === 'string' ? st.side : null, value, position: ref });
  });
  if (!changes.length) return null;
  // A row without its market: a contract's symbol (BTC/USDT:USDT) is futures.
  const market = r.market ?? (r.symbol.includes(':') ? 'futures' : null);
  return { action: 'modify', at: r.created_at, symbol: r.symbol, market, side, opens: false, leverage: null, changes };
}

/** How far before (and after) a position's opening the order that opened it may have been sent. */
export const OPEN_BEFORE_MS = 10 * 60_000;
export const OPEN_AFTER_MS = 2 * 60_000;

/** With leverage or without: what an order's market and a row's market must agree on. */
const leveraged = (market: string | null, side: 'buy' | 'sell' | null, lev: number | null, etoro: boolean): boolean => {
  if (market === 'futures' || market === 'cfd' || market === 'other') return true;
  // A share sent with leverage or short is a CFD at eToro (FD-TRADES); elsewhere a short share stays a share.
  return etoro && market === 'stock' && ((lev ?? 1) > 1 || side === 'sell');
};

/**
 * FIX-TRADESOLD: the platform's rows completed from the orders sent from Sentiq on the account: the leverage of the
 * order that opened the position, and the SL / TP in force when it closed (its own, an addition's on crypto, then each
 * change; the last wins). Only what the platform left empty is filled. `exchange`: the account's platform (at a broker
 * each position stands apart and is changed by its id).
 */
export function withJournal(rows: TradeHistoryRow[], entries: JournalEntry[], exchange: string, share = false): TradeHistoryRow[] {
  if (!entries.length) return rows;
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const etoro = exchange === 'etoro';
  return rows.map((r) => {
    if (r.source !== 'account' || r.openedAt === null || !r.side) return r;
    const opened = r.openedAt;
    const closed = r.closedAt ?? Number.POSITIVE_INFINITY;
    const key = symbolKey(r.symbol, share);
    const buy = r.side === 'long' ? 'buy' : 'sell';
    const closing = r.side === 'long' ? 'sell' : 'buy';
    const rowLev = leveraged(r.market, null, r.leverage, etoro);
    const sameMarket = (e: JournalEntry) => leveraged(e.market, e.side, e.leverage, etoro) === rowLev;
    const opening = sorted.filter((e) => e.action === 'order' && e.opens && e.side === buy && symbolKey(e.symbol, share) === key && sameMarket(e));
    let first: JournalEntry | null = null;
    for (const e of opening) {
      if (e.at < opened - OPEN_BEFORE_MS || e.at > opened + OPEN_AFTER_MS) continue;
      if (!first || Math.abs(e.at - opened) < Math.abs(first.at - opened)) first = e;
    }
    if (!first) return r;
    const start = first;
    let sl: number | null = start.stopLoss ?? null;
    let tp: number | null = start.takeProfit ?? null;
    const position = share ? r.key.replace(/^a\|/, '') : null;
    for (const e of sorted) {
      if (e === start || e.at < start.at || e.at > closed) continue;
      if (e.action === 'order') {
        // On crypto a position is one per symbol and side: an order that adds to it brings its own SL / TP.
        if (share || !opening.includes(e)) continue;
        if (e.stopLoss !== undefined) sl = e.stopLoss;
        if (e.takeProfit !== undefined) tp = e.takeProfit;
        continue;
      }
      // A spot holding's SL on the same pair is not the futures position's.
      if (!share && (symbolKey(e.symbol) !== key || leveraged(e.market, null, null, etoro) !== rowLev)) continue;
      for (const c of e.changes) {
        const mine = share ? c.position !== null && c.position === position : c.side === null || c.side === closing;
        if (!mine) continue;
        if (c.kind === 'sl') sl = c.value;
        else tp = c.value;
      }
    }
    const leverage = r.leverage ?? start.leverage;
    const filled = { leverage: r.leverage === null && leverage !== null, sl: r.sl === null && sl !== null, tp: r.tp === null && tp !== null };
    const from = (['leverage', 'sl', 'tp'] as const).filter((k) => filled[k]);
    if (!from.length) return r;
    return {
      ...r,
      leverage,
      sl: r.sl ?? sl,
      tp: r.tp ?? tp,
      // The leverage found makes the percent of the margin known (or right).
      pnlPct: filled.leverage ? (pnlPercent(r.pnl, r.qty, r.entry, leverage) ?? r.pnlPct) : r.pnlPct,
      // FIX-HISTAMOUNT: and its margin (a linear contract), where the platform gave none.
      margin: r.margin ?? (filled.leverage && !inverse(r.symbol, r.currency) ? marginOf(r.qty, r.entry, leverage) : null),
      fromJournal: from,
    };
  });
}
