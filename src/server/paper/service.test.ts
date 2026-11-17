// FD-PAPER: Paper Trading profiles and their engine, on the test database, with prices made by hand.
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.ts';
import { testDb } from '../test/db.ts';
import { silentLogger } from '../log.ts';
import type { Candle } from '../../shared/indicator/slingshot.ts';
import type { OrderTicket } from '../../shared/trading.ts';
import { PaperService } from './service.ts';
import { MIGRATIONS } from '../db/schema.ts';
import type { QuoteDeps } from '../market/quote.ts';

let db: Db;
let paper: PaperService;
let clock: number;
/** The price of each pair / share now. */
let px: Record<string, number>;
/** Extra 1-minute candles of a pair (a wick), beside the one of the price now. */
let wicks: Record<string, Candle[]>;
let open: boolean;

const MIN = 60_000;
const quotes = (): QuoteDeps =>
  ({
    source: { forSymbol: async () => 'kucoin' },
    market: {
      candles: async (_e: string, sym: string) => {
        const p = px[sym];
        if (p === undefined) throw new Error('fără pereche');
        const now: Candle = { t: Math.floor(clock / MIN) * MIN, o: p, h: p, l: p, c: p, v: 1 };
        return { candles: [...(wicks[sym] ?? []), now].sort((a, b) => a.t - b.t), fetchedAt: clock, lastClosedIndex: 0 };
      },
      lastPrice: async (_e: string, sym: string) => px[sym] ?? null,
    },
    stocks: {
      confirmedStatus: async () => ({ state: open ? 'open' : 'closed', label: '', opensAt: null, closesAt: null, fetchedAt: clock }),
      quote: async (sym: string) => {
        if (px[sym] === undefined) throw new Error('fără acțiune');
        return { symbol: sym, name: null, last: px[sym], change: null, changePct: null, status: '', fetchedAt: clock };
      },
    },
  }) as unknown as QuoteDeps;

beforeEach(async () => {
  db = await testDb();
  clock = Date.parse('2026-11-15T12:00:30Z');
  px = { 'BTC/USDT': 100, 'ETH/USDT': 2000, AAPL: 200 };
  wicks = {};
  open = true;
  paper = new PaperService({ db, quotes: quotes(), log: silentLogger, now: () => clock });
});

const profile = (over: Record<string, unknown> = {}) => paper.create(1, { label: 'Paper Crypto', kind: 'crypto', budget: 10_000, commissionType: 'percent', commissionValue: 0.1, ...over }, 20);
const ticket = (accountId: number, over: Partial<OrderTicket>): OrderTicket => ({ accountId, idemKey: randomUUID(), market: 'futures', symbol: 'BTC/USDT:USDT', side: 'buy', kind: 'market', amount: 1, amountIn: 'base', ...over }) as OrderTicket;
const send = async (accountId: number, over: Partial<OrderTicket>) => {
  const p = await paper.normalize(accountId, ticket(accountId, over));
  if (p.errors.length) throw new Error(p.errors.join(' '));
  return paper.place(accountId, p);
};
const cash = async (id: number) => (await paper.account(id))!.cash;
const look = async (ms = 10_000) => {
  clock += ms;
  return paper.match(clock);
};

describe('profiles (FD-PAPER §2)', () => {
  it('made with their market, budget and commission; trading on from the start; checked; at most the accounts allowed', async () => {
    const id = await profile();
    const a = await paper.account(id);
    expect(a).toMatchObject({ user_id: 1, label: 'Paper Crypto', kind: 'crypto', budget: 10_000, cash: 10_000, commission_type: 'percent', commission_value: 0.1 });
    expect(await db.get('SELECT exchange, env, kind, trading_markets FROM exchange_accounts WHERE id = ?', [id])).toEqual({ exchange: 'paper', env: 'paper', kind: 'crypto', trading_markets: 'spot,futures' });
    await expect(profile({ budget: 50 })).rejects.toThrow('Bugetul: cel puțin 100 USD');
    await expect(profile({ commissionValue: 11 })).rejects.toThrow('Comisionul: cel mult 10%');
    await expect(profile({ label: ' ' })).rejects.toThrow('Numele lipsește');
    await expect(paper.create(1, { label: 'X', kind: 'crypto', budget: 1000, commissionType: 'percent', commissionValue: 0 }, 1)).rejects.toThrow('cel mult 1 conturi');
    await paper.settings(id, { label: 'Nou', commissionType: 'fixed', commissionValue: 1.5 });
    expect(await paper.account(id)).toMatchObject({ label: 'Nou', commission_type: 'fixed', commission_value: 1.5, cash: 10_000 });
  });

  it('a reset ends the bots on it, empties it and gives it the new budget', async () => {
    const id = await profile();
    await send(id, { amount: 1, leverage: 10 });
    await db.run("INSERT INTO bots(user_id, name, strategy, execution, account_id, market, area, symbols, tf, config, status, state, starts_at, created_at, updated_at) VALUES (1, N'B', N'premium', N'real', ?, N'futures', N'crypto', N'[]', N'1h', N'{}', N'running', N'{}', 1, 1, 1)", [id]);
    expect(await paper.reset(id, { budget: 500 })).toBe(1);
    expect(await paper.account(id)).toMatchObject({ budget: 500, cash: 500 });
    expect(await db.get('SELECT count(*) AS n FROM paper_positions')).toEqual({ n: 0 });
    expect(await db.get('SELECT status, status_reason FROM bots')).toEqual({ status: 'ended', status_reason: 'Profilul Paper a fost resetat.' });
  });
});

describe('crypto spot, with leverage, long and short (FD-PAPER §4, FIX-PAPERLEV)', () => {
  it('migration 14: coins bought before it become a 1× position, their cost back in the money and held as margin', async () => {
    const id = await profile();
    // As FD-PAPER kept them: no margin, the cost spent.
    await db.run("INSERT INTO paper_positions(account_id, market, symbol, side, qty, entry, leverage, margin_mode, margin, sl, tp, fees, opened_at, updated_at) VALUES (?, N'spot', N'BTC/USDT', N'long', 2, 100, 1, N'isolated', 0, NULL, NULL, 0.2, 1, 1)", [id]);
    await db.run('UPDATE paper_accounts SET cash = cash - 200.2 WHERE account_id = ?', [id]);
    const free = (await paper.portfolio(id)).totals.futuresAvailable;
    for (const batch of MIGRATIONS[13] as string[]) await db.run(batch);
    expect(await db.get('SELECT margin, leverage FROM paper_positions WHERE account_id = ?', [id])).toEqual({ margin: 200, leverage: 1 });
    expect(await cash(id)).toBeCloseTo(10_000 - 0.2, 9);
    // What is free stays the same; the account's value counts the coins again.
    const pf = await paper.portfolio(id);
    expect(pf.totals.futuresAvailable).toBeCloseTo(free as number, 9);
    expect(pf.totals.spotValue).toBeCloseTo(10_000 - 0.2, 9);
  });

  it('a buy holds its margin and pays the commission; a sale books its result; a typed amount stays whole', async () => {
    const id = await profile();
    const r = await send(id, { market: 'spot', symbol: 'BTC/USDT', amount: 500, amountIn: 'quote' });
    expect(r).toMatchObject({ status: 'filled', fill: { price: 100, qty: 5 } });
    expect(r.fill!.fee).toBeCloseTo(0.5, 9);
    // The money pays the commission; the cost is held as the position's margin (1×).
    expect(await cash(id)).toBeCloseTo(10_000 - 0.5, 9);
    let pf = await paper.portfolio(id);
    expect(pf.positions).toMatchObject([{ symbol: 'BTC/USDT', side: 'long', size: 5, entryPrice: 100, leverage: 1, liquidationPrice: null }]);
    expect(pf.balances.map((b) => b.asset)).toEqual(['USDT']);
    expect(pf.totals.futuresAvailable).toBeCloseTo(10_000 - 0.5 - 500, 9);
    px['BTC/USDT'] = 120;
    await send(id, { market: 'spot', symbol: 'BTC/USDT', side: 'sell', amount: 5, reduceOnly: true });
    expect(await cash(id)).toBeCloseTo(10_000 - 0.5 + 100 - 0.6, 9);
    const h = await paper.history(id, '30d', 'UTC');
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ symbol: 'BTC/USDT', market: 'spot', side: 'long', qty: 5, entry: 100, exit: 120, leverage: 1, reason: 'închisă' });
    // FIX-HISTAMOUNT: its amount, without leverage (1×: its cost).
    expect(h.rows[0]!.margin).toBeCloseTo(500, 9);
    expect(h.rows[0]!.pnl).toBeCloseTo(100 - 0.5 - 0.6, 9);
    // A typed amount stays what it is (0.29 / 1e-8 is 28999999.999999996 in floating point): sold whole, nothing left.
    await send(id, { market: 'spot', symbol: 'BTC/USDT', amount: 0.29 });
    expect((await paper.portfolio(id)).positions).toMatchObject([{ size: 0.29 }]);
    await send(id, { market: 'spot', symbol: 'BTC/USDT', side: 'sell', amount: 0.29 });
    pf = await paper.portfolio(id);
    expect(pf.positions).toEqual([]);
  });

  it('with leverage: the margin a fifth, a liquidation; a short with its TP / SL; turned', async () => {
    const id = await profile();
    const p = await paper.normalize(id, ticket(id, { market: 'spot', symbol: 'BTC/USDT', amount: 10, leverage: 5, stopLoss: 90, takeProfit: 120 }));
    expect(p.errors).toEqual([]);
    expect(p.margin).toBeCloseTo(200, 9);
    await paper.place(id, p);
    let pos = (await paper.portfolio(id)).positions[0]!;
    expect(pos).toMatchObject({ symbol: 'BTC/USDT', side: 'long', leverage: 5, marginMode: 'isolated' });
    // FIX-POSAMOUNT: the money it took, without leverage (10 × 100 / 5).
    expect(pos.margin).toBeCloseTo(200, 9);
    expect(pos.liquidationPrice).toBeCloseTo(100 * 1.005 - 20, 9);
    expect((await paper.portfolio(id)).orders.map((o) => o.id).sort()).toEqual(['sl-1', 'tp-1']);
    // A sale without a position opens a short (said in the check), with its own stop loss.
    const short = await paper.normalize(id, ticket(id, { market: 'spot', symbol: 'ETH/USDT', side: 'sell', amount: 1, leverage: 2, stopLoss: 2100 }));
    expect(short.errors).toEqual([]);
    expect(short.warnings).toContain('Deschide un short.');
    await paper.place(id, short);
    px['ETH/USDT'] = 2101;
    await look();
    const h = await paper.history(id, '30d', 'UTC');
    expect(h.rows[0]).toMatchObject({ symbol: 'ETH/USDT', market: 'spot', side: 'short', exit: 2100, leverage: 2, reason: 'stop loss' });
    // Turned with ⇅: the same size the other way.
    const plan = await paper.normalizeReverse(id, { accountId: id, idemKey: randomUUID(), symbol: 'BTC/USDT', side: 'long' });
    expect(plan.preview.errors).toEqual([]);
    await paper.reverse(id, plan);
    pos = (await paper.portfolio(id)).positions[0]!;
    expect(pos).toMatchObject({ symbol: 'BTC/USDT', side: 'short', size: 10 });
  });

  it('refuses a pair not in dollars, a leverage out of range, more than the money', async () => {
    const id = await profile({ budget: 100 });
    expect((await paper.normalize(id, ticket(id, { market: 'spot', symbol: 'ETH/BTC' }))).errors).toEqual(['Paper Trading tranzacționează doar perechi în USDT, USDC sau USD.']);
    expect((await paper.normalize(id, ticket(id, { market: 'spot', symbol: 'BTC/USDT', amount: 0.5, leverage: 126 }))).errors).toContain('Levierul: între 1 și 125.');
    expect((await paper.normalize(id, ticket(id, { market: 'spot', symbol: 'BTC/USDT', amount: 2 }))).errors).toEqual(['Disponibil 100 USDT; ordinul cere 200.2 USDT (cu comisionul).']);
    // At 3× the same order fits.
    expect((await paper.normalize(id, ticket(id, { market: 'spot', symbol: 'BTC/USDT', amount: 2, leverage: 3 }))).errors).toEqual([]);
    expect((await paper.normalize(id, ticket(id, { market: 'stock', symbol: 'AAPL' }))).errors).toEqual(['Profilul e de crypto: tranzacționează spot și futures.']);
  });
});

describe('crypto futures (FD-PAPER §4, §5)', () => {
  it('a limit order holds its margin back and fills at its price when a wick reaches it; its stop loss then closes it', async () => {
    const id = await profile();
    const r = await send(id, { kind: 'limit', price: 95, amount: 2, leverage: 10, stopLoss: 90, takeProfit: 120 });
    expect(r.status).toBe('open');
    const p1 = await paper.portfolio(id);
    expect(p1.orders[0]).toMatchObject({ id: r.orderId, type: 'limit', price: 95, amount: 2, stopLoss: 90, takeProfit: 120, symbol: 'BTC/USDT:USDT' });
    expect(p1.totals.futuresAvailable).toBeCloseTo(10_000 - 19 - 0.19, 9);
    // Not reached: waits.
    expect(await look()).toBe(0);
    // A wick to 94 in the next minute: filled at 95.
    wicks['BTC/USDT'] = [{ t: Math.floor((clock + MIN) / MIN) * MIN, o: 100, h: 100, l: 94, c: 99, v: 1 }];
    clock += MIN;
    expect(await look()).toBe(1);
    const p2 = await paper.portfolio(id);
    expect(p2.orders.filter((o) => o.id.startsWith('p'))).toEqual([]);
    expect(p2.positions[0]).toMatchObject({ symbol: 'BTC/USDT:USDT', side: 'long', size: 2, entryPrice: 95, leverage: 10, marginMode: 'isolated' });
    expect(p2.orders.map((o) => [o.id.split('-')[0], o.type, o.triggerPrice ?? o.price])).toEqual([
      ['sl', 'stop', 90],
      ['tp', 'limit', 120],
    ]);
    // The stop loss reached.
    wicks['BTC/USDT'] = [{ t: Math.floor((clock + MIN) / MIN) * MIN, o: 99, h: 99, l: 89, c: 92, v: 1 }];
    clock += MIN;
    px['BTC/USDT'] = 92;
    expect(await look()).toBe(1);
    const h = await paper.history(id, '30d', 'UTC');
    expect(h.rows[0]).toMatchObject({ reason: 'stop loss', entry: 95, exit: 90, side: 'long', market: 'futures', symbol: 'BTC/USDT', leverage: 10 });
    expect(h.rows[0]!.pnl).toBeCloseTo(-10 - 0.19 - 0.18, 9);
    expect((await paper.portfolio(id)).positions).toEqual([]);
  });

  it('a wick before the order was placed does not fill it', async () => {
    const id = await profile();
    wicks['BTC/USDT'] = [{ t: Math.floor(clock / MIN) * MIN - MIN, o: 100, h: 100, l: 90, c: 100, v: 1 }];
    await send(id, { kind: 'limit', price: 95, amount: 1, leverage: 5 });
    expect(await look()).toBe(0);
  });

  it('isolated: liquidated when the loss eats the margin (the margin lost); cross: all the cross positions together', async () => {
    const id = await profile({ budget: 1000, commissionValue: 0 });
    await send(id, { amount: 10, leverage: 10 });
    // Liquidation at 100 × 1.005 − 10 = 90.5.
    px['BTC/USDT'] = 90;
    await look();
    expect((await paper.history(id, '30d', 'UTC')).rows[0]).toMatchObject({ reason: 'lichidare', pnl: -100 });
    expect(await cash(id)).toBeCloseTo(900, 9);
    px['BTC/USDT'] = 100;
    await send(id, { amount: 10, leverage: 10, marginMode: 'cross' });
    // Liquidated when 900 + (p − 100) × 10 ≤ 0,005 × p × 10, under ≈ 10,05: not at 15.
    px['BTC/USDT'] = 15;
    await look();
    expect((await paper.portfolio(id)).positions).toHaveLength(1);
    px['BTC/USDT'] = 10;
    await look();
    const rows = (await paper.history(id, '30d', 'UTC')).rows;
    expect(rows[0]).toMatchObject({ reason: 'lichidare', exit: 10 });
    expect((await paper.portfolio(id)).positions).toEqual([]);
  });

  it('an opposite order turns the position; reduce-only only shrinks it and goes with it', async () => {
    const id = await profile();
    await send(id, { amount: 2, leverage: 5 });
    const preview = await paper.normalize(id, ticket(id, { side: 'sell', amount: 3, leverage: 5 }));
    expect(preview.warnings).toContain('Închide poziția long (2) și deschide un short de 1.');
    await paper.place(id, preview);
    expect((await paper.portfolio(id)).positions[0]).toMatchObject({ side: 'short', size: 1 });
    await send(id, { side: 'buy', kind: 'limit', price: 80, amount: 5, reduceOnly: true });
    // The position closed by hand: its reduce-only order goes too.
    await send(id, { side: 'buy', amount: 1 });
    expect((await paper.portfolio(id)).orders).toEqual([]);
    expect((await paper.normalize(id, ticket(id, { side: 'buy', amount: 1, reduceOnly: true }))).errors).toContain('Nicio poziție de micșorat pe simbol (reduce-only).');
  });

  it('the position\'s stop loss set, moved and taken off; an order amended; cancelled', async () => {
    const id = await profile();
    await send(id, { amount: 1, leverage: 5 });
    const plan = await paper.normalizeModify(id, { accountId: id, idemKey: randomUUID(), market: 'futures', symbol: 'BTC/USDT:USDT', position: { side: 'long' }, changes: [{ what: 'sl', orderId: null, level: 90 }] });
    expect(plan.preview.errors).toEqual([]);
    expect((await paper.modify(id, plan)).status).toBe('done');
    const slId = (await paper.portfolio(id)).orders.find((o) => o.id.startsWith('sl-'))!.id;
    const bad = await paper.normalizeModify(id, { accountId: id, idemKey: randomUUID(), market: 'futures', symbol: 'BTC/USDT:USDT', position: { side: 'long' }, changes: [{ what: 'sl', orderId: slId, level: 101 }] });
    expect(bad.preview.errors[0]).toMatch(/^Stop loss-ul unui long trebuie să fie sub prețul de acum/);
    await paper.cancel(id, { orderId: slId, symbol: 'BTC/USDT:USDT', market: 'futures', trigger: true });
    expect((await paper.portfolio(id)).orders).toEqual([]);
    const r = await send(id, { kind: 'limit', price: 90, amount: 1, leverage: 5 });
    const amend = await paper.normalizeModify(id, { accountId: id, idemKey: randomUUID(), market: 'futures', symbol: 'BTC/USDT:USDT', changes: [{ what: 'order', orderId: r.orderId!, trigger: false, price: 92 }] });
    expect((await paper.modify(id, amend)).status).toBe('done');
    expect((await paper.portfolio(id)).orders[0]).toMatchObject({ price: 92 });
    await paper.cancel(id, { orderId: r.orderId!, symbol: 'BTC/USDT:USDT', market: 'futures', trigger: false });
    await expect(paper.cancel(id, { orderId: r.orderId!, symbol: 'BTC/USDT:USDT', market: 'futures', trigger: false })).rejects.toThrow('Ordinul nu mai există');
  });

  it('turned with ⇅: the same size the other way, its stop loss / take profit gone', async () => {
    const id = await profile();
    await send(id, { amount: 1, leverage: 5, stopLoss: 90 });
    const plan = await paper.normalizeReverse(id, { accountId: id, idemKey: randomUUID(), symbol: 'BTC/USDT:USDT', side: 'long' });
    expect(plan.preview).toMatchObject({ from: { side: 'long', amount: 1 }, to: { side: 'short', amount: 1 }, cancels: 1, errors: [] });
    expect((await paper.reverse(id, plan)).status).toBe('done');
    const p = await paper.portfolio(id);
    expect(p.positions[0]).toMatchObject({ side: 'short', size: 1 });
    expect(p.orders).toEqual([]);
  });
});

describe('shares (FD-PAPER §4)', () => {
  it('long and short at 1×; a market order only with the market open; a fixed commission; the history in USD', async () => {
    const id = await profile({ label: 'Paper Acțiuni', kind: 'stocks', commissionType: 'fixed', commissionValue: 1 });
    open = false;
    expect((await paper.normalize(id, ticket(id, { market: 'stock', symbol: 'AAPL', amount: 2 }))).errors).toEqual(['Bursa e închisă acum: pune un ordin limită sau stop.']);
    expect((await paper.normalize(id, ticket(id, { market: 'stock', symbol: 'AAPL', kind: 'limit', price: 190, amount: 2 }))).errors).toEqual([]);
    open = true;
    const short = await paper.normalize(id, ticket(id, { market: 'stock', symbol: 'AAPL', side: 'sell', amount: 2, takeProfit: 180 }));
    expect(short.warnings).toContain('Deschide un short.');
    await paper.place(id, short);
    const p = await paper.portfolio(id);
    expect(p).toMatchObject({ kind: 'stocks', currency: 'USD', balances: [] });
    expect(p.positions[0]).toMatchObject({ symbol: 'AAPL/USD', side: 'short', size: 2, leverage: 1 });
    expect(p.positions[0]!.liquidationPrice).toBeCloseTo(399, 6);
    expect(p.orders[0]).toMatchObject({ id: expect.stringMatching(/^tp-/), symbol: 'AAPL/USD', type: 'limit', price: 180, side: 'buy' });
    px.AAPL = 179;
    await look();
    const h = await paper.history(id, '30d', 'UTC');
    expect(h.rows[0]).toMatchObject({ symbol: 'AAPL', market: 'stock', side: 'short', reason: 'take profit', exit: 180, currency: 'USD' });
    expect(h.rows[0]!.pnl).toBeCloseTo(40 - 2, 9);
    const s = await paper.stats(id, '30d', 'UTC');
    expect(s).toMatchObject({ supported: true, wins: 1, losses: 0, currency: 'USD' });
    expect(s.net).toBeCloseTo(38, 9);
  });

  it('with leverage (FIX-PAPERLEV): the margin a third, a liquidation for the long; cross too', async () => {
    const id = await profile({ label: 'Paper Acțiuni', kind: 'stocks', budget: 1000 });
    // 10 shares at 200 = 2000: more than the money at 1×, within it at 3×.
    expect((await paper.normalize(id, ticket(id, { market: 'stock', symbol: 'AAPL', amount: 10 }))).errors[0]).toMatch(/^Disponibil 1000 USD; ordinul cere 2002/);
    const p = await paper.normalize(id, ticket(id, { market: 'stock', symbol: 'AAPL', amount: 10, leverage: 3 }));
    expect(p.errors).toEqual([]);
    await paper.place(id, p);
    const pos = (await paper.portfolio(id)).positions[0]!;
    expect(pos).toMatchObject({ symbol: 'AAPL/USD', side: 'long', leverage: 3, marginMode: 'isolated' });
    expect(pos.liquidationPrice).toBeCloseTo(200 * 1.005 - 2000 / 3 / 10, 9);
    // Liquidated when the price reaches it: the margin lost.
    px.AAPL = 130;
    await look();
    const h = await paper.history(id, '30d', 'UTC');
    expect(h.rows[0]).toMatchObject({ symbol: 'AAPL', side: 'long', reason: 'lichidare', leverage: 3 });
    expect((await paper.portfolio(id)).positions).toEqual([]);
    // Cross is chosen on shares too.
    px.AAPL = 200;
    const c = await paper.normalize(id, ticket(id, { market: 'stock', symbol: 'AAPL', amount: 1, leverage: 2, marginMode: 'cross' }));
    expect(c.errors).toEqual([]);
    await paper.place(id, c);
    expect((await paper.portfolio(id)).positions[0]).toMatchObject({ leverage: 2, marginMode: 'cross' });
  });
});
