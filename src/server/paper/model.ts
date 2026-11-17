// FD-PAPER §3–§5: Paper Trading's arithmetic, pure: what an execution does to a position (opens it, adds to it, reduces,
// closes or turns it) and to the money, what a waiting order holds back, the liquidation, and whether a price window
// fills an order or reaches a position's stop loss, take profit or liquidation. FIX-PAPERLEV: every market (spot, futures,
// shares) is traded the same way: a position, long or short, with its leverage and its margin.
import { MAINT_MARGIN } from '../../shared/bot.ts';
import type { CommissionType } from '../../shared/paper.ts';

export type PaperMarket = 'spot' | 'futures' | 'stock';
export type Side = 'long' | 'short';
export type OrderSide = 'buy' | 'sell';
export type PaperOrderKind = 'market' | 'limit' | 'stop' | 'stop_limit';
export type MarginMode = 'isolated' | 'cross';
/** Why a position (or a part of it) closed. */
export type CloseReason = 'order' | 'sl' | 'tp' | 'liquidation' | 'reverse';

export interface PaperPosition {
  id: number;
  market: PaperMarket;
  /** BTC/USDT (spot), BTC/USDT:USDT (futures), AAPL (shares). */
  symbol: string;
  side: Side;
  qty: number;
  entry: number;
  leverage: number;
  marginMode: MarginMode;
  /** The margin it holds: its value at entry / its leverage. */
  margin: number;
  sl: number | null;
  tp: number | null;
  /** The entry commissions not yet booked with a close. */
  fees: number;
  openedAt: number;
  /** When it or its stop loss / take profit last changed: a price window starts no earlier. */
  updatedAt: number;
}

export interface PaperOrder {
  id: number;
  market: PaperMarket;
  symbol: string;
  side: OrderSide;
  kind: PaperOrderKind;
  qty: number;
  price: number | null;
  triggerPrice: number | null;
  leverage: number | null;
  marginMode: MarginMode | null;
  reduceOnly: boolean;
  sl: number | null;
  tp: number | null;
  /** A stop-limit whose trigger was reached: now a limit order. */
  triggered: boolean;
  /** The money it holds back (USD). */
  reserved: number;
  createdAt: number;
  checkedAt: number;
}

export interface Commission {
  type: CommissionType;
  value: number;
}

/** One execution: an order filled, a stop loss / take profit reached, a liquidation, a reversal's legs. */
export interface Execution {
  market: PaperMarket;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  /** The order's (an addition keeps the position's margin mode). */
  leverage: number;
  marginMode: MarginMode;
  reduceOnly: boolean;
  /** Attached to the order: the position's after it opens or grows. */
  sl: number | null;
  tp: number | null;
  at: number;
  reason: CloseReason;
}

/** A part of a position closed: a row of the history. */
export interface ClosedPart {
  market: PaperMarket;
  symbol: string;
  side: Side;
  qty: number;
  entry: number;
  exit: number;
  /** Net: the price difference less the entry's share of the commissions and the exit's. */
  pnl: number;
  fees: number;
  leverage: number;
  sl: number | null;
  tp: number | null;
  openedAt: number;
  closedAt: number;
  reason: CloseReason;
}

export type PositionState = Omit<PaperPosition, 'id'> & { id?: number };

export interface FillOutcome {
  /** The position after the execution (null: closed). */
  position: PositionState | null;
  closed: ClosedPart | null;
  /** What the money changes by. */
  cash: number;
  fee: number;
}

const EPS = 1e-12;
export const sideOf = (s: OrderSide): Side => (s === 'buy' ? 'long' : 'short');
export const closingSide = (s: Side): OrderSide => (s === 'long' ? 'sell' : 'buy');
const dirOf = (s: Side) => (s === 'long' ? 1 : -1);

/**
 * What an execution does (FD-PAPER §4, FIX-PAPERLEV): a position grows on its side (average entry, margins added),
 * shrinks or closes against it (the result in proportion, its entry commissions shared out), and turns when the order is
 * larger (not reduce-only: the rest opens the other way, with the order's TP / SL). The money changes by the results and
 * the commissions only (the margin is held, not spent). Each execution's commission is the caller's (`fee`).
 */
export function applyFill(pos: PaperPosition | PositionState | null, x: Execution, fee: number): FillOutcome {
  const side = sideOf(x.side);
  if (!pos || pos.qty <= EPS) {
    return { position: opened(x, x.qty, fee), closed: null, cash: -fee, fee };
  }
  if (pos.side === side) {
    const qty = pos.qty + x.qty;
    return {
      position: {
        ...pos,
        qty,
        entry: (pos.entry * pos.qty + x.price * x.qty) / qty,
        margin: pos.margin + (x.qty * x.price) / x.leverage,
        sl: x.sl ?? pos.sl,
        tp: x.tp ?? pos.tp,
        fees: pos.fees + fee,
        updatedAt: x.at,
      },
      closed: null,
      cash: -fee,
      fee,
    };
  }
  const closeQty = Math.min(x.qty, pos.qty);
  const rest = x.reduceOnly ? 0 : x.qty - closeQty;
  const exitFee = rest > EPS ? (fee * closeQty) / x.qty : fee;
  const share = closeQty / pos.qty;
  const entryFees = pos.fees * share;
  const gross = (x.price - pos.entry) * closeQty * dirOf(pos.side);
  const closed: ClosedPart = {
    market: x.market,
    symbol: x.symbol,
    side: pos.side,
    qty: closeQty,
    entry: pos.entry,
    exit: x.price,
    pnl: gross - entryFees - exitFee,
    fees: entryFees + exitFee,
    leverage: effectiveLeverage(pos),
    sl: pos.sl,
    tp: pos.tp,
    openedAt: pos.openedAt,
    closedAt: x.at,
    reason: x.reason,
  };
  const left = pos.qty - closeQty;
  let position: PositionState | null = left > EPS ? { ...pos, qty: left, margin: pos.margin * (1 - share), fees: pos.fees - entryFees, updatedAt: x.at } : null;
  let cash = gross - exitFee;
  if (rest > EPS) {
    position = opened(x, rest, fee - exitFee);
    cash -= fee - exitFee;
  }
  return { position, closed, cash, fee };
}

function opened(x: Execution, qty: number, fee: number): PositionState {
  return {
    market: x.market,
    symbol: x.symbol,
    side: sideOf(x.side),
    qty,
    entry: x.price,
    leverage: x.leverage,
    marginMode: x.marginMode,
    margin: (qty * x.price) / x.leverage,
    sl: x.sl,
    tp: x.tp,
    fees: fee,
    openedAt: x.at,
    updatedAt: x.at,
  };
}

/** The leverage a position's margin stands for (its additions may have had their own). */
export const effectiveLeverage = (p: Pick<PaperPosition, 'qty' | 'entry' | 'margin' | 'leverage'>): number => (p.margin > 0 ? (p.qty * p.entry) / p.margin : p.leverage);

/**
 * An isolated position's liquidation (FD-PAPER §5): where the loss eats its margin less the maintenance margin (0.5% of
 * its value at entry). Null when it would be at or below zero, and for a long whose margin pays its whole value (1×:
 * what is bought is owned, FIX-PAPERLEV).
 */
export function liquidationPrice(p: Pick<PaperPosition, 'side' | 'qty' | 'entry' | 'margin'>): number | null {
  if (!(p.qty > 0) || !(p.margin > 0)) return null;
  if (p.side === 'long' && p.margin >= p.qty * p.entry * (1 - 1e-9)) return null;
  const v = p.side === 'long' ? p.entry * (1 + MAINT_MARGIN) - p.margin / p.qty : p.entry * (1 - MAINT_MARGIN) + p.margin / p.qty;
  return v > 0 ? v : null;
}

/**
 * A Cross position's estimated liquidation: where the money left for Cross (`equity`: without this position's result)
 * plus its result no longer covers its maintenance margin. Null when it never would be.
 */
export function crossLiquidationPrice(p: Pick<PaperPosition, 'side' | 'qty' | 'entry'>, equity: number): number | null {
  if (!(p.qty > 0)) return null;
  const v = p.side === 'long' ? (p.entry * p.qty - equity) / (p.qty * (1 - MAINT_MARGIN)) : (equity + p.entry * p.qty) / (p.qty * (1 + MAINT_MARGIN));
  return v > 0 && Number.isFinite(v) ? v : null;
}

/** A position's result at `price`, before commissions. */
export const unrealized = (p: Pick<PaperPosition, 'side' | 'qty' | 'entry'>, price: number): number => (price - p.entry) * p.qty * dirOf(p.side);

/** The price an order is reckoned at before it fills: its limit, its trigger, or the price now. */
export const orderRef = (o: Pick<PaperOrder, 'kind' | 'price' | 'triggerPrice'>, last: number): number => (o.kind === 'limit' || o.kind === 'stop_limit' ? (o.price ?? last) : o.kind === 'stop' ? (o.triggerPrice ?? last) : last);

/**
 * What a waiting order holds back (FD-PAPER §3): an entry's margin and commission (beyond the opposite position it would
 * close first); a reduce-only order nothing.
 */
export function reserveFor(o: Pick<PaperOrder, 'qty' | 'kind' | 'price' | 'triggerPrice' | 'leverage' | 'reduceOnly'>, last: number, commission: (notional: number) => number, opposite = 0): number {
  if (o.reduceOnly) return 0;
  const ref = orderRef(o, last);
  const opens = Math.max(0, o.qty - opposite);
  return (opens * ref) / (o.leverage ?? 1) + commission(o.qty * ref);
}

/** The money free for new orders: what the account has, less the margin of the positions and what orders hold back. */
export function available(cash: number, positions: readonly Pick<PaperPosition, 'margin'>[], orders: readonly Pick<PaperOrder, 'reserved'>[]): number {
  return cash - positions.reduce((a, p) => a + p.margin, 0) - orders.reduce((a, o) => a + o.reserved, 0);
}

/** The prices since the last look: the first, the highest, the lowest and the last. */
export interface PriceWindow {
  open: number;
  high: number;
  low: number;
  last: number;
}

/**
 * Whether a window fills a waiting order, and at what price (FD-PAPER §5): a limit at its price or better (the window
 * opened past it: there), a stop at its trigger or worse (a jump past it: the window's opening). A stop-limit whose
 * trigger is reached becomes a limit (`triggered`), filled from the next window on.
 */
export function orderTouch(o: Pick<PaperOrder, 'kind' | 'side' | 'price' | 'triggerPrice' | 'triggered'>, w: PriceWindow): { price: number } | { triggered: true } | null {
  const buy = o.side === 'buy';
  if (o.kind === 'market') return { price: w.last };
  const limit = (price: number) => (buy ? (w.low <= price ? { price: w.open <= price ? w.open : price } : null) : w.high >= price ? { price: w.open >= price ? w.open : price } : null);
  const stop = (trigger: number) => (buy ? (w.high >= trigger ? { price: w.open >= trigger ? w.open : trigger } : null) : w.low <= trigger ? { price: w.open <= trigger ? w.open : trigger } : null);
  if (o.kind === 'limit') return o.price !== null ? limit(o.price) : null;
  if (o.kind === 'stop') return o.triggerPrice !== null ? stop(o.triggerPrice) : null;
  // A stop-limit.
  if (o.triggered) return o.price !== null ? limit(o.price) : null;
  return o.triggerPrice !== null && stop(o.triggerPrice) ? { triggered: true } : null;
}

/**
 * Whether a window reaches a position's stop loss, take profit or liquidation, and at what price (FD-PAPER §5): the
 * losing levels before the take profit when both are reached in one window (prudent); of the losing ones, the first the
 * price meets (a long's highest, a short's lowest); a jump past a level: the window's opening.
 */
export function protectionTouch(p: Pick<PaperPosition, 'side' | 'sl' | 'tp'>, w: PriceWindow, liquidation: number | null): { reason: 'sl' | 'tp' | 'liquidation'; price: number } | null {
  const long = p.side === 'long';
  const hitsLoss = (level: number) => (long ? w.low <= level : w.high >= level);
  const atLoss = (level: number) => (long ? (w.open <= level ? w.open : level) : w.open >= level ? w.open : level);
  const losing: { reason: 'sl' | 'liquidation'; level: number }[] = [];
  if (p.sl !== null && hitsLoss(p.sl)) losing.push({ reason: 'sl', level: p.sl });
  if (liquidation !== null && hitsLoss(liquidation)) losing.push({ reason: 'liquidation', level: liquidation });
  if (losing.length) {
    losing.sort((a, b) => (long ? b.level - a.level : a.level - b.level));
    const first = losing[0]!;
    return { reason: first.reason, price: first.reason === 'liquidation' ? first.level : atLoss(first.level) };
  }
  if (p.tp !== null && (long ? w.high >= p.tp : w.low <= p.tp)) return { reason: 'tp', price: long ? (w.open >= p.tp ? w.open : p.tp) : w.open <= p.tp ? w.open : p.tp };
  return null;
}

/**
 * Whether the Cross positions are liquidated (FD-PAPER §5): the money left for them (the account's, less the isolated
 * margins and what orders hold back, plus their results at the price now) no longer covers their maintenance margin.
 */
export function crossBreached(cash: number, positions: readonly PaperPosition[], orders: readonly Pick<PaperOrder, 'reserved'>[], prices: ReadonlyMap<string, number>): boolean {
  const cross = positions.filter((p) => p.marginMode === 'cross');
  if (!cross.length) return false;
  const isolated = positions.reduce((a, p) => a + (p.marginMode === 'isolated' ? p.margin : 0), 0);
  let equity = cash - isolated - orders.reduce((a, o) => a + o.reserved, 0);
  let maintenance = 0;
  for (const p of cross) {
    const price = prices.get(p.symbol);
    if (price === undefined) return false;
    equity += unrealized(p, price);
    maintenance += MAINT_MARGIN * price * p.qty;
  }
  return equity <= maintenance;
}
