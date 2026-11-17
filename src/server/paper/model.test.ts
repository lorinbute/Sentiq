// FD-PAPER §3–§5: Paper Trading's arithmetic.
import { describe, expect, it } from 'vitest';
import { applyFill, available, crossBreached, crossLiquidationPrice, liquidationPrice, orderTouch, protectionTouch, reserveFor, type Execution, type PaperPosition } from './model.ts';
import { commissionOf, commissionText } from '../../shared/paper.ts';

const x = (over: Partial<Execution> = {}): Execution => ({ market: 'futures', symbol: 'BTC/USDT:USDT', side: 'buy', qty: 1, price: 100, leverage: 10, marginMode: 'isolated', reduceOnly: false, sl: null, tp: null, at: 1000, reason: 'order', ...over });
const pos = (over: Partial<PaperPosition> = {}): PaperPosition => ({ id: 7, market: 'futures', symbol: 'BTC/USDT:USDT', side: 'long', qty: 2, entry: 100, leverage: 10, marginMode: 'isolated', margin: 20, sl: null, tp: null, fees: 0.4, openedAt: 500, updatedAt: 500, ...over });

describe('the commission (FD-PAPER §5)', () => {
  it('a percent of the value, or a fixed sum whatever the size; said in words', () => {
    expect(commissionOf('percent', 0.1, 2500)).toBeCloseTo(2.5, 12);
    expect(commissionOf('fixed', 1.5, 2500)).toBe(1.5);
    expect(commissionOf('fixed', 1.5, 3)).toBe(1.5);
    expect(commissionText('percent', 0.1)).toBe('0,1% pe execuție');
    expect(commissionText('fixed', 2)).toBe('2 USD pe execuție');
    expect(commissionText('percent', 0)).toBe('fără comision');
  });
});

describe('an execution (FD-PAPER §4): futures, spot and shares alike (FIX-PAPERLEV)', () => {
  it('opens a position: its margin, its levels, the commission paid', () => {
    const o = applyFill(null, x({ qty: 2, sl: 90, tp: 120 }), 0.2);
    expect(o.position).toMatchObject({ side: 'long', qty: 2, entry: 100, margin: 20, leverage: 10, sl: 90, tp: 120, fees: 0.2, openedAt: 1000 });
    expect(o.cash).toBeCloseTo(-0.2, 12);
    expect(o.closed).toBeNull();
  });

  it('adds on its side: the average entry, the margins added, new levels when the order brings them', () => {
    const o = applyFill(pos({ sl: 80 }), x({ qty: 2, price: 110, leverage: 5, tp: 130 }), 0.22);
    expect(o.position).toMatchObject({ id: 7, qty: 4, entry: 105, margin: 20 + 44, sl: 80, tp: 130, fees: 0.62 });
    expect(o.cash).toBeCloseTo(-0.22, 12);
  });

  it('shrinks against it: the result in proportion, its entry commissions shared out, the margin given back', () => {
    const o = applyFill(pos(), x({ side: 'sell', qty: 0.5, price: 120 }), 0.06);
    expect(o.closed).toMatchObject({ side: 'long', qty: 0.5, entry: 100, exit: 120, reason: 'order', leverage: 10 });
    expect(o.closed!.pnl).toBeCloseTo(10 - 0.1 - 0.06, 12);
    expect(o.closed!.fees).toBeCloseTo(0.16, 12);
    expect(o.position).toMatchObject({ qty: 1.5, margin: 15, fees: 0.30000000000000004 });
    expect(o.cash).toBeCloseTo(10 - 0.06, 12);
  });

  it('closes it all; a larger order turns it, the rest the other way with the order\'s levels and its share of the commission', () => {
    const close = applyFill(pos(), x({ side: 'sell', qty: 2, price: 90 }), 0.18);
    expect(close.position).toBeNull();
    expect(close.closed!.pnl).toBeCloseTo(-20 - 0.4 - 0.18, 12);
    const turn = applyFill(pos(), x({ side: 'sell', qty: 3, price: 90, leverage: 3, tp: 70 }), 0.27);
    expect(turn.closed!.qty).toBe(2);
    expect(turn.closed!.pnl).toBeCloseTo(-20 - 0.4 - 0.18, 12);
    expect(turn.position).toMatchObject({ side: 'short', qty: 1, entry: 90, margin: 30, leverage: 3, tp: 70, sl: null });
    expect(turn.position!.fees).toBeCloseTo(0.09, 12);
    expect(turn.position!.id).toBeUndefined();
    expect(turn.cash).toBeCloseTo(-20 - 0.18 - 0.09, 12);
  });

  it('reduce-only never turns it: only as much as the position', () => {
    const o = applyFill(pos(), x({ side: 'sell', qty: 5, price: 110, reduceOnly: true }), 0.5);
    expect(o.position).toBeNull();
    expect(o.closed!.qty).toBe(2);
    expect(o.closed!.pnl).toBeCloseTo(20 - 0.4 - 0.5, 12);
  });

  it('a short wins when the price falls', () => {
    const o = applyFill(pos({ side: 'short' }), x({ side: 'buy', qty: 2, price: 80 }), 0);
    expect(o.closed!.pnl).toBeCloseTo(40 - 0.4, 12);
  });
});

describe('spot and shares with leverage, long and short (FIX-PAPERLEV)', () => {
  const spot = (over: Partial<Execution> = {}) => x({ market: 'spot', symbol: 'BTC/USDT', leverage: 1, ...over });
  it('a buy holds its margin (its whole cost at 1×, a fifth at 5×), the money changes by the commission only; a second one averages', () => {
    const a = applyFill(null, spot({ qty: 2, price: 100 }), 0.2);
    expect(a.cash).toBeCloseTo(-0.2, 12);
    expect(a.position).toMatchObject({ market: 'spot', side: 'long', qty: 2, entry: 100, margin: 200, leverage: 1, fees: 0.2 });
    const b = applyFill(a.position, spot({ qty: 2, price: 110, leverage: 5 }), 0.22);
    expect(b.position).toMatchObject({ qty: 4, entry: 105, margin: 200 + 44 });
  });
  it('a sale closes the long with its result; a larger one opens a short (spot and shares sell short too)', () => {
    const held = applyFill(null, spot({ qty: 2, price: 100 }), 0.2).position!;
    const sale = applyFill(held, spot({ side: 'sell', qty: 5, price: 120, leverage: 3 }), 0.6);
    expect(sale.closed).toMatchObject({ qty: 2, exit: 120, side: 'long', leverage: 1 });
    expect(sale.closed!.pnl).toBeCloseTo(40 - 0.2 - 0.24, 12);
    expect(sale.position).toMatchObject({ side: 'short', qty: 3, entry: 120, margin: 120, leverage: 3 });
    const short = applyFill(null, x({ market: 'stock', symbol: 'AAPL', side: 'sell', qty: 10, price: 200, leverage: 2 }), 1);
    expect(short.position).toMatchObject({ market: 'stock', side: 'short', margin: 1000, leverage: 2 });
  });
});

describe('the liquidation, what is held back, what is free (FD-PAPER §3, §5)', () => {
  it('isolated: where the loss eats the margin less 0,5%, on every market; a long at 1× is owned; a 1× short at about double', () => {
    expect(liquidationPrice(pos())).toBeCloseTo(100 * 1.005 - 10, 9);
    expect(liquidationPrice(pos({ side: 'short' }))).toBeCloseTo(100 * 0.995 + 10, 9);
    expect(liquidationPrice(pos({ market: 'spot', symbol: 'BTC/USDT' }))).toBeCloseTo(100 * 1.005 - 10, 9);
    expect(liquidationPrice(pos({ market: 'stock', symbol: 'AAPL', leverage: 5, margin: 40 }))).toBeCloseTo(100 * 1.005 - 20, 9);
    expect(liquidationPrice(pos({ side: 'short', market: 'stock', leverage: 1, margin: 200 }))).toBeCloseTo(199.5, 9);
    // What is bought at 1× is owned: never liquidated (spot, shares, futures).
    expect(liquidationPrice(pos({ side: 'long', market: 'stock', leverage: 1, margin: 200 }))).toBeNull();
    expect(liquidationPrice(pos({ side: 'long', market: 'spot', leverage: 1, margin: 200 }))).toBeNull();
  });
  it('cross: from the money left for it', () => {
    expect(crossLiquidationPrice({ side: 'long', qty: 2, entry: 100 }, 50)).toBeCloseTo(150 / (2 * 0.995), 9);
    expect(crossLiquidationPrice({ side: 'long', qty: 2, entry: 100 }, 1000)).toBeNull();
    expect(crossLiquidationPrice({ side: 'short', qty: 2, entry: 100 }, 50)).toBeCloseTo(250 / (2 * 1.005), 9);
  });
  it('holds back an entry\'s margin and commission (any market, any side) beyond the position it closes first; nothing for reduce-only', () => {
    const fee = (n: number) => n * 0.001;
    expect(reserveFor({ qty: 2, kind: 'limit', price: 90, triggerPrice: null, leverage: 1, reduceOnly: false }, 100, fee)).toBeCloseTo(180.18, 9);
    expect(reserveFor({ qty: 2, kind: 'limit', price: 90, triggerPrice: null, leverage: 3, reduceOnly: false }, 100, fee)).toBeCloseTo(60.18, 9);
    expect(reserveFor({ qty: 3, kind: 'stop', price: null, triggerPrice: 95, leverage: 5, reduceOnly: false }, 100, fee, 2)).toBeCloseTo(19 + 0.285, 9);
    expect(reserveFor({ qty: 3, kind: 'limit', price: 110, triggerPrice: null, leverage: 5, reduceOnly: true }, 100, fee)).toBe(0);
    expect(available(1000, [pos(), pos({ market: 'spot', margin: 200 })], [{ reserved: 30 }])).toBe(750);
  });
  it('cross: liquidated when the money left no longer covers the maintenance margin', () => {
    const c = pos({ marginMode: 'cross', margin: 20 });
    expect(crossBreached(50, [c], [], new Map([[c.symbol, 80]]))).toBe(false);
    expect(crossBreached(50, [c], [], new Map([[c.symbol, 75.5]]))).toBe(false);
    expect(crossBreached(50, [c], [], new Map([[c.symbol, 75.3]]))).toBe(true);
    expect(crossBreached(50, [c], [], new Map())).toBe(false);
  });
});

describe('a price window reaching an order or a position (FD-PAPER §5)', () => {
  const w = (open: number, high: number, low: number, last: number) => ({ open, high, low, last });
  it('limit: at its price or better (the window opened past it)', () => {
    expect(orderTouch({ kind: 'limit', side: 'buy', price: 95, triggerPrice: null, triggered: false }, w(100, 101, 94, 99))).toEqual({ price: 95 });
    expect(orderTouch({ kind: 'limit', side: 'buy', price: 95, triggerPrice: null, triggered: false }, w(93, 96, 92, 95))).toEqual({ price: 93 });
    expect(orderTouch({ kind: 'limit', side: 'buy', price: 95, triggerPrice: null, triggered: false }, w(100, 101, 96, 99))).toBeNull();
    expect(orderTouch({ kind: 'limit', side: 'sell', price: 105, triggerPrice: null, triggered: false }, w(100, 106, 99, 104))).toEqual({ price: 105 });
  });
  it('stop: at its trigger, or worse when the window jumped past it; stop-limit: triggered first, then a limit', () => {
    expect(orderTouch({ kind: 'stop', side: 'buy', price: null, triggerPrice: 105, triggered: false }, w(100, 106, 99, 104))).toEqual({ price: 105 });
    expect(orderTouch({ kind: 'stop', side: 'buy', price: null, triggerPrice: 105, triggered: false }, w(107, 108, 106, 107))).toEqual({ price: 107 });
    expect(orderTouch({ kind: 'stop', side: 'sell', price: null, triggerPrice: 95, triggered: false }, w(100, 100, 94, 96))).toEqual({ price: 95 });
    expect(orderTouch({ kind: 'stop_limit', side: 'buy', price: 106, triggerPrice: 105, triggered: false }, w(100, 106, 99, 104))).toEqual({ triggered: true });
    expect(orderTouch({ kind: 'stop_limit', side: 'buy', price: 106, triggerPrice: 105, triggered: true }, w(107, 108, 105.5, 107))).toEqual({ price: 106 });
    expect(orderTouch({ kind: 'market', side: 'buy', price: null, triggerPrice: null, triggered: false }, w(100, 101, 99, 100.5))).toEqual({ price: 100.5 });
  });
  it('a position: the stop loss before the take profit in one window; the liquidation when it comes first; a jump: the opening', () => {
    expect(protectionTouch({ side: 'long', sl: 95, tp: 110 }, w(100, 111, 94, 100), null)).toEqual({ reason: 'sl', price: 95 });
    expect(protectionTouch({ side: 'long', sl: 95, tp: 110 }, w(100, 111, 99, 100), null)).toEqual({ reason: 'tp', price: 110 });
    expect(protectionTouch({ side: 'long', sl: 95, tp: 110 }, w(93, 94, 92, 93), null)).toEqual({ reason: 'sl', price: 93 });
    expect(protectionTouch({ side: 'long', sl: 80, tp: null }, w(100, 100, 85, 86), 90)).toEqual({ reason: 'liquidation', price: 90 });
    expect(protectionTouch({ side: 'long', sl: 95, tp: null }, w(100, 100, 85, 86), 90)).toEqual({ reason: 'sl', price: 95 });
    expect(protectionTouch({ side: 'short', sl: 105, tp: 90 }, w(100, 104, 89, 95), null)).toEqual({ reason: 'tp', price: 90 });
    expect(protectionTouch({ side: 'short', sl: 105, tp: 90 }, w(100, 106, 89, 95), null)).toEqual({ reason: 'sl', price: 105 });
    expect(protectionTouch({ side: 'long', sl: null, tp: null }, w(100, 120, 80, 100), null)).toBeNull();
  });
});
