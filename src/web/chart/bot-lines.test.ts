// FIX-BOTLEVELS: a real bot's stop loss / take profit on the chart: which positions, the PnL there, the box, and a level
// that is an order at the platform drawn once. FIX-BOTDRAG: dragged, what goes to the bot.
import { describe, expect, it } from 'vitest';
import type { AccountView, OrderRow, PositionRow } from '../../shared/api-types.ts';
import type { BotLevel } from '../../shared/bot.ts';
import { BOT_NAME_MAX, botLinesOf, onChart, withoutDuplicates, stillHeld } from './bot-lines.ts';
import { PNL_COLORS, tradeLinesOf } from './pnl.ts';
import { anchorOf, botDraftOf, draftTicket, isDraggable, lineActionOf, liveDrafts, withDrafts, withSent, type AccountLine } from './trade-drafts.ts';
import { chartLineOf, TRADE_COLORS } from './trade-labels.ts';

const account = (over: Partial<AccountView> = {}): AccountView => ({
  id: 1, exchange: 'kucoin', kind: 'crypto', env: 'live', label: 'KuCoin', keyHint: '…', createdAt: 0, lastOkAt: null, lastError: null, permissions: null, permissionWarning: false, fundsRisk: false,
  trading: { supported: true, enabled: true, markets: ['spot', 'futures'], reason: null }, ...over,
}); // prettier-ignore
// The real one (11 nov 2026, 03:00 in Romania): bot 2's LONG JUP on KuCoin, its levels kept by the bot.
const OPENED = Date.UTC(2026, 10, 11, 1);
const level = (over: Partial<BotLevel> = {}): BotLevel => ({
  bot: { id: 2, name: 'Premium futures' }, accountId: 1, active: true, market: 'futures', symbol: 'JUP/USDT', side: 'long', qty: 3546, entry: 0.2538, sl: 0.24546642629734094, tp: 0.2642335737026591, openedAt: OPENED, margin: 300.02, ...over,
}); // prettier-ignore
const pos = (over: Partial<PositionRow> = {}): PositionRow => ({
  symbol: 'JUP/USDT:USDT', side: 'long', contracts: 3546, size: 3546, entryPrice: 0.2538, markPrice: 0.255, unrealizedPnl: 4.2, percentage: 1, liquidationPrice: 0.17, leverage: 3, marginMode: 'isolated', notional: 904, ...over,
}); // prettier-ignore
const order = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: 'o1', market: 'futures', symbol: 'JUP/USDT:USDT', type: 'market', side: 'sell', price: null, triggerPrice: 0.245, amount: 3546, filled: 0, status: 'open', timestamp: 1, reduceOnly: true, stop: 'down', ...over,
}); // prettier-ignore
const JUP = { base: 'JUP', quote: 'USDT', stock: false, accountId: 1 };
const withAccount = (a: AccountView, lines: ReturnType<typeof botLinesOf>): AccountLine[] => lines.map((l) => ({ ...l, account: a }));
const accountLines = (a: AccountView, orders: OrderRow[], positions = [pos()]): AccountLine[] =>
  tradeLinesOf({ base: 'JUP', quote: 'USDT', lastPrice: 0.255, positions, balances: [], orders, accountId: a.id }).lines.map((l) => ({ ...l, account: a }));

describe('onChart', () => {
  it('a coin by its base (futures on any quote, spot on the same pair), a share by its ticker', () => {
    expect(onChart(level(), JUP)).toBe(true);
    expect(onChart(level(), { ...JUP, quote: 'USDC' })).toBe(true);
    expect(onChart(level({ market: 'spot' }), { ...JUP, quote: 'USDC' })).toBe(false);
    expect(onChart(level({ market: 'spot' }), JUP)).toBe(true);
    expect(onChart(level({ symbol: 'JUPX/USDT' }), JUP)).toBe(false);
    expect(onChart(level({ market: 'stock', symbol: 'NVDA' }), { base: 'NVDA', quote: 'USD', stock: true })).toBe(true);
    expect(onChart(level({ market: 'stock', symbol: 'NVDA' }), { base: 'NVD', quote: 'USD', stock: true })).toBe(false);
    // COIN the share is not COIN/USDT the coin, either way.
    expect(onChart(level({ market: 'stock', symbol: 'COIN' }), { base: 'COIN', quote: 'USDT', stock: false })).toBe(false);
    expect(onChart(level({ symbol: 'COIN/USDT' }), { base: 'COIN', quote: 'USD', stock: true })).toBe(false);
  });

  it('FD-FXCOMMODITIES: a pair\'s bot (EUR/USD) on its chart, by the accounts\' compact form; held while eToro shows EURUSD', () => {
    const eur = level({ market: 'stock', symbol: 'EUR/USD', side: 'long' });
    expect(onChart(eur, { base: 'EURUSD', quote: 'USD', stock: true })).toBe(true);
    expect(onChart(eur, { base: 'EUR', quote: 'USD', stock: true })).toBe(false);
    const read = (positions: { symbol: string; side: string }[], balances: { asset: string; total: number }[] = []) => ({ positions, balances });
    expect(stillHeld(eur, read([{ symbol: 'EURUSD/USD', side: 'long' }]))).toBe(true);
    expect(stillHeld(eur, read([], [{ asset: 'EURUSD', total: 1000 }]))).toBe(true);
    expect(stillHeld(eur, read([{ symbol: 'GBPUSD/USD', side: 'long' }]))).toBe(false);
  });
});

describe('botLinesOf', () => {
  it("the bot's SL and TP with the PnL of the bot's position there, dashed, in the SL / TP colours", () => {
    const lines = botLinesOf([level()], JUP);
    expect(lines.map((l) => [l.id, l.role, l.price, l.title, l.style, l.color])).toEqual([
      ['1|bot|2|JUP/USDT|long|sl', 'sl', 0.24546642629734094, 'SL bot −29,55 USDT (−3,3%)', 'dashed', PNL_COLORS.sl],
      ['1|bot|2|JUP/USDT|long|tp', 'tp', 0.2642335737026591, 'TP bot +37,00 USDT (+4,1%)', 'dashed', PNL_COLORS.tp],
    ]);
    expect(lines[0]).toMatchObject({ group: '1|bot|2|JUP/USDT|long', basis: { long: true, entry: 0.2538, qty: 3546, quote: 'USDT' }, bot: { id: 2, tag: 'bot', symbol: 'JUP/USDT', side: 'long', openedAt: OPENED } });
    // No order and no position: nothing to change at the platform.
    expect(lines.every((l) => l.order === undefined && l.position === undefined)).toBe(true);
  });

  it('a short: the SL above, its PnL negative', () => {
    const [sl] = botLinesOf([level({ side: 'short', sl: 0.27, tp: null })], JUP);
    expect(sl?.title).toBe('SL bot −57,45 USDT (−6,4%)');
    expect(sl?.basis?.long).toBe(false);
  });

  it('a missing level draws no line; another account, asset, an empty position draw none', () => {
    expect(botLinesOf([level({ tp: null })], JUP).map((l) => l.role)).toEqual(['sl']);
    expect(botLinesOf([level({ sl: null, tp: null })], JUP)).toEqual([]);
    expect(botLinesOf([level({ sl: 0, tp: Number.NaN })], JUP)).toEqual([]);
    expect(botLinesOf([level({ accountId: 3 })], JUP)).toEqual([]);
    expect(botLinesOf([level({ symbol: 'SOL/USDT' })], JUP)).toEqual([]);
    expect(botLinesOf([level({ qty: 0 })], JUP)).toEqual([]);
  });

  it("the box's tag: the bot, its short name when several bots have levels on the chart, stopped while it has a problem", () => {
    expect(botLinesOf([level()], JUP, PNL_COLORS, true)[0]?.bot?.tag).toBe('bot Premium futures');
    const long = botLinesOf([level({ bot: { id: 2, name: 'RENDER/USDT +7 · Premium' } })], JUP, PNL_COLORS, true)[0]?.bot?.tag ?? '';
    expect(long).toBe('bot RENDER/USDT +7…');
    expect(long.length - 'bot '.length).toBeLessThanOrEqual(BOT_NAME_MAX);
    expect(botLinesOf([level({ active: false })], JUP)[0]?.bot?.tag).toBe('bot oprit');
    expect(botLinesOf([level({ active: false })], JUP, PNL_COLORS, true)[0]?.bot?.tag).toBe('bot Premium futures oprit');
    expect(botLinesOf([level()], { ...JUP, account: 'KuCoin' })[0]?.name).toBe('SL bot (KuCoin)');
  });

  it('ids stay apart across bots, sides and a repeated position of one bot', () => {
    const lines = botLinesOf([level(), level({ bot: { id: 5, name: 'DCA' } }), level({ side: 'short' }), level()], JUP);
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
    expect(lines.at(-1)?.id).toBe('1|bot|2|JUP/USDT|long#1|tp');
  });

  it('a share: priced in USD', () => {
    const [sl] = botLinesOf([level({ market: 'stock', symbol: 'NVDA', qty: 10, entry: 190, sl: 180, tp: null })], { base: 'NVDA', quote: 'USD', stock: true, accountId: 1 });
    expect(sl?.title).toBe('SL bot −100,00 USD (−5,3%)');
  });
});

describe('on the chart', () => {
  const a = account();
  const bot = withAccount(a, botLinesOf([level()], JUP));
  const [sl, tp] = bot as [AccountLine, AccountLine];

  it('dragged (FIX-BOTDRAG; also with trading from Sentiq off: no order leaves), no ×, dashed, the box says it is the bot’s', () => {
    expect(bot.every((l) => isDraggable(l, l.account))).toBe(true);
    const off = account({ trading: { supported: true, enabled: false, markets: [], reason: null } });
    expect(withAccount(off, botLinesOf([level()], JUP)).every((l) => isDraggable(l, l.account))).toBe(true);
    expect(bot.map((l) => lineActionOf(l, undefined))).toEqual([null, null]);
    expect(chartLineOf(sl, { last: 0.255, drafted: false, several: false, palette: TRADE_COLORS, close: false, draggable: true })).toMatchObject({
      style: 'dashed',
      draggable: true,
      label: { qty: '300,02 USDT', text: '−29,55 USDT · bot', close: false, fill: false },
    });
    // FIX-DECIMALS: the money the bot's position took, never its units; a server that does not say it: no amount.
    const [bare] = withAccount(account(), botLinesOf([level({ margin: undefined })], JUP));
    expect(chartLineOf(bare!, { last: 0.255, drafted: false, several: false, palette: TRADE_COLORS, close: false, draggable: true }).label?.qty).toBeNull();
    expect(chartLineOf(tp, { last: 0.255, drafted: false, several: true, palette: TRADE_COLORS, close: false, draggable: false }).label?.text).toBe('+37,00 USDT · bot · KuCoin');
    // An order's SL / TP stays solid.
    const own = accountLines(a, [order()]).find((l) => l.role === 'sl') as AccountLine;
    expect(chartLineOf(own, { last: 0.255, drafted: false, several: false, palette: TRADE_COLORS, close: true, draggable: true }).style).toBe('solid');
  });

  it('a level that is an order there already is drawn once (the order’s); another price, side or account keeps both', () => {
    const same = accountLines(a, [order({ triggerPrice: 0.2455 })]);
    expect(withoutDuplicates(bot, same).map((l) => l.role)).toEqual(['tp']);
    // 0.245 is 0,19 % away: both.
    expect(withoutDuplicates(bot, accountLines(a, [order()])).map((l) => l.role)).toEqual(['sl', 'tp']);
    // The short's SL is not the long's.
    const short = accountLines(a, [order({ side: 'buy', positionSide: 'short', triggerPrice: 0.2455, stop: 'up' })], [pos({ side: 'short' })]);
    expect(withoutDuplicates(bot, short)).toHaveLength(2);
    // Another account's order.
    const other = accountLines(account({ id: 9 }), [order({ triggerPrice: 0.2455 })]);
    expect(withoutDuplicates(bot, other)).toHaveLength(2);
  });

  it('a level just sent (FIX-SLTPDUP) never lands on the bot’s line', () => {
    const lines = [...accountLines(a, [order()]), ...bot];
    const dragged = lines.find((l) => l.role === 'sl' && l.order) as AccountLine;
    // Sent at the bot's level: the bot's line is in another group, so the sent level waits for the platform's order.
    const r = withSent(lines, [{ line: dragged, price: sl.price, until: 2 }], 1);
    expect(r.waiting).toHaveLength(1);
    expect(r.lines.filter((l) => l.role === 'sl').map((l) => [l.bot ? 'bot' : 'order', l.price])).toEqual([
      ['order', sl.price],
      ['bot', sl.price],
    ]);
  });
});

describe('FIX-BOTDRAG: dragged', () => {
  const a = account();
  const bot = withAccount(a, botLinesOf([level()], JUP));
  const [sl, tp] = bot as [AccountLine, AccountLine];
  const group = sl.group;
  const lines = [...accountLines(a, []), ...bot];

  it('what goes to the bot: the position (symbol, side, opening) and the levels dragged', () => {
    expect(botDraftOf(lines, { [tp.id]: 0.27 }, group)).toEqual({ botId: 2, move: { symbol: 'JUP/USDT', side: 'long', openedAt: OPENED, tp: 0.27 } });
    expect(botDraftOf(lines, { [sl.id]: 0.24, [tp.id]: 0.27 }, group)).toEqual({ botId: 2, move: { symbol: 'JUP/USDT', side: 'long', openedAt: OPENED, sl: 0.24, tp: 0.27 } });
    // Nothing dragged in the group, or another group: nothing.
    expect(botDraftOf(lines, {}, group)).toBeNull();
    const entry = lines.find((l) => l.role === 'entry') as AccountLine;
    expect(botDraftOf(lines, { [sl.id]: 0.24 }, entry.group)).toBeNull();
    // Not an order: the platform's change has nothing to do.
    expect(draftTicket(lines, { [sl.id]: 0.24 }, group)).toBeNull();
  });

  it('Confirm / Discard on the line dragged (the stop loss when both are); the box shows the PnL at the new level', () => {
    expect(anchorOf(group, lines, { [tp.id]: 0.27 })?.id).toBe(tp.id);
    expect(anchorOf(group, lines, { [sl.id]: 0.24, [tp.id]: 0.27 })?.id).toBe(sl.id);
    expect(anchorOf(group, lines)).toBeUndefined();
    const shown = withDrafts(lines, { [sl.id]: 0.24 }).find((l) => l.id === sl.id);
    expect(shown).toMatchObject({ price: 0.24, style: 'dotted', title: 'SL bot −48,93 USDT (−5,4%)' });
  });

  it('a draft stays while the bot keeps the position, and goes with its line', () => {
    const drafts = { [sl.id]: 0.24 };
    expect(liveDrafts(lines, drafts)).toBe(drafts);
    expect(liveDrafts(accountLines(a, []), drafts)).toEqual({});
  });
});

describe('FIX-BOTLEVELGONE: a bot level only while its position is held', () => {
  const lv = (over: object = {}) => ({ market: 'futures' as const, symbol: 'BTC/USDT', side: 'long' as const, ...over });
  const pf = (positions: { symbol: string; side: string }[], balances: { asset: string; total: number }[] = [], errors?: object) => ({ positions, balances, ...(errors ? { errors } : {}) });

  it('a futures position of its side keeps it; closed, or only the other side: gone', () => {
    expect(stillHeld(lv(), pf([{ symbol: 'BTC/USDT:USDT', side: 'long' }]))).toBe(true);
    expect(stillHeld(lv(), pf([]))).toBe(false);
    expect(stillHeld(lv(), pf([{ symbol: 'BTC/USDT:USDT', side: 'short' }]))).toBe(false);
    expect(stillHeld(lv({ side: 'short' }), pf([{ symbol: 'BTC/USDT:USDT', side: 'short' }]))).toBe(true);
  });

  it('a spot or share long: a holding keeps it; a broker short needs its position', () => {
    expect(stillHeld(lv({ market: 'spot', symbol: 'SOL/USDT' }), pf([], [{ asset: 'SOL', total: 2 }]))).toBe(true);
    expect(stillHeld(lv({ market: 'spot', symbol: 'SOL/USDT' }), pf([], [{ asset: 'SOL', total: 0 }]))).toBe(false);
    expect(stillHeld(lv({ market: 'stock', symbol: 'AAPL' }), pf([{ symbol: 'AAPL/USD', side: 'long' }]))).toBe(true);
    expect(stillHeld(lv({ market: 'stock', symbol: 'AAPL' }), pf([], [{ asset: 'AAPL', total: 3 }]))).toBe(true);
    expect(stillHeld(lv({ market: 'stock', symbol: 'AMD', side: 'short' }), pf([], [{ asset: 'AMD', total: 3 }]))).toBe(false);
  });

  it('not read yet, or its positions failed: kept (never hidden on a guess)', () => {
    expect(stillHeld(lv(), undefined)).toBe(true);
    expect(stillHeld(lv(), pf([], [], { positions: { code: 'NETWORK', message: 'x' } }))).toBe(true);
  });
});
