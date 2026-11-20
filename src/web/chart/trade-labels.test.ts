// FD-TRADEUI: the trade boxes on the chart (as TradingView's): their content, colours, geometry and what their × does.
import { describe, expect, it } from 'vitest';
import type { AccountView, BalanceRow, OrderRow, PositionRow } from '../../shared/api-types.ts';
import { tradeLinesOf } from './pnl.ts';
import { lineActionOf, type AccountLine } from './trade-drafts.ts';
import { chartLineOf, LABEL_RIGHT, labelGeometry, labelPartAt, labelText, lineColor, TRADE_COLORS } from './trade-labels.ts';

const account = (over: Partial<AccountView> = {}): AccountView => ({
  id: 7, exchange: 'kucoin', kind: 'crypto', env: 'live', label: 'Main', keyHint: '…', createdAt: 0, lastOkAt: null, lastError: null, permissions: null, permissionWarning: false, fundsRisk: false,
  trading: { supported: true, enabled: true, markets: ['spot', 'futures'], reason: null }, ...over,
}); // prettier-ignore
const pos = (over: Partial<PositionRow> = {}): PositionRow => ({
  symbol: 'INJ/USDT:USDT', side: 'long', contracts: 5, size: 5, entryPrice: 7.62, markPrice: 7.7, unrealizedPnl: 0.4, percentage: 1, liquidationPrice: 5.1, leverage: 5, marginMode: 'isolated', notional: 38, ...over,
}); // prettier-ignore
const order = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: 'o1', market: 'futures', symbol: 'INJ/USDT:USDT', type: 'market', side: 'sell', price: null, triggerPrice: 7.392, amount: 5, filled: 0, status: 'open', timestamp: 1, reduceOnly: true, stop: 'down', ...over,
}); // prettier-ignore
const bal = (over: Partial<BalanceRow> = {}): BalanceRow => ({
  asset: 'INJ', account: 'trade', total: 10, free: 10, used: 0, price: 7.7, value: 77, avgPrice: 7, avgSource: 'fills', pnl: 7, pnlPct: 10, ...over,
}); // prettier-ignore
const linesOf = (a: AccountView, orders: OrderRow[], positions = [pos()], balances: BalanceRow[] = []): AccountLine[] =>
  tradeLinesOf({ base: 'INJ', quote: 'USDT', lastPrice: 7.7, positions, balances, orders, accountId: a.id }).lines.map((l) => ({ ...l, account: a }));

describe('the boxes (FD-TRADEUI)', () => {
  const a = account();
  const entry = order({ id: 'e1', type: 'limit', side: 'buy', price: 7, triggerPrice: null, reduceOnly: false, stop: null, amount: 3, contractSize: 0.1 });
  const lines = linesOf(a, [order(), entry]);
  const by = (role: string) => lines.find((l) => l.role === role) as AccountLine;

  it('quantity | PnL (the entry: now; a SL / TP: there) | what an order is; the liquidation has no PnL', () => {
    expect(labelText(by('entry'), by('entry').price, 7.7)).toEqual({ text: '+0,40 USDT', tone: 'up' });
    expect(labelText(by('sl'), 7.392, 7.7)).toEqual({ text: '−1,14 USDT', tone: 'down' });
    expect(labelText(by('order'), 7, 7.7)).toEqual({ text: 'Limită cumpărare', tone: null });
    expect(labelText(by('liquidation'), 5.1, 7.7)).toEqual({ text: 'Lichidare', tone: null });
    // No price now: no PnL for the entry yet.
    expect(labelText(by('entry'), 7.62, null).text).toBe('—');
  });

  it("TradingView's colours: a long blue, a short red, SL orange, TP green, an order its side's", () => {
    expect([lineColor(by('entry'), TRADE_COLORS), lineColor(by('sl'), TRADE_COLORS), lineColor(by('order'), TRADE_COLORS)]).toEqual([TRADE_COLORS.long, TRADE_COLORS.sl, TRADE_COLORS.buy]);
    const short = linesOf(a, [], [pos({ side: 'short' })]).find((l) => l.role === 'entry') as AccountLine;
    expect(lineColor(short, TRADE_COLORS)).toBe(TRADE_COLORS.short);
  });

  it('the chart line: no library title, the box with the quantity filled on the entry, the order dashed, a draft dotted', () => {
    const spec = chartLineOf(by('entry'), { last: 7.7, drafted: false, several: false, palette: TRADE_COLORS, close: true, draggable: false });
    // FIX-DECIMALS: the money the position took (7,62 × 5 at 5×), not its 5 units.
    expect(spec).toMatchObject({ title: '', style: 'solid', color: TRADE_COLORS.long, label: { qty: '7,62 USDT', text: '+0,40 USDT', textColor: TRADE_COLORS.up, close: true, fill: true } });
    // A futures order whose leverage the platform does not say: no amount.
    expect(chartLineOf(by('order'), { last: 7.7, drafted: false, several: false, palette: TRADE_COLORS, close: true, draggable: true })).toMatchObject({ style: 'dashed', label: { qty: null, fill: false } });
    // A pending change (moved, not confirmed): the line dimmed and dotted, its price label solid, the box tinted.
    expect(chartLineOf(by('sl'), { last: 7.7, drafted: true, several: true, palette: TRADE_COLORS, close: true, draggable: true })).toMatchObject({
      style: 'dotted',
      color: `${TRADE_COLORS.sl}99`,
      axisLabelColor: TRADE_COLORS.sl,
      label: { text: '−1,14 USDT · Main', pending: true },
    });
    expect(chartLineOf(by('sl'), { last: 7.7, drafted: false, several: false, palette: TRADE_COLORS, close: true, draggable: true }).label).not.toHaveProperty('pending');
  });

  it('FIX-DECIMALS: the money a line stands for, never the units: the margin, the cost, the share a SL / TP closes', () => {
    const at = (l: AccountLine | undefined) => chartLineOf(l as AccountLine, { last: 7.7, drafted: false, several: false, palette: TRADE_COLORS, close: true, draggable: true }).label?.qty;
    const role = (ls: AccountLine[], r: string) => ls.find((l) => l.role === r);
    // The platform's own margin (KuCoin's posInit) first; a SL / TP closing all of it: all of it.
    const own = linesOf(a, [order()], [pos({ margin: 7.8 })]);
    expect([at(role(own, 'entry')), at(role(own, 'sl'))]).toEqual(['7,80 USDT', '7,80 USDT']);
    // A stop loss for 2 of the 5 contracts: its share (7,62 × 2 / 5).
    expect(at(role(linesOf(a, [order({ amount: 2 })]), 'sl'))).toBe('3,05 USDT');
    // A spot holding: what it cost (10 INJ at 7).
    expect(at(role(linesOf(a, [], [], [bal()]), 'entry'))).toBe('70,00 USDT');
    // An order: its value on spot (2 × 7), over its leverage on futures (3 × 0,1 × 7 / 5).
    const spotBuy = order({ id: 's1', market: 'spot', symbol: 'INJ/USDT', type: 'limit', side: 'buy', price: 7, triggerPrice: null, reduceOnly: false, stop: null, amount: 2 });
    const futBuy = order({ id: 'f1', type: 'limit', side: 'buy', price: 7, triggerPrice: null, reduceOnly: false, stop: null, amount: 3, contractSize: 0.1, leverage: 5 });
    const ords = linesOf(a, [spotBuy, futBuy], []);
    expect(ords.filter((l) => l.role === 'order').map(at)).toEqual(['14,00 USDT', '0,42 USDT']);
    // A contract settled in its coin: in the coin, with the decimals it reads with; its value unknown: no amount.
    expect(at(role(linesOf(a, [], [pos({ symbol: 'INJ/USD:INJ', margin: 0.00123456 })]), 'entry'))).toBe('0,0012 INJ');
    expect(at(role(linesOf(a, [], [pos({ symbol: 'INJ/USD:INJ' })]), 'entry'))).toBeNull();
    // The liquidation has none.
    expect(at(role(own, 'liquidation'))).toBeNull();
  });

  it('geometry: 64 px from the price scale, the × its last 20 px; kept inside a narrow pane', () => {
    const measure = (t: string) => t.length * 7;
    const spec = { qty: '5', text: '+0,40 USDT', textColor: '#fff', close: true, fill: true };
    const g = labelGeometry(spec, 1000, measure);
    expect(g.x + g.w).toBe(1000 - LABEL_RIGHT);
    expect([labelPartAt(g, g.x + g.w - 5), labelPartAt(g, g.x + 5), labelPartAt(g, g.x - 1)]).toEqual(['close', 'body', null]);
    expect(labelGeometry(spec, 120, measure).x).toBe(4);
    expect(labelPartAt(labelGeometry({ ...spec, close: false }, 1000, measure), 1000 - LABEL_RIGHT - 3)).toBe('body');
  });
});

describe('what the × does (FD-TRADEUI)', () => {
  const a = account();
  it("a position's entry: its order form; its SL: removed (checked, then confirmed); an order: cancelled", () => {
    const entry = order({ id: 'e1', type: 'limit', side: 'buy', price: 7, triggerPrice: null, reduceOnly: false, stop: null });
    const lines = linesOf(a, [order(), entry]);
    const portfolio = { positions: [pos()], balances: [], orders: [order(), entry] } as never;
    const act = (role: string) => lineActionOf(lines.find((l) => l.role === role) as AccountLine, portfolio);
    expect(act('entry')).toMatchObject({ kind: 'ticket', seed: { market: 'futures', side: 'sell', reduceOnly: true, amount: 5 } });
    expect(act('sl')).toMatchObject({ kind: 'dialog', action: { kind: 'modify', ticket: { market: 'futures', position: { side: 'long' }, changes: [{ what: 'sl', orderId: 'o1', level: null }] } } });
    expect(act('order')).toMatchObject({ kind: 'dialog', action: { kind: 'cancel', market: 'futures', order: { id: 'e1' } } });
    expect(act('liquidation')).toBeNull();
  });

  it('none with trading off; a holding: its "Vinde" form', () => {
    const off = account({ trading: { supported: true, enabled: false, markets: ['futures'], reason: null } });
    expect(lineActionOf(linesOf(off, [order()]).find((l) => l.role === 'sl') as AccountLine, { positions: [pos()], balances: [], orders: [] } as never)).toBeNull();
    const spot = linesOf(a, [], [], [bal()]).find((l) => l.role === 'entry') as AccountLine;
    expect(lineActionOf(spot, { positions: [], balances: [bal()], orders: [] } as never)).toMatchObject({ kind: 'ticket', seed: { market: 'spot', side: 'sell', amount: 10 } });
  });
});
