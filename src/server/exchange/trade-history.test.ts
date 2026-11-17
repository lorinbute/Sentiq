// FD-TRADES: the history's rows from an exchange's closed positions and a broker's trades, and the merge with the bots'.
import type { Position } from 'ccxt';
import { describe, expect, it } from 'vitest';
import { brokerRow, HISTORY_MAX_ROWS, journalEntry, marginOf, MATCH_TOLERANCE_MS, mergeHistory, pnlPercent, positionRow, symbolKey, withJournal, type JournalEntry, type JournalRow, type TradeHistoryRow } from './trade-history.ts';

const MIN = 60_000;
const T = Date.parse('2026-11-09T10:00:00Z');
const pos = (p: Partial<Position> & { info?: Record<string, unknown> }): Position => ({ info: {}, ...p }) as Position;

describe('FD-TRADES: rows from the platforms', () => {
  it('KuCoin classic: the opening time from `openTime`, no size, a liquidation', () => {
    const r = positionRow(
      'kucoin',
      pos({
        id: '500000000036305465',
        symbol: 'BTC/USDT:USDT',
        side: 'long',
        entryPrice: 93859.8,
        lastPrice: 94443.5,
        leverage: 0,
        realizedPnl: 0.51,
        lastUpdateTimestamp: 1735589352069,
        info: { openTime: 1735549162120, closeTime: 1735589352069, type: 'LIQUID_LONG', pnl: '0.51' },
      }),
    );
    expect(r).toMatchObject({
      key: 'a|BTC/USDT:USDT|500000000036305465',
      source: 'account',
      bot: null,
      open: false,
      symbol: 'BTC/USDT',
      market: 'futures',
      side: 'long',
      qty: null,
      leverage: null,
      entry: 93859.8,
      exit: 94443.5,
      sl: null,
      tp: null,
      pnl: 0.51,
      pnlPct: null,
      currency: 'USDT',
      openedAt: 1735549162120,
      closedAt: 1735589352069,
      reason: 'lichidare',
    });
  });

  it('KuCoin unified: the opening time and the size from ccxt, the percent of the margin', () => {
    const r = positionRow('kucoin', pos({ id: '3', symbol: 'LTC/USDT:USDT', side: 'short', entryPrice: 51.07, lastPrice: 50.49, contracts: 176, contractSize: 0.1, leverage: 3, realizedPnl: 8.42, timestamp: T - 4 * 3_600_000, lastUpdateTimestamp: T, info: {} }));
    expect(r).toMatchObject({ side: 'short', qty: 17.6, leverage: 3, openedAt: T - 4 * 3_600_000, closedAt: T, reason: null });
    expect(r?.qty).toBeCloseTo(17.6, 9);
    expect(r?.pnlPct).toBeCloseTo((8.42 / ((17.6 * 51.07) / 3)) * 100, 9);
  });

  it("Bybit: no opening time (its timestamp is the close's), a liquidation; OKX: ADL; Bitget's net profit", () => {
    const by = positionRow('bybit', pos({ id: 'b1', symbol: 'SOL/USDT:USDT', side: 'long', entryPrice: 150, lastPrice: 140, contracts: 2, leverage: 10, realizedPnl: -20, timestamp: T, lastUpdateTimestamp: T, info: { execType: 'BustTrade' } }));
    expect(by).toMatchObject({ openedAt: null, closedAt: T, reason: 'lichidare', qty: 2 });
    expect(positionRow('okx', pos({ id: 'o1', symbol: 'ETH/USDT:USDT', side: 'short', timestamp: T - MIN, lastUpdateTimestamp: T, realizedPnl: 1, info: { type: '5' } }))?.reason).toBe('ADL');
    expect(positionRow('okx', pos({ id: 'o2', symbol: 'ETH/USDT:USDT', side: 'short', timestamp: T - MIN, lastUpdateTimestamp: T, realizedPnl: 1, info: { type: '2' } }))?.reason).toBeNull();
    expect(positionRow('bitget', pos({ id: 'g1', symbol: 'BTC/USDT:USDT', side: 'long', lastUpdateTimestamp: T, realizedPnl: 5, info: { netProfit: '4.2' } }))?.pnl).toBe(4.2);
    // A coin-settled contract keeps its coin.
    expect(positionRow('kucoin', pos({ id: 'c', symbol: 'BTC/USD:BTC', side: 'long', lastUpdateTimestamp: T, realizedPnl: 0.001 }))?.currency).toBe('BTC');
  });

  it('a position without a side or a close time is left out', () => {
    expect(positionRow('kucoin', pos({ id: 'x', symbol: 'BTC/USDT:USDT', lastUpdateTimestamp: T }))).toBeNull();
    expect(positionRow('kucoin', pos({ id: 'y', symbol: 'BTC/USDT:USDT', side: 'long' }))).toBeNull();
  });

  it("a broker's trade: its own currency, the invested amount for the percent, unknown fields as null", () => {
    const e = brokerRow({ id: '7', closedAt: T, pnl: 49.9, net: 49.9, symbol: 'NVDA', side: 'long', qty: 11.6, entry: 171.2, exit: 175.5, openedAt: T - 3_600_000, sl: 150, tp: null, leverage: 5, market: 'cfd', invested: 1990 }, 'USD');
    expect(e).toMatchObject({ key: 'a|7', symbol: 'NVDA', market: 'cfd', side: 'long', sl: 150, tp: null, currency: 'USD', openedAt: T - 3_600_000 });
    expect(e.pnlPct).toBeCloseTo((49.9 / 1990) * 100, 9);
    const t212 = brokerRow({ id: '30', closedAt: T, pnl: 15, net: 15, symbol: 'AAPL', side: 'long', qty: 2, exit: 250, market: 'stock' }, 'EUR');
    expect(t212).toMatchObject({ entry: null, openedAt: null, pnlPct: null, currency: 'EUR', leverage: null });
    const ibkr = brokerRow({ id: 'A', closedAt: T, pnl: 50, net: 45, currency: 'USD' }, 'EUR');
    expect(ibkr).toMatchObject({ symbol: '?', side: null, market: 'stock', pnl: 50, currency: 'USD' });
    // A share is shown without its currency.
    expect(brokerRow({ id: 'z', closedAt: T, pnl: 1, net: 1, symbol: 'SAP/EUR' }, 'EUR').symbol).toBe('SAP');
  });

  it('the percent of the margin: leverage 1 when unknown; none without the size or the entry', () => {
    expect(pnlPercent(10, 2, 50, 2)).toBe(20);
    expect(pnlPercent(10, 2, 50, null)).toBe(10);
    expect(pnlPercent(10, null, 50, 2)).toBeNull();
    expect(pnlPercent(null, 2, 50, 2)).toBeNull();
    expect(symbolKey('ltc/usdt:usdt')).toBe('LTC/USDT');
    expect(symbolKey('NVDA/USD', true)).toBe('NVDA');
  });
});

const row = (r: Partial<TradeHistoryRow> & Pick<TradeHistoryRow, 'key'>): TradeHistoryRow => ({
  source: 'account',
  bot: null,
  open: false,
  symbol: 'LTC/USDT',
  market: 'futures',
  side: 'short',
  qty: 1,
  leverage: 3,
  entry: 50,
  exit: 49,
  sl: null,
  tp: null,
  pnl: 1,
  margin: null,
  pnlPct: null,
  currency: 'USDT',
  openedAt: T - 3_600_000,
  closedAt: T,
  reason: null,
  ...r,
});
const bot = (r: Partial<TradeHistoryRow> & Pick<TradeHistoryRow, 'key'>) => row({ source: 'bot', bot: { id: 2, name: 'Crypto' }, sl: 52, tp: 49.5, ...r });
const keys = (x: { rows: TradeHistoryRow[] }) => x.rows.map((r) => r.key);

describe('FD-TRADES: each trade once', () => {
  const from = T - 30 * 86_400_000;
  const now = T + 3_600_000;

  it("the platform's row of a bot's trade is hidden; the bot's stays, with its levels", () => {
    const b = bot({ key: 'b|7', openedAt: T - 3_600_000 + 20_000, closedAt: T + 5_000 });
    const a = row({ key: 'a|LTC/USDT:USDT|1', openedAt: T - 3_600_000, closedAt: T });
    const m = mergeHistory([b], [a], from, now, now);
    expect(keys(m)).toEqual(['b|7']);
    expect(m.rows[0]).toMatchObject({ sl: 52, tp: 49.5 });
  });

  it("a bot's spot trade does not hide a futures position on the same pair, at the same time", () => {
    const spot = bot({ key: 'b|1', symbol: 'ETH/USDT', side: 'long', market: 'spot', openedAt: T - 3_600_000, closedAt: T });
    const fut = row({ key: 'a|1', symbol: 'ETH/USDT', side: 'long', market: 'futures', openedAt: T - 1_800_000, closedAt: T });
    expect(keys(mergeHistory([spot], [fut], from, now, now)).sort()).toEqual(['a|1', 'b|1']);
  });

  it('another symbol, the other side or another time is not the bot’s', () => {
    const b = bot({ key: 'b|7', openedAt: T - 3_600_000, closedAt: T });
    const other = row({ key: 'a|sol', symbol: 'SOL/USDT', openedAt: T - 3_000_000, closedAt: T - 1_000_000 });
    const long = row({ key: 'a|long', side: 'long', openedAt: T - 3_000_000, closedAt: T - 1_000_000 });
    const before = row({ key: 'a|before', openedAt: T - 3_600_000 - MATCH_TOLERANCE_MS - 1, closedAt: T - 3_600_000 - MATCH_TOLERANCE_MS - 1 });
    const after = row({ key: 'a|after', openedAt: T + MATCH_TOLERANCE_MS + 1, closedAt: T + 2 * MATCH_TOLERANCE_MS });
    const edge = row({ key: 'a|edge', openedAt: T + MATCH_TOLERANCE_MS, closedAt: T + 2 * MATCH_TOLERANCE_MS });
    expect(keys(mergeHistory([b], [other, long, before, after, edge], from, now, now)).sort()).toEqual(['a|after', 'a|before', 'a|long', 'a|sol', 'b|7'].sort());
  });

  it('a grid: many bot trades, one platform position, hidden; an exit seen late still hides it', () => {
    const slots = [1, 2, 3].map((i) => bot({ key: `b|${i}`, openedAt: T - i * 600_000, closedAt: T - i * 300_000 }));
    const a = row({ key: 'a|net', openedAt: T - 3 * 600_000, closedAt: T - 300_000 });
    expect(keys(mergeHistory(slots, [a], from, now, now))).toEqual(['b|1', 'b|2', 'b|3']);
    // Paused: the bot saw the close three hours late; the platform's position opened while the bot held it.
    const late = bot({ key: 'b|late', openedAt: T - 3_600_000, closedAt: T + 3 * 3_600_000, reason: 'din afară' });
    const closedByHand = row({ key: 'a|hand', openedAt: T - 3_600_000 - 10_000, closedAt: T - 1_800_000 });
    expect(keys(mergeHistory([late], [closedByHand], from, T + 4 * 3_600_000, T + 4 * 3_600_000))).toEqual(['b|late']);
  });

  it('an open bot trade hides what opened since, up to now; a platform row without an opening time matches by its close', () => {
    const open = bot({ key: 'o|2|0', open: true, exit: null, closedAt: null, openedAt: T - 600_000 });
    const a = row({ key: 'a|1', openedAt: T - 500_000, closedAt: T });
    const bybit = row({ key: 'a|2', openedAt: null, closedAt: T - 100_000 });
    expect(keys(mergeHistory([open], [a, bybit], from, now, now))).toEqual(['o|2|0']);
  });

  it("a bot trade closed before the period still hides a platform's closed just inside it, and is not listed", () => {
    const start = T;
    const b = bot({ key: 'b|1', openedAt: start - 3_600_000, closedAt: start - 1_000 });
    const a = row({ key: 'a|1', openedAt: start - 3_600_000, closedAt: start + 1_000 });
    expect(keys(mergeHistory([b], [a], start, now, now))).toEqual([]);
  });

  it('only the trades closed in the period, and the open ones; open first, then the latest exit on top', () => {
    const rows = [
      row({ key: 'a|old', symbol: 'A/USDT', closedAt: from - 1 }),
      row({ key: 'a|1', symbol: 'B/USDT', closedAt: T - 2 * MIN }),
      row({ key: 'a|2', symbol: 'C/USDT', closedAt: T - MIN }),
      row({ key: 'a|future', symbol: 'D/USDT', closedAt: now + 1 }),
    ];
    const bots = [bot({ key: 'o|1', symbol: 'E/USDT', open: true, closedAt: null, openedAt: T - 9 * MIN }), bot({ key: 'o|2', symbol: 'F/USDT', open: true, closedAt: null, openedAt: T - 8 * MIN })];
    expect(keys(mergeHistory(bots, rows, from, now, now))).toEqual(['o|2', 'o|1', 'a|2', 'a|1']);
  });

  it('a platform row without a side is never taken for a bot’s; shares match without their currency', () => {
    const b = bot({ key: 'b|1', symbol: 'NVDA', market: 'cfd' });
    const noSide = row({ key: 'a|1', symbol: 'NVDA', market: 'cfd', side: null });
    const same = row({ key: 'a|2', symbol: 'NVDA/USD', market: 'cfd' });
    expect(keys(mergeHistory([b], [noSide, same], from, now, now, true)).sort()).toEqual(['a|1', 'b|1']);
  });

  it('at most HISTORY_MAX_ROWS rows, the newest', () => {
    const many = Array.from({ length: HISTORY_MAX_ROWS + 5 }, (_, i) => row({ key: `a|${String(i).padStart(5, '0')}`, symbol: `S${i}/USDT`, closedAt: T - i * 1_000 }));
    const m = mergeHistory([], many, from, now, now);
    expect(m.rows).toHaveLength(HISTORY_MAX_ROWS);
    expect(m.truncated).toBe(true);
    expect(m.rows[0]?.key).toBe('a|00000');
    expect(mergeHistory([], many.slice(0, 3), from, now, now).truncated).toBe(false);
  });
});

// FIX-TRADESOLD: the orders sent from Sentiq (as `trade_log` keeps them) fill what the platform's history lacks.
const at = (s: string) => Date.parse(`${s}Z`);
const order = (when: string, symbol: string, side: 'buy' | 'sell', ticket: Record<string, unknown>, followUps: unknown[] = []): JournalRow => ({
  action: 'order',
  created_at: at(when),
  symbol,
  market: (ticket.market as string) ?? 'futures',
  side,
  leverage: (ticket.leverage as number) ?? null,
  detail: JSON.stringify({ ticket: { market: 'futures', symbol, side, kind: 'market', ...ticket }, result: { status: 'sent', orderId: 'x', message: null, followUps } }),
});
const step = (change: number, kind: string, side: string, after: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ change, how: 'place-then-cancel', orderId: 'o', side, kind, before: {}, after: { price: null, triggerPrice: null, amount: 9, takeProfit: null, stopLoss: null, ...after }, removes: false, ...extra });
const modify = (when: string, symbol: string, steps: Record<string, unknown>[], ok: boolean[] = steps.map(() => true), market: string | null = null): JournalRow => ({
  action: 'modify',
  created_at: at(when),
  symbol,
  market,
  side: null,
  leverage: null,
  detail: JSON.stringify({ steps, result: { status: 'done', steps: steps.flatMap((_, i) => [{ change: i, what: 'ordin nou plasat', ok: ok[i], orderId: 'n', message: null }]) } }),
});
const entries = (rows: JournalRow[]) => rows.map(journalEntry).filter((e): e is JournalEntry => e !== null);

describe('FIX-TRADESOLD: what Sentiq sent', () => {
  it('an order: its market, side, leverage and SL / TP; a close opens nothing; a separate SL that failed does not count', () => {
    expect(journalEntry(order('2026-10-20T19:15:00', 'SOL/USDT:USDT', 'buy', { amount: 0.9, leverage: 3, marginMode: 'isolated', takeProfit: 109, stopLoss: 104.5 }))).toEqual({
      action: 'order',
      at: at('2026-10-20T19:15:00'),
      symbol: 'SOL/USDT:USDT',
      market: 'futures',
      side: 'buy',
      opens: true,
      leverage: 3,
      stopLoss: 104.5,
      takeProfit: 109,
      changes: [],
    });
    expect(journalEntry(order('2026-10-22T09:57:00', 'SOL/USDT:USDT', 'sell', { amount: 4.2, reduceOnly: true }))).toMatchObject({ opens: false, leverage: null });
    expect(journalEntry(order('2026-11-05T15:36:00', 'MSTR', 'sell', { market: 'stock', leverage: 1, close: { positionIds: ['1'] } }))?.opens).toBe(false);
    const binance = journalEntry(order('2026-10-20T19:15:00', 'BTC/USDT:USDT', 'buy', { leverage: 5, stopLoss: 90, takeProfit: 120 }, [{ what: 'stop-loss', ok: false }, { what: 'take-profit', ok: true }]));
    expect(binance?.stopLoss).toBeUndefined();
    expect(binance?.takeProfit).toBe(120);
    expect(journalEntry({ ...order('2026-10-20T19:15:00', 'X', 'buy', {}), detail: 'not json' })).toBeNull();
    expect(journalEntry({ ...order('2026-10-20T19:15:00', 'X', 'buy', {}), action: 'enable' })).toBeNull();
  });

  it('a change: the new trigger, a TP placed anew, one taken off, eToro by its position; a change that failed does not count', () => {
    const e = journalEntry(
      modify(
        '2026-10-21T07:52:00',
        'SOL/USDT:USDT',
        [step(0, 'sl', 'sell', { triggerPrice: 105.07 }), step(1, 'tp', 'sell', { takeProfit: 98 }, { how: 'place' }), step(2, 'sl', 'sell', {}, { removes: true }), step(3, 'order', 'buy', { price: 100 }), step(4, 'tp', 'sell', { triggerPrice: 111 })],
        [true, true, true, true, false],
      ),
    );
    expect(e?.changes).toEqual([
      { kind: 'sl', side: 'sell', value: 105.07, position: null },
      { kind: 'tp', side: 'sell', value: 98, position: null },
      { kind: 'sl', side: 'sell', value: null, position: null },
    ]);
    const etoro = journalEntry(modify('2026-11-05T13:41:00', 'SPCX', [step(0, 'sl', 'sell', { stopLoss: 110 }, { how: 'position', orderId: 'sl-3636124982' })]));
    expect(etoro?.changes).toEqual([{ kind: 'sl', side: 'sell', value: 110, position: '3636124982' }]);
    expect(journalEntry(modify('2026-10-21T07:52:00', 'SOL/USDT:USDT', [step(0, 'sl', 'sell', { triggerPrice: 1 })], [false]))).toBeNull();
  });

  // The user's SOL long of 20 Oct: TP 109 / SL 104.5, moved on 21 Oct, added to that evening with its own SL / TP, moved again.
  const sol = entries([
    order('2026-10-20T19:15:00', 'SOL/USDT:USDT', 'buy', { amount: 0.9, leverage: 3, takeProfit: 109, stopLoss: 104.5 }),
    modify('2026-10-21T07:52:00', 'SOL/USDT:USDT', [step(0, 'sl', 'sell', { triggerPrice: 105.07 })]),
    modify('2026-10-21T07:52:30', 'SOL/USDT:USDT', [step(0, 'tp', 'sell', { triggerPrice: 108.39 })]),
    modify('2026-10-21T10:10:00', 'SOL/USDT:USDT', [step(0, 'sl', 'sell', { triggerPrice: 106 })]),
    order('2026-10-21T17:20:00', 'SOL/USDT:USDT', 'buy', { amount: 2.7, leverage: 3, takeProfit: 109.6, stopLoss: 106.5 }),
    modify('2026-10-21T17:20:30', 'SOL/USDT:USDT', [step(0, 'tp', 'sell', { triggerPrice: 109.66 }), step(1, 'sl', 'sell', { triggerPrice: 106.87 })]),
    // After the close: the next trade's.
    order('2026-10-22T09:54:00', 'SOL/USDT:USDT', 'buy', { amount: 4.2, leverage: 3 }),
    modify('2026-10-22T09:55:00', 'SOL/USDT:USDT', [step(0, 'sl', 'sell', { triggerPrice: 1 })]),
  ]);
  const kucoin = (r: Partial<TradeHistoryRow> = {}) =>
    row({ key: 'a|SOL/USDT:USDT|1', symbol: 'SOL/USDT', side: 'long', qty: 3.6, entry: 106.2, exit: 106.87, leverage: null, pnl: 2.1, pnlPct: null, openedAt: at('2026-10-20T19:15:04'), closedAt: at('2026-10-22T01:00:00'), ...r });

  it("the user's SOL long: 3×, and the SL / TP in force at its exit (the last change wins)", () => {
    const [r] = withJournal([kucoin()], sol, 'kucoin');
    expect(r).toMatchObject({ leverage: 3, sl: 106.87, tp: 109.66, fromJournal: ['leverage', 'sl', 'tp'] });
    expect(r?.pnlPct).toBeCloseTo((2.1 / ((3.6 * 106.2) / 3)) * 100, 9);
  });

  it("what the platform gives stays; a short, another symbol, an order too far from the opening, a row without its opening time: nothing", () => {
    expect(withJournal([kucoin({ leverage: 5, sl: 100 })], sol, 'kucoin')[0]).toMatchObject({ leverage: 5, sl: 100, tp: 109.66, fromJournal: ['tp'] });
    expect(withJournal([kucoin({ side: 'short' })], sol, 'kucoin')[0]?.fromJournal).toBeUndefined();
    expect(withJournal([kucoin({ symbol: 'ETH/USDT' })], sol, 'kucoin')[0]?.fromJournal).toBeUndefined();
    expect(withJournal([kucoin({ openedAt: at('2026-10-20T19:26:00') })], sol, 'kucoin')[0]?.fromJournal).toBeUndefined();
    expect(withJournal([kucoin({ openedAt: at('2026-10-20T19:24:30') })], sol, 'kucoin')[0]).toMatchObject({ leverage: 3 });
    expect(withJournal([kucoin({ openedAt: at('2026-10-20T19:12:30') })], sol, 'kucoin')[0]?.fromJournal).toBeUndefined();
    expect(withJournal([kucoin({ openedAt: null })], sol, 'kucoin')[0]?.fromJournal).toBeUndefined();
    // A bot's row is never touched (it has its own levels).
    expect(withJournal([kucoin({ source: 'bot', bot: { id: 2, name: 'Crypto' } })], sol, 'kucoin')[0]?.fromJournal).toBeUndefined();
    // A spot sale is not a futures position's opening.
    expect(withJournal([kucoin()], entries([order('2026-10-20T19:15:00', 'SOL/USDT', 'buy', { market: 'spot', leverage: 1, stopLoss: 1 })]), 'kucoin')[0]?.fromJournal).toBeUndefined();
    // A spot holding's SL moved on the same pair, while the futures position was open: not the position's.
    const spot = entries([
      order('2026-10-20T19:15:00', 'SOL/USDT:USDT', 'buy', { leverage: 3, stopLoss: 104.5 }),
      modify('2026-10-20T20:00:00', 'SOL/USDT', [step(0, 'sl', 'sell', { triggerPrice: 90 })], [true], 'spot'),
    ]);
    expect(withJournal([kucoin()], spot, 'kucoin')[0]).toMatchObject({ sl: 104.5 });
    // A change journaled without its market: a contract's symbol says futures.
    expect(journalEntry(modify('2026-10-21T07:52:00', 'SOL/USDT:USDT', [step(0, 'sl', 'sell', { triggerPrice: 1 })]))?.market).toBe('futures');
  });

  it('a level taken off stays empty; the closest order of several is the one that opened it', () => {
    const off = entries([order('2026-10-20T19:15:00', 'SOL/USDT:USDT', 'buy', { leverage: 3, stopLoss: 104.5 }), modify('2026-10-20T20:00:00', 'SOL/USDT:USDT', [step(0, 'sl', 'sell', {}, { removes: true })])]);
    expect(withJournal([kucoin()], off, 'kucoin')[0]).toMatchObject({ leverage: 3, sl: null, tp: null, fromJournal: ['leverage'] });
    const two = entries([order('2026-10-20T19:08:00', 'SOL/USDT:USDT', 'buy', { leverage: 2, stopLoss: 1 }), order('2026-10-20T19:14:50', 'SOL/USDT:USDT', 'buy', { leverage: 3, stopLoss: 104.5 })]);
    expect(withJournal([kucoin()], two, 'kucoin')[0]).toMatchObject({ leverage: 3, sl: 104.5 });
  });

  it('eToro: each position apart; its changes by its id; a CFD only from an order with leverage or short', () => {
    const sent = entries([
      order('2026-11-05T13:41:00', 'SPCX', 'buy', { market: 'stock', leverage: 5, stopLoss: 110 }),
      order('2026-11-05T13:41:20', 'SPCX', 'buy', { market: 'stock', leverage: 5, stopLoss: 115 }),
      modify('2026-11-05T14:00:00', 'SPCX', [step(0, 'sl', 'sell', { stopLoss: 100 }, { how: 'position', orderId: 'sl-222' })]),
    ]);
    const pos = (id: string, opened: string) => row({ key: `a|${id}`, symbol: 'SPCX', market: 'cfd', side: 'long', leverage: null, sl: null, tp: null, openedAt: at(opened), closedAt: at('2026-11-06T13:00:00') });
    const [a, b] = withJournal([pos('111', '2026-11-05T13:41:02'), pos('222', '2026-11-05T13:41:21')], sent, 'etoro', true);
    expect(a).toMatchObject({ leverage: 5, sl: 110 });
    expect(b).toMatchObject({ leverage: 5, sl: 100 });
    // A share bought without leverage is not this CFD's opening.
    const plain = entries([order('2026-11-05T13:41:00', 'SPCX', 'buy', { market: 'stock', leverage: 1, stopLoss: 1 })]);
    expect(withJournal([pos('111', '2026-11-05T13:41:02')], plain, 'etoro', true)[0]?.fromJournal).toBeUndefined();
  });

  it('elsewhere a short share stays a share (Alpaca); the leverage found sets the percent of the margin', () => {
    const short = entries([order('2026-11-05T13:41:00', 'TSLA', 'sell', { market: 'stock', leverage: 1, stopLoss: 270 })]);
    const r = row({ key: 'a|o1', symbol: 'TSLA', market: 'stock', side: 'short', leverage: null, sl: null, openedAt: at('2026-11-05T13:41:01'), closedAt: at('2026-11-06T13:00:00') });
    expect(withJournal([r], short, 'alpaca', true)[0]).toMatchObject({ sl: 270, leverage: 1 });
    const [k] = withJournal([kucoin({ pnlPct: null })], sol, 'kucoin');
    expect(k?.pnlPct).toBeCloseTo((2.1 / ((3.6 * 106.2) / 3)) * 100, 9);
  });
});

// FIX-TRADESIZE: KuCoin classic's closed positions as ccxt gives them (from the user's account, 10 Nov 2026): no size, no
// leverage, but the value closed and the margin.
const kucoinClassic = (info: Record<string, unknown>, p: Partial<Position> = {}) =>
  pos({ symbol: 'LTC/USDT:USDT', side: 'short', contractSize: 0.1, leverage: undefined, contracts: undefined, timestamp: undefined, ...p, info: { leverage: null, marginMode: 'ISOLATED', ...info } });
const ltc = kucoinClassic(
  { closeId: '500000000402120588', type: 'CLOSE_SHORT', pnl: '8.5332734', realisedGrossCost: '-9.605', openTime: 1794308446120, closeTime: 1794325070397, openPrice: '51.0175', closePrice: '50.471761364', roe: '0.028459289', unHoldMargin: '299.3026666366', closeCost: '888.303' },
  { id: '500000000402120588', entryPrice: 51.0175, lastPrice: 50.471761364, realizedPnl: 8.5332734, lastUpdateTimestamp: 1794325070397 },
);

describe('FIX-HISTAMOUNT: what a trade took from the account, without leverage', () => {
  it('KuCoin isolated: the margin it gives (the bot\'s LTC: 299,30); cross: none, unless the leverage is known', () => {
    expect(positionRow('kucoin', ltc)?.margin).toBeCloseTo(299.3026666366, 9);
    const cross = positionRow('kucoin', kucoinClassic({ marginMode: 'CROSS', unHoldMargin: '299.3', closeCost: '888.303', roe: null }, { id: 'c', entryPrice: 51.0175, lastPrice: 50.471761364, realizedPnl: 8.5, lastUpdateTimestamp: T }));
    expect(cross?.margin).toBeNull();
    // ccxt's initial margin, else the value over the leverage (linear); an inverse contract only from the platform.
    expect(positionRow('okx', pos({ id: 'o', symbol: 'ETH/USDT:USDT', side: 'long', contracts: 1, contractSize: 0.1, leverage: 2, entryPrice: 100, lastPrice: 110, realizedPnl: 1, lastUpdateTimestamp: T, initialMargin: 4.9 }))?.margin).toBe(4.9);
    expect(positionRow('okx', pos({ id: 'o2', symbol: 'ETH/USDT:USDT', side: 'long', contracts: 1, contractSize: 0.1, leverage: 2, entryPrice: 100, lastPrice: 110, realizedPnl: 1, lastUpdateTimestamp: T }))?.margin).toBeCloseTo(5, 9);
    expect(positionRow('bybit', pos({ id: 'b', symbol: 'BTC/USD:BTC', side: 'long', contracts: 100, contractSize: 1, leverage: 10, entryPrice: 100_000, lastPrice: 101_000, realizedPnl: 0.00001, lastUpdateTimestamp: T }))).toMatchObject({ currency: 'BTC', margin: null });
    expect(positionRow('bybit', pos({ id: 'b2', symbol: 'BTC/USD:BTC', side: 'long', contracts: 100, contractSize: 1, leverage: 10, entryPrice: 100_000, lastPrice: 101_000, realizedPnl: 0.00001, lastUpdateTimestamp: T, initialMargin: 0.0001 }))?.margin).toBe(0.0001);
  });

  it('the value over the leverage, never with an unknown leverage taken as 1; a broker\'s invested amount; the leverage from the journal', () => {
    expect(marginOf(17.6, 51.0175, 3)).toBeCloseTo(299.3026666667, 9);
    expect(marginOf(-2, 100, 4)).toBe(50);
    expect(marginOf(2, 100, null)).toBeNull();
    expect(marginOf(null, 100, 2)).toBeNull();
    expect(marginOf(2, 100, 0)).toBeNull();
    expect(brokerRow({ id: 'e1', symbol: 'AAPL', side: 'long', qty: 2, entry: 200, exit: 210, pnl: 20, closedAt: T, invested: 150, leverage: 2 } as never, 'USD').margin).toBe(150);
    expect(brokerRow({ id: 'e2', symbol: 'AAPL', side: 'long', qty: 2, entry: 200, exit: 210, pnl: 20, closedAt: T, leverage: 2 } as never, 'USD').margin).toBe(200);
    // A platform row without leverage gets its margin with the journal's.
    const bare = row({ key: 'a|x', source: 'account', symbol: 'LTC/USDT', qty: 17.6, entry: 51.0175, leverage: null, margin: null, openedAt: T - 60 * MIN });
    const entry: JournalEntry = { action: 'order', at: T - 61 * MIN, symbol: 'LTC/USDT:USDT', market: 'futures', side: 'sell', opens: true, leverage: 3, changes: [] };
    expect(withJournal([bare], [entry], 'kucoin')[0]?.margin).toBeCloseTo(299.3026666667, 9);
  });
});

describe('FIX-TRADESIZE: the size and the leverage KuCoin does not give', () => {
  it("the bot's LTC short: 17.6 from the value closed, 3× from the margin, KuCoin's percent of the margin", () => {
    const r = positionRow('kucoin', ltc);
    expect(r).toMatchObject({ qty: 17.6, leverage: 3, entry: 51.0175, exit: 50.471761364, openedAt: 1794308446120 });
    expect(r?.pnlPct).toBeCloseTo(2.8459289, 9);
  });

  it('the others of the account: SOL (7.2, two orders), INJ (84), RENDER opened in the KuCoin app (48.7): all 3×', () => {
    const sol = positionRow('kucoin', kucoinClassic({ openPrice: '89.944041667', closePrice: '88.053111111', roe: '-0.0675527474', unHoldMargin: '215.8656999783', closeCost: '-633.9824', realisedGrossCost: '13.6147' }, { id: 's', symbol: 'SOL/USDT:USDT', side: 'long', entryPrice: 89.944041667, lastPrice: 88.053111111, realizedPnl: -14.6, lastUpdateTimestamp: T }));
    expect(sol).toMatchObject({ qty: 7.2, leverage: 3 });
    const inj = positionRow('kucoin', kucoinClassic({ unHoldMargin: '230.8966666432', closeCost: '-676.916', roe: '-0.0726381356' }, { id: 'i', symbol: 'INJ/USDT:USDT', side: 'long', contractSize: 1, entryPrice: 8.2463095238, lastPrice: 8.0585238095, realizedPnl: -16.8, lastUpdateTimestamp: T }));
    expect(inj).toMatchObject({ qty: 84, leverage: 3 });
    const render = positionRow('kucoin', kucoinClassic({ unHoldMargin: '33.3432666633', closeCost: '-95.3768', roe: '-0.1433130651' }, { id: 'r', symbol: 'RENDER/USDT:USDT', side: 'long', entryPrice: 2.054, lastPrice: 1.958455852, realizedPnl: -4.78, lastUpdateTimestamp: T }));
    expect(render).toMatchObject({ qty: 48.7, leverage: 3 });
  });

  it('without the value closed: the gross result over the price move; equal prices: unknown; cross: no leverage worked out', () => {
    const gross = positionRow('kucoin', kucoinClassic({ realisedGrossCost: '-9.605', unHoldMargin: '299.3026666366' }, { id: 'g', entryPrice: 51.0175, lastPrice: 50.471761364, realizedPnl: 8.5, lastUpdateTimestamp: T }));
    expect(gross).toMatchObject({ qty: 17.6, leverage: 3 });
    const flat = positionRow('kucoin', kucoinClassic({ realisedGrossCost: '0' }, { id: 'f', entryPrice: 93.084, lastPrice: 93.084, realizedPnl: -0.3, lastUpdateTimestamp: T }));
    expect(flat).toMatchObject({ qty: null, leverage: null });
    const cross = positionRow('kucoin', kucoinClassic({ marginMode: 'CROSS', unHoldMargin: '299.3', closeCost: '888.303', roe: null }, { id: 'c', entryPrice: 51.0175, lastPrice: 50.471761364, realizedPnl: 8.5, lastUpdateTimestamp: T }));
    expect(cross).toMatchObject({ qty: 17.6, leverage: null, pnlPct: null });
    // Another exchange's `roe` is not read as KuCoin's.
    expect(positionRow('okx', pos({ id: 'o', symbol: 'ETH/USDT:USDT', side: 'long', contracts: 1, contractSize: 0.1, leverage: 2, entryPrice: 100, lastPrice: 110, realizedPnl: 1, lastUpdateTimestamp: T, info: { roe: '5' } }))?.pnlPct).toBeCloseTo(20, 9);
    // A leverage the platform gives stays (1×: „Futures 1×”).
    expect(positionRow('kucoin', kucoinClassic({ unHoldMargin: '299.3', closeCost: '888.303' }, { id: 'l', leverage: 1, entryPrice: 51.0175, lastPrice: 50.471761364, realizedPnl: 8.5, lastUpdateTimestamp: T }))?.leverage).toBe(1);
  });
});
