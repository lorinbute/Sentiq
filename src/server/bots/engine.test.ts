// FD-BOT, TD-BOT §7: the bots end to end, through the API and the engine's looks, on simulated prices and a simulated
// platform (never a real order): the simulation, the period, the pause, the stop, the loss limits, the real orders
// (the key saved before an order leaves, sent again after a network error), a problem, a deleted account, a position
// closed outside the bot, Slingshot Premium's checks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createContext, type AppContext } from '../context.ts';
import { testDb } from '../test/db.ts';
import { loadConfig } from '../config.ts';
import { buildApp } from '../http/app.ts';
import { silentLogger } from '../log.ts';
import { SecretBox } from '../secrets/crypto.ts';
import { hashPassword } from '../auth/passwords.ts';
import { newSecret } from '../auth/totp.ts';
import type { NliScorer } from '../sentiment/local.ts';
import type { ClientFactory, Portfolio } from '../exchange/accounts.ts';
import type { TradeHistory } from '../exchange/trade-history.ts';
import { MIGRATIONS } from '../db/schema.ts';
import type { TraderFactory } from '../exchange/trading/service.ts';
import { TradingError, type Trader } from '../exchange/trading/types.ts';
import type { MarketData } from '../market/market.ts';
import type { Candle, SlingshotResult, SlingshotSetup, SlingshotSignal } from '../../shared/indicator/slingshot.ts';
import type { OrderTicket } from '../../shared/trading.ts';
import { DEFAULT_WEIGHTS, type BotCheck, type BotDetail, type BotInput, type BotLevel, type BotView } from '../../shared/bot.ts';
import { BotEngine, commandLeft, type Bar } from './engine.ts';
import type { BotState } from './state.ts';
import { tfSeconds } from '../../shared/time.ts';

const BOX = new SecretBox(Buffer.alloc(32, 7));
const fakeNli: NliScorer = { status: () => ({ state: 'ready', progress: 100, error: null, model: 'fake' }), warmUp: () => {}, score: async () => 0, onReady: () => {} };
const MIN = 60_000;

let dir: string;
let ctx: AppContext;
let app: FastifyInstance;
let H: Record<string, string>;
let clock: number;
let px: Record<string, number>;
/** FIX-2ZPRICE: pairs without a candle in the last minutes (no trades), and the tickers' last trade. */
let thin: Set<string>;
/** Pairs whose last 1-minute candles are old (a chart loaded their history, then no trade). */
let stale: Set<string>;
let ticks: Record<string, number | null>;
let placed: OrderTicket[];
let placeError: Error | null;
/** What the simulated platform says is wrong with an order (it refuses it). */
let normalizeErrors: string[];
/** FIX-BOTMARGIN: the futures margin modes the account takes (undefined: not said). */
let marginModes: ('isolated' | 'cross')[] | null | undefined;
let positions: Portfolio['positions'];
/** FIX-BOTSHORTS: the futures account's free USDT. */
let futuresFree: number | null;
/** What Slingshot says on each closed bar (an hour each); null: no bar. */
let barSpec: { signals: Partial<SlingshotSignal>[]; alerts?: SlingshotResult['alerts']; setups?: Partial<SlingshotSetup>[]; range?: { high: number; low: number } } | null;
const HOUR = 60 * MIN;
let mood: { index: number; area: number; areaCount: number };
let aiAnswer: { decision: 'enter' | 'skip'; confidence: number; reason: string; risks: string[]; amount?: number } | null;
/** What the AI was asked (FD-BOTSLRR: no R:R in it). */
let aiAsked: { system: string; prompt: string }[] = [];
let keyN = 0;
let engine: BotEngine;

const candles = (p: number): Candle[] => [
  { t: clock - 2 * MIN, o: p, h: p, l: p, c: p, v: 1 },
  { t: clock - MIN, o: p, h: p, l: p, c: p, v: 1 },
];
const fakeMarket = {
  timeframes: () => ['1m', '5m', '1h', '1d'],
  lists: async () => true,
  candles: async (exchange: string, symbol: string, tf: string) => {
    const p = px[symbol];
    if (p === undefined) throw new Error(`fără ${symbol}`);
    if (thin.has(symbol)) return { exchange, symbol, tf, candles: [], pricePrecision: 2, lastClosedIndex: -1, fetchedAt: clock };
    if (stale.has(symbol)) return { exchange, symbol, tf, candles: candles(p).map((c) => ({ ...c, t: c.t - 10 * MIN })), pricePrecision: 2, lastClosedIndex: 1, fetchedAt: clock };
    return { exchange, symbol, tf, candles: candles(p), pricePrecision: 2, lastClosedIndex: 0, fetchedAt: clock };
  },
  lastPrice: async (_exchange: string, symbol: string) => ticks[symbol] ?? null,
} as unknown as MarketData;

/** FD-TRADES: the futures positions the simulated exchange closed (its history), or an error reading it. */
let closedHistory: Record<string, unknown>[] | Error;
const fakeClients: ClientFactory = () => ({
  spot: {
    privateGetUserApiKey: async () => ({ data: { permission: 'General,Spot,Futures' } }),
    fetchPositionsHistory: async (_s: unknown, since: number, _l: number, params: { until?: number }) => {
      if (closedHistory instanceof Error) throw closedHistory;
      return closedHistory.filter((p) => (p.lastUpdateTimestamp as number) >= since && (p.lastUpdateTimestamp as number) <= (params.until ?? Infinity));
    },
  } as never,
  futures: null,
});
/** FD-BOT §10: the shares held at the simulated brokers, and eToro's positions (each apart, with its id). */
let shares: Record<string, number>;
let etoroPositions: { id: string; units: number; isBuy: boolean; openedAt: number }[];
/** eToro shows a new position only at the next reading (the order still being processed). */
let etoroLate: boolean;
let etoroLateList: typeof etoroPositions;
let etoroN = 0;
const t212Trader = (): Trader => ({
  symbols: async () => [],
  instrument: async (market, symbol) => ({ market, symbol, ref: null, name: null, currency: 'USD', base: symbol, last: px[symbol] ?? null, amountStep: null, minAmount: null, minCost: null, priceStep: null, contractSize: null, maxLeverage: null, availableQuote: 10_000, availableBase: shares[symbol] ?? 0, position: null }),
  normalize: async (ticket) => {
    const errors: string[] = [];
    if (ticket.side === 'sell' && ticket.amount > (shares[ticket.symbol] ?? 0) + 1e-9) errors.push('Trading 212 nu vinde în lipsă.');
    return { ticket, displaySymbol: ticket.symbol, amount: ticket.amount, contracts: null, price: null, triggerPrice: null, last: px[ticket.symbol] ?? null, value: null, margin: null, available: 10_000, currency: 'USD', env: 'live', warnings: [], errors };
  },
  place: async (p) => {
    placed.push(p.ticket);
    shares[p.ticket.symbol] = (shares[p.ticket.symbol] ?? 0) + (p.ticket.side === 'buy' ? 1 : -1) * p.ticket.amount;
    return { status: 'filled', orderId: `t${placed.length}`, message: null, followUps: [] };
  },
  cancel: async () => ({ status: 'cancelled', orderId: null, message: null, followUps: [] }),
  normalizeModify: async () => {
    throw new Error('not used');
  },
  modify: async () => {
    throw new Error('not used');
  },
});
const etoroTrader = (): Trader => ({
  ...t212Trader(),
  instrument: async (market, symbol) => {
    // What was opened while "processing" shows once eToro is done with it.
    if (!etoroLate) etoroPositions.push(...etoroLateList.splice(0));
    return { market, symbol, ref: '1001', name: null, currency: 'USD', base: symbol, last: px[symbol] ?? null, amountStep: null, minAmount: null, minCost: null, priceStep: null, contractSize: null, maxLeverage: null, availableQuote: 10_000, availableBase: etoroPositions.filter((p) => p.isBuy).reduce((a, p) => a + p.units, 0), position: null, positions: etoroPositions.map((p) => ({ ...p, openRate: null, pnl: null, invested: null, leverage: 1 })) };
  },
  normalize: async (ticket) => {
    const errors: string[] = [];
    if (!ticket.close && ticket.side === 'sell' && ticket.stopLoss === undefined) errors.push('eToro cere stop loss la o poziție short.');
    for (const id of ticket.close?.positionIds ?? []) if (!etoroPositions.some((p) => p.id === id)) errors.push(`Poziția ${id} nu mai e deschisă.`);
    return { ticket, displaySymbol: ticket.symbol, amount: ticket.amount, contracts: null, price: null, triggerPrice: null, last: px[ticket.symbol] ?? null, value: null, margin: null, available: 10_000, currency: 'USD', env: 'live', warnings: [], errors };
  },
  place: async (p) => {
    const t = p.ticket;
    placed.push(t);
    if (t.close) {
      let left = t.close.units ?? Infinity;
      for (const id of t.close.positionIds) {
        const pos = etoroPositions.find((x) => x.id === id);
        if (!pos || left <= 0) continue;
        const take = Math.min(pos.units, left);
        pos.units -= take;
        left -= take;
      }
      etoroPositions = etoroPositions.filter((x) => x.units > 1e-9);
    } else (etoroLate ? etoroLateList : etoroPositions).push({ id: `e${++etoroN}`, units: t.amount, isBuy: t.side === 'buy', openedAt: clock });
    return { status: 'filled', orderId: `o${placed.length}`, message: null, followUps: [] };
  },
});
const fakeTrader: TraderFactory = (a) => (a.exchange === 'trading212' ? t212Trader() : a.exchange === 'etoro' ? etoroTrader() : cryptoTrader());
const cryptoTrader = () => {
  const t: Trader = {
    symbols: async () => [],
    instrument: async (market, symbol) => ({ market, symbol, ref: null, name: null, currency: 'USDT', base: 'BTC', last: px['BTC/USDT'] ?? 100, amountStep: 0.0001, minAmount: 0.0001, minCost: 1, priceStep: 0.01, contractSize: null, maxLeverage: 50, availableQuote: 10_000, availableBase: 10, position: null, ...(marginModes !== undefined ? { marginModes } : {}) }),
    normalize: async (ticket) => ({ ticket, displaySymbol: ticket.symbol, amount: ticket.amount, contracts: null, price: null, triggerPrice: null, last: 100, value: ticket.amount * 100, margin: null, available: 10_000, currency: 'USDT', env: 'live', warnings: [], errors: [...normalizeErrors] }),
    place: async (p) => {
      // The bot's key is saved before the order leaves (TD-BOT §4).
      const row = await ctx.db.get<{ state: string }>('SELECT TOP (1) state FROM bots ORDER BY id DESC');
      const st = JSON.parse(row?.state ?? '{}') as BotState;
      expect(st.pending?.key).toBe(p.ticket.idemKey);
      if (placeError) {
        const e = placeError;
        placeError = null;
        throw e;
      }
      placed.push(p.ticket);
      return { status: 'filled', orderId: `o${placed.length}`, message: null, followUps: [] };
    },
    cancel: async () => ({ status: 'cancelled', orderId: null, message: null, followUps: [] }),
    normalizeModify: async () => {
      throw new Error('not used');
    },
    modify: async () => {
      throw new Error('not used');
    },
  };
  return t;
};

/** A simulated US market, open. */
const fakeStocks = {
  confirmedStatus: async () => ({ state: 'open', label: 'Deschisă', opensAt: null, closesAt: null, fetchedAt: clock }),
  quote: async (sym: string) => {
    const p = px[sym];
    if (p === undefined) throw new Error(`fără ${sym}`);
    return { symbol: sym, name: null, last: p, change: null, changePct: null, status: 'Market Open', fetchedAt: clock };
  },
};

const post = (url: string, body?: unknown) => app.inject({ method: 'POST', url, headers: H, payload: body === undefined ? '{}' : JSON.stringify(body) });
const put = (url: string, body: unknown) => app.inject({ method: 'PUT', url, headers: H, payload: JSON.stringify(body) });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: H });
const detail = async (id: number) => (await get(`/api/bots/${id}`)).json() as BotDetail;
const look = async (ms = 30_000) => {
  clock += ms;
  await engine.run();
};

/** FD-PAPER: the bots simulate on a Paper Trading profile (made in `beforeEach`): crypto by default, shares on `paperStocks`. */
let paperCrypto = 0;
let paperStocks = 0;
/** Another crypto profile (one bot a symbol on a profile: a second bot on the same symbol needs one of its own). */
const paperProfile = (label: string) => ctx.paper.create(1, { label, kind: 'crypto', budget: 1_000_000, commissionType: 'percent', commissionValue: 0.1 }, 20);
const common = {
  name: 'Test',
  exec: 'real',
  accountId: null as number | null,
  market: 'spot',
  symbols: ['BTC/USDT'],
  tf: '1h',
  maxAmount: 1000,
  leverage: 1,
  startsAt: null,
  endsAt: null,
  endAction: 'close',
  dailyLoss: null,
  lossStop: null,
  fee: 0.1,
};
const grid = { lower: 90, upper: 110, grids: 4, spacing: 'arithmetic', direction: 'long', stopBelow: null, stopAbove: null, trigger: null };
const dca = { direction: 'long', baseOrder: 100, safetyOrders: 2, safetyOrder: 100, volumeScale: 1, deviation: 2, stepScale: 1, takeProfit: 2, stopLoss: null, slAction: 'stop', repeat: true, maxCycles: null, cooldownMin: 0 };
const premium = {
  direction: 'long',
  sizing: 'fixed',
  amount: 100,
  riskPct: 1,
  maxPerTrade: null,
  levels: 'slingshot',
  slPct: 1,
  tpPct: 2,
  exitOnTpSignal: true,
  exitOnFlip: true,
  exitOnOpposite: true,
  longMin: 50,
  shortMax: 50,
  areaVeto: true,
  newsWindowMin: 0,
  weights: DEFAULT_WEIGHTS,
  ai: 'off',
  aiFallback: 'skip',
  maxOpen: 1,
  cooldownMin: 0,
};
const make = async (body: Record<string, unknown>) => {
  const r = await post('/api/bots', body);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as BotDetail;
};

/** A Slingshot result with the given signals and alerts; the closed bar is 10, opened at `closedTime`. */
const slingshot = (signals: Partial<SlingshotSignal>[], alerts: SlingshotResult['alerts'] = [], closedTime = clock - HOUR, setups: Partial<SlingshotSetup>[] = []): Bar => ({
  r: {
    emaFast: [],
    emaSlow: [],
    uptrend: Array.from({ length: 12 }, () => true),
    markers: [],
    signals: signals.map((s) => ({ side: 'long', bar: 8, time: 8000, confirmBar: 10, confirmTime: 10_000, entry: 95, sl: 90, tp: 115, breakout: 100, outcome: 'active', provisional: false, ...s })),
    // FIX-BOTSHORTS: a setup forming on the closed bar (10), its search started at 9000, its V2 the bar 9, its V1 the bar 5
    // (FIX-BOTV1STOP: its low, 90, the bot's stop; the chart's live stop is 92).
    setups: setups.map((x) => ({ side: 'long', bar: 10, time: 10_000, startBar: 9, startTime: 9000, v2Bar: 9, v2Time: 9000, entry: 96, sl: 92, tp: 112, v1Bar: 5, v1Time: 5000, v1: 90, provisional: false, ...x })),
    alerts,
    atr: null,
    atrShort: null,
    ms: null,
    last: null,
    warnings: [],
  },
  closed: 10,
  closedTime,
  close: px['BTC/USDT'] ?? 100,
});

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sq-bots-'));
  const config = { ...loadConfig({ SENTIQ_DATA_DIR: dir } as NodeJS.ProcessEnv), webDist: path.join(dir, 'no-web') };
  ctx = await createContext(config, silentLogger, { nli: fakeNli, market: fakeMarket, clientFactory: fakeClients, traderFactory: fakeTrader, box: BOX, retryDelaysMs: [0, 0], db: await testDb() });
  app = await buildApp(ctx);
  await ctx.db.run('UPDATE users SET email = ?, name = ?, password_hash = ?, totp_secret = ?, totp_confirmed_at = 1 WHERE id = 1', ['admin@example.com', 'Admin', await hashPassword('Admin-password-1'), BOX.encrypt(newSecret())]);
  H = { host: 'localhost:4317', 'x-sentiq': '1', 'content-type': 'application/json', cookie: `sentiq_session=${await ctx.sessions.create(1, 'full')}` };
  clock = Date.now();
  px = { 'BTC/USDT': 101, 'ETH/USDT': 2000 };
  // FD-PAPER: the profiles the bots simulate on, at the test's prices and clock.
  ctx.paper.setQuotes({ market: fakeMarket, stocks: fakeStocks as never, source: ctx.marketSource }, () => clock);
  paperCrypto = await ctx.paper.create(1, { label: 'Paper Crypto', kind: 'crypto', budget: 1_000_000, commissionType: 'percent', commissionValue: 0.1 }, 20);
  paperStocks = await ctx.paper.create(1, { label: 'Paper Acțiuni', kind: 'stocks', budget: 1_000_000, commissionType: 'percent', commissionValue: 0.1 }, 20);
  common.accountId = paperCrypto;
  thin = new Set();
  stale = new Set();
  ticks = {};
  placed = [];
  placeError = null;
  normalizeErrors = [];
  marginModes = undefined;
  shares = {};
  etoroPositions = [];
  etoroLate = false;
  etoroLateList = [];
  etoroN = 0;
  positions = [];
  futuresFree = 10_000;
  closedHistory = [];
  barSpec = null;
  mood = { index: 50, area: 50, areaCount: 20 };
  aiAnswer = null;
  aiAsked = [];
  keyN = 0;
  const d = ctx.botEngine.deps;
  engine = new BotEngine({
    ...d,
    now: () => clock,
    uuid: () => `0f3c2a1e-5b6d-4c7e-8f90-${String(++keyN).padStart(12, '0')}`,
    stocks: fakeStocks as never,
    // The closed bar of the bot's timeframe (an hour, a day for shares without a Twelve Data key).
    bars: async (_u, input, _s, now) => {
      const tf = tfSeconds(input.tf) * 1000;
      return barSpec ? { ...slingshot(barSpec.signals, barSpec.alerts, Math.floor(now / tf) * tf - tf, barSpec.setups), ...(barSpec.range ?? {}) } : null;
    },
    accounts: Object.assign(Object.create(Object.getPrototypeOf(d.accounts)), d.accounts, {
      // FD-PAPER: a Paper Trading profile's portfolio is its own (the engine's); the other accounts are simulated here.
      portfolio: async (id: number) => ((await ctx.accounts.isPaper(id)) ? d.accounts.portfolio(id) : ({ accountId: id, exchange: 'kucoin', kind: 'crypto', currency: 'USDT', cash: null, asOf: null, mode: 'classic', balances: [{ asset: 'USDT', account: 'trade', total: 10_000, free: 10_000, used: 0, price: 1, value: 10_000, avgPrice: null, avgSource: null, pnl: null, pnlPct: null }, ...Object.entries(shares).map(([asset, total]) => ({ asset, account: 'invest', total, free: total, used: 0, price: null, value: null, avgPrice: null, avgSource: null, pnl: null, pnlPct: null })), ...(etoroPositions.some((p) => p.isBuy) ? [{ asset: 'AAPL', account: 'etoro', total: etoroPositions.filter((p) => p.isBuy).reduce((a, p) => a + p.units, 0), free: 0, used: 0, price: null, value: null, avgPrice: null, avgSource: null, pnl: null, pnlPct: null }] : [])] as never, positions: [...positions, ...etoroPositions.filter((p) => !p.isBuy).map((p) => ({ symbol: 'AAPL/USD', side: 'short', contracts: p.units, size: p.units, entryPrice: null, markPrice: null, unrealizedPnl: null, percentage: null, liquidationPrice: null, leverage: 1, marginMode: null, notional: null }))], orders: [], fills: [], totals: { spotValue: 0, unrealizedPnl: 0, futuresAvailable: futuresFree }, errors: {}, stale: {}, fetchedAt: clock }) as Portfolio),
    }),
    daily: Object.assign(Object.create(Object.getPrototypeOf(d.daily)), d.daily, {
      scopeFor: async () => null,
      today: async () => ({ index: mood.index, confidence: 'high', counts: { positive: 10, neutral: 5, negative: 5, pending: 0, excluded: 0 }, breakdown: { crypto: { index: mood.area, raw: 0, weight: 1, count: mood.areaCount }, stocks: { index: 50, raw: 0, weight: 1, count: 5 }, macro: { index: 50, raw: 0, weight: 1, count: 5 }, geopolitics: { index: 50, raw: 0, weight: 1, count: 5 } }, drivers: { positive: [], negative: [] } }),
      history: async () => [{ day: 'x', index: mood.index, confidence: 'high', count: 10, final: true }],
      coinItems: async () => [],
    }),
    ai: Object.assign(Object.create(Object.getPrototypeOf(d.ai)), d.ai, {
      config: async () => ({ provider: 'anthropic', model: 'claude-test', scoring: false, key: 'sk-test' }),
      client: () => ({
        provider: 'anthropic',
        model: 'claude-test',
        generate: async (req: { system: string; prompt: string }) => {
          aiAsked.push(req);
          return aiAnswer ? { parsed: aiAnswer, stop: 'done', usage: { input: 100, output: 20 } } : Promise.reject(new Error('timeout'));
        },
      }),
    }),
  });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a grid on a Paper Trading profile, end to end (FD-BOT §4, FD-PAPER)', () => {
  it('checks, starts, buys low and sells high, shows itself, stops closing everything, is deleted', async () => {
    const check = (await post('/api/bots/check', { strategy: 'grid', ...common, grid })).json();
    expect(check.errors).toEqual([]);
    expect(check.price).toBe(101);
    expect(check.grid.atStart).toBe(2);
    expect(check.summary[0]).toMatch(/^Între 90 și 110, 4 grile aritmetice/);
    const bot = await make({ strategy: 'grid', ...common, grid });
    expect(bot).toMatchObject({ status: 'running', exec: 'real', account: { id: paperCrypto }, currency: 'USDT', committed: 0 });
    expect(bot.events[0]?.message).toBe('Botul Grid a pornit.');

    await look();
    let d = await detail(bot.id);
    expect(d.grid?.slots.map((s) => s.entry)).toEqual([null, null, 101, 101]);
    const q = d.grid?.qty as number;
    // FD-PAPER: the quantity in the profile's steps (1e-8).
    expect(q * (90 + 95 + 100 + 105)).toBeCloseTo(1000, 4);
    expect(d.positions).toHaveLength(1);
    expect(d.positions[0]).toMatchObject({ side: 'long', entry: 101 });
    expect(d.committed).toBeCloseTo(2 * q * 101, 6);

    px['BTC/USDT'] = 105;
    await look();
    d = await detail(bot.id);
    expect(d.history).toHaveLength(1);
    expect(d.history[0]).toMatchObject({ side: 'long', entry: 101, exit: 105, reason: 'grid' });
    expect(d.history[0]?.pnl).toBeCloseTo(q * 4 - q * 101 * 0.001 - q * 105 * 0.001, 9);
    expect(d.grid?.slots.map((s) => s.entry)).toEqual([null, null, null, 101]);

    px['BTC/USDT'] = 94;
    await look();
    d = await detail(bot.id);
    expect(d.grid?.slots.map((s) => s.entry)).toEqual([null, 94, 94, 101]);
    expect(d.events.find((e) => e.kind === 'enter')?.message).toMatch(/Grila la 94: 2 intervale umplute/);

    // Grids cannot be finished; stopping closes them.
    expect((await post(`/api/bots/${bot.id}/stop`, { action: 'finish' })).statusCode).toBe(400);
    expect((await del(`/api/bots/${bot.id}`)).statusCode).toBe(409);
    expect((await post(`/api/bots/${bot.id}/stop`, { action: 'close' })).json().status).toBe('ending');
    await look();
    d = await detail(bot.id);
    expect(d.status).toBe('ended');
    expect(d.positions).toEqual([]);
    expect(d.history.filter((t) => t.reason === 'stop')).toHaveLength(3);
    expect(d.trades).toBe(4);
    // The profile holds what the bot holds: nothing once it closed everything.
    const pf = await ctx.accounts.portfolio(paperCrypto);
    expect(pf.positions).toEqual([]);
    expect((await put(`/api/bots/${bot.id}`, { name: 'x', endsAt: null, endAction: 'close', dailyLoss: null, lossStop: null, fee: 0.1 })).statusCode).toBe(409);
    expect((await del(`/api/bots/${bot.id}`)).json()).toEqual({ ok: true });
    expect((await get('/api/bots')).json()).toEqual([]);
  });

  it('a start price waits; "Oprește sub" closes everything and ends the bot', async () => {
    const bot = await make({ strategy: 'grid', ...common, grid: { ...grid, trigger: 103, stopBelow: 85 } });
    await look();
    expect((await detail(bot.id)).grid).toMatchObject({ armed: true, trigger: 103 });
    px['BTC/USDT'] = 103.5;
    await look();
    let d = await detail(bot.id);
    expect(d.grid?.armed).toBe(false);
    // Started at 103.5: the grids above it (100–105, 105–110) bought at the market.
    expect(d.grid?.slots.map((s) => s.entry)).toEqual([null, null, 103.5, 103.5]);
    px['BTC/USDT'] = 84;
    await look();
    d = await detail(bot.id);
    expect(d.history.at(0)?.reason).toBe('grid_stop');
    await look();
    d = await detail(bot.id);
    expect(d).toMatchObject({ status: 'ended', statusReason: expect.stringMatching(/Oprește sub/) });
  });
});

describe('DCA, the period, the pause and the loss limits (FD-BOT §3, §5)', () => {
  it('scheduled → running → the period ends → finishes the open cycle → ended', async () => {
    const start = Date.now() + 2 * MIN;
    const bot = await make({ strategy: 'dca', ...common, startsAt: start, endsAt: start + 10 * MIN, endAction: 'finish', dca });
    expect(bot.status).toBe('scheduled');
    await look();
    expect((await detail(bot.id)).status).toBe('scheduled');
    clock = start;
    await look(1);
    let d = await detail(bot.id);
    expect(d.status).toBe('running');
    expect(d.dca?.deal).toMatchObject({ basePrice: 101, filled: 0 });
    // Both safety orders at once (2% and 4% down).
    px['BTC/USDT'] = 96;
    await look();
    d = await detail(bot.id);
    expect(d.dca?.deal?.filled).toBe(2);
    expect(d.events.find((e) => e.kind === 'enter')?.message).toMatch(/Ordinele de siguranță 1, 2 la 96/);
    // The period ends: no new cycle, the open one goes on to its take profit.
    clock = start + 10 * MIN;
    await look(1);
    d = await detail(bot.id);
    expect(d.status).toBe('ending');
    px['BTC/USDT'] = (d.dca?.deal?.tp as number) + 0.01;
    await look();
    d = await detail(bot.id);
    expect(d.status).toBe('ended');
    expect(d.history[0]).toMatchObject({ reason: 'tp' });
    expect(d.history[0]?.pnl).toBeGreaterThan(0);
  });

  it('a pause opens nothing new but takes the profit; "Reia" starts the next cycle', async () => {
    const bot = await make({ strategy: 'dca', ...common, dca });
    await look();
    expect((await post(`/api/bots/${bot.id}/pause`)).json().status).toBe('paused');
    expect((await post(`/api/bots/${bot.id}/pause`)).statusCode).toBe(409);
    px['BTC/USDT'] = 103.1;
    await look();
    let d = await detail(bot.id);
    expect(d.history).toHaveLength(1);
    expect(d.dca?.deal).toBeNull();
    await look();
    expect((await detail(bot.id)).dca?.deal).toBeNull();
    expect((await post(`/api/bots/${bot.id}/resume`)).json().status).toBe('running');
    await look();
    d = await detail(bot.id);
    expect(d.dca?.deal?.basePrice).toBe(103.1);
    expect(d.dca?.cycle).toBe(2);
  });

  it('no price for 10 minutes is a problem that passes by itself when the price is back', async () => {
    const bot = await make({ strategy: 'dca', ...common, dca });
    await look();
    delete px['BTC/USDT'];
    for (let i = 0; i < 21; i++) await look();
    let d = await detail(bot.id);
    expect(d).toMatchObject({ status: 'problem', statusReason: 'Prețul nu se poate citi de 10 minute.' });
    px['BTC/USDT'] = 101;
    await look();
    d = await detail(bot.id);
    expect(d.status).toBe('running');
    expect(d.events[0]?.message).toMatch(/Prețul se citește din nou/);
  });

  it('the daily loss stops the entries until the next day; the exits go on', async () => {
    const bot = await make({ strategy: 'dca', ...common, dailyLoss: 5, dca: { ...dca, safetyOrders: 0, stopLoss: 3, slAction: 'restart' } });
    await look();
    // −3%: the stop loss closes the cycle; the next opens at the next look.
    px['BTC/USDT'] = 97.9;
    await look();
    let d = await detail(bot.id);
    expect(d.history[0]?.reason).toBe('sl');
    expect(d.dca?.deal).toBeNull();
    await look();
    expect((await detail(bot.id)).dca?.deal?.basePrice).toBe(97.9);
    // Down 3% again: more than 5 lost today; the stop loss still closes, no new cycle opens.
    px['BTC/USDT'] = 94.9;
    await look();
    d = await detail(bot.id);
    expect(d.history).toHaveLength(2);
    expect(d.events.filter((e) => /Pierderea maximă pe zi/.test(e.message))).toHaveLength(1);
    await look();
    d = await detail(bot.id);
    expect(d.dca?.deal).toBeNull();
    expect(d.dca?.cycle).toBe(2);
  });

  it('the loss that stops the bot closes everything at once and ends it', async () => {
    const bot = await make({ strategy: 'dca', ...common, lossStop: 5, dca: { ...dca, safetyOrders: 0 } });
    await look();
    px['BTC/USDT'] = 95;
    await look();
    const d = await detail(bot.id);
    expect(d).toMatchObject({ status: 'ended', statusReason: 'Pierderea la care se oprește a fost atinsă.' });
    expect(d.history[0]).toMatchObject({ reason: 'loss_limit', exit: 95 });
  });
});

describe('real orders (FD-BOT §2, §8, §9)', () => {
  let account: number;
  beforeEach(async () => {
    account = (await ctx.accounts.create(1, { exchange: 'kucoin', label: 'KuCoin', credentials: { apiKey: 'k1234567', secret: 's1234567', password: 'p1234567' } })).id;
    await ctx.accounts.setTrading(account, ['spot', 'futures']);
  });

  it('sends a market order with the saved key; after a network error, the same key again; one real bot per symbol', async () => {
    const body = { strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 5, dca };
    const check = (await post('/api/bots/check', body)).json();
    expect(check.errors).toEqual([]);
    expect(check.warnings[0]).toMatch(/Botul trimite ordine reale/);
    const bot = await make(body);
    expect((await post('/api/bots', body)).json().error.message).toMatch(/tranzacționează deja BTC\/USDT pe acest cont/);
    placeError = new Error('socket hang up');
    await look();
    let st = JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [bot.id]))!.state) as BotState;
    expect(st.pending?.key).toBe('0f3c2a1e-5b6d-4c7e-8f90-000000000001');
    expect(placed).toHaveLength(0);
    await look();
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ idemKey: '0f3c2a1e-5b6d-4c7e-8f90-000000000001', market: 'futures', symbol: 'BTC/USDT:USDT', side: 'buy', kind: 'market', amountIn: 'base', leverage: 5 });
    // 100 × 5 / 101, rounded down to the step.
    expect(placed[0]?.amount).toBe(4.9504);
    st = JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [bot.id]))!.state) as BotState;
    expect(st.pending).toBeNull();
    expect(st.dca?.deal?.qty).toBe(4.9504);
    // The bot's orders are in the trading journal: the one cut off by the network, then the one sent.
    expect((await get('/api/trading/log')).json().filter((r: { action: string }) => r.action === 'order').map((r: { status: string }) => r.status).sort()).toEqual(['error', 'sent']);
  });

  it('an order whose fate is unknown is a problem; "Reia" forgets it; a deleted account ends the bot', async () => {
    const bot = await make({ strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 2, dca });
    placeError = new TradingError('UNKNOWN_OUTCOME', 'Nu știm sigur dacă ordinul a ajuns.');
    await look();
    let d = await detail(bot.id);
    expect(d).toMatchObject({ status: 'problem', statusReason: expect.stringMatching(/Nu știm sigur/) });
    await look();
    expect(placed).toHaveLength(0);
    expect((await post(`/api/bots/${bot.id}/resume`)).json().status).toBe('running');
    await look();
    expect(placed).toHaveLength(1);
    await ctx.db.run('DELETE FROM exchange_accounts WHERE id = ?', [account]);
    await look();
    d = await detail(bot.id);
    expect(d).toMatchObject({ status: 'ended', statusReason: expect.stringMatching(/Contul a fost șters/), account: null });
  });

  it('a position closed outside the bot is booked "din afară"; a foreign position keeps the bot out', async () => {
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 1, size: 1, entryPrice: 90, markPrice: 101, unrealizedPnl: 11, percentage: null, liquidationPrice: null, leverage: 2, marginMode: 'cross', notional: 101 }];
    const bot = await make({ strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 2, dca });
    await look();
    let d = await detail(bot.id);
    expect(placed).toHaveLength(0);
    expect(d.events[0]?.message).toMatch(/Există deja o poziție pe BTC\/USDT:USDT care nu e a botului/);
    positions = [];
    await look();
    expect(placed).toHaveLength(1);
    const qty = placed[0]?.amount as number;
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: qty, size: qty, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: 2, marginMode: 'cross', notional: 101 * qty }];
    await look(2 * MIN);
    expect((await detail(bot.id)).history).toHaveLength(0);
    // Closed by hand on the platform.
    positions = [];
    px['BTC/USDT'] = 102;
    await look();
    d = await detail(bot.id);
    expect(d.history[0]).toMatchObject({ reason: 'external', exit: 102 });
    expect(d.events.some((e) => /nu mai e în cont/.test(e.message))).toBe(true);
  });

  it('a refused entry waits 5 minutes, said once; a problem sends nothing and cannot be paused', async () => {
    const bot = await make({ strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 2, dca });
    normalizeErrors = ['Fonduri insuficiente.'];
    await look();
    await look();
    let d = await detail(bot.id);
    expect(d.events.filter((e) => /Intrarea a fost refuzată: Fonduri insuficiente\. Botul mai încearcă peste 5 minute/.test(e.message))).toHaveLength(1);
    expect(d.dca?.deal ?? null).toBeNull();
    normalizeErrors = [];
    await look();
    expect((await detail(bot.id)).dca?.deal ?? null).toBeNull();
    await look(5 * MIN);
    d = await detail(bot.id);
    expect(d.dca?.deal?.filled).toBe(0);
    expect(placed).toHaveLength(1);
    const q = placed[0]?.amount as number;
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: q, size: q, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: 2, marginMode: 'cross', notional: 101 * q }];
    // A problem: no order, not even the take profit, until "Reia"; "Pauză" is not offered.
    placeError = new TradingError('PERMISSION', 'Cheia nu are dreptul de tranzacționare.');
    px['BTC/USDT'] = 96;
    await look();
    expect((await detail(bot.id)).status).toBe('problem');
    expect((await post(`/api/bots/${bot.id}/pause`)).statusCode).toBe(409);
    px['BTC/USDT'] = 110;
    await look();
    expect(placed).toHaveLength(1);
    expect((await detail(bot.id)).events.filter((e) => e.kind === 'problem')).toHaveLength(1);
    await post(`/api/bots/${bot.id}/resume`);
    await look();
    d = await detail(bot.id);
    expect(placed).toHaveLength(2);
    expect(d.history[0]?.reason).toBe('tp');
  });

  it("a real grid's unit is whole steps of the platform, so the account holds what the bot thinks", async () => {
    const bot = await make({ strategy: 'grid', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 2, grid });
    await look();
    const d = await detail(bot.id);
    // 1000 × 2 / (90 + 95 + 100 + 105) = 5.128… → 5.1282 (step 0.0001); two grids at the start.
    expect(d.grid?.qty).toBe(5.1282);
    expect(placed[0]).toMatchObject({ symbol: 'BTC/USDT:USDT', side: 'buy', amount: 10.2564 });
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 10.2564, size: 10.2564, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: 2, marginMode: 'cross', notional: 1035 }];
    await look(2 * MIN);
    expect((await detail(bot.id)).status).toBe('running');
  });

  it('refuses shares on an exchange account, an account without trading, the 11th active bot', async () => {
    // An exchange account for shares: refused (a broker's account is needed).
    expect((await post('/api/bots/check', { strategy: 'premium', ...common, exec: 'real', accountId: account, market: 'stock', symbols: ['AAPL'], premium })).json().errors).toContain('KuCoin nu e un cont de acțiuni.');
    await ctx.accounts.setTrading(account, null);
    expect((await post('/api/bots', { strategy: 'dca', ...common, exec: 'real', accountId: account, dca })).json().error.message).toMatch(/Tranzacționarea e oprită pe contul KuCoin/);
    // FD-PAPER: one bot a symbol on the profile (two would mix their positions).
    for (let i = 0; i < 10; i++) {
      px[`C${i}/USDT`] = 10;
      await make({ strategy: 'dca', ...common, name: `B${i}`, symbols: [`C${i}/USDT`], dca });
    }
    expect((await post('/api/bots', { strategy: 'dca', ...common, dca })).json().error.message).toMatch(/Cel mult 10 boți activi/);
  });
});

describe('real bots on shares (FD-BOT §10)', () => {
  let t212: number;
  let etoro: number;
  // Shares without a Twelve Data key: 1d.
  const stock = { strategy: 'premium', ...common, exec: 'real', market: 'stock', symbols: ['AAPL'], tf: '1d', premium };
  const DAY = 24 * HOUR;
  beforeEach(async () => {
    px.AAPL = 200;
    t212 = (await ctx.accounts.create(1, { exchange: 'trading212', label: 'T212', credentials: { apiKey: 'k1234567', secret: 's1234567' } })).id;
    await ctx.accounts.setTrading(t212, ['stock']);
    etoro = (await ctx.accounts.create(1, { exchange: 'etoro', label: 'eToro', credentials: { publicKey: 'pub-12345678', userKey: 'usr-12345678' } })).id;
    await ctx.accounts.setTrading(etoro, ['stock']);
  });
  const firstBar = async () => {
    clock = Math.ceil(clock / DAY) * DAY + 15 * HOUR;
    barSpec = { signals: [] };
    await look(1);
  };
  const nextBar = async (spec: NonNullable<typeof barSpec>) => {
    barSpec = spec;
    await look(DAY);
  };

  it("Trading 212: buys on a signal and sells only what it bought (the user's own shares stay); no short there", async () => {
    expect((await post('/api/bots/check', { ...stock, accountId: t212, premium: { ...premium, direction: 'both' } })).json().errors).toContain('La Trading 212, botul face doar long: short pe acțiuni doar la eToro sau pe un profil Paper Trading.');
    shares.AAPL = 5;
    const bot = await make({ ...stock, accountId: t212 });
    await firstBar();
    // FIX-BOTBUDGET: a take profit 15% away, so 100 USD bring at least 10 there.
    await nextBar({ signals: [{ entry: 195, sl: 190, tp: 230 }] });
    expect(placed[0]).toMatchObject({ market: 'stock', symbol: 'AAPL', side: 'buy', kind: 'market', amountIn: 'base', amount: 0.5 });
    expect(placed[0]).not.toHaveProperty('reduceOnly');
    expect(placed[0]).not.toHaveProperty('leverage');
    expect(shares.AAPL).toBe(5.5);
    px.AAPL = 189;
    await look();
    expect(placed[1]).toMatchObject({ side: 'sell', amount: 0.5 });
    expect(shares.AAPL).toBeCloseTo(5, 9);
    expect((await detail(bot.id)).history[0]).toMatchObject({ reason: 'sl', exit: 189 });
  });

  it('eToro: notes its own positions and closes only them; a short goes with its stop loss; a position shown late is found', async () => {
    // The user's own position on the same share.
    etoroPositions.push({ id: 'u1', units: 3, isBuy: true, openedAt: clock - HOUR });
    const bot = await make({ ...stock, accountId: etoro, premium: { ...premium, direction: 'both' } });
    await firstBar();
    await nextBar({ signals: [{ entry: 195, sl: 190, tp: 230 }] });
    expect(placed[0]).toMatchObject({ side: 'buy', amount: 0.5 });
    let st = JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [bot.id]))!.state) as BotState;
    expect(st.refs.AAPL).toEqual({ long: ['e1'], short: [] });
    px.AAPL = 231;
    await look();
    px.AAPL = 216;
    expect(placed[1]).toMatchObject({ side: 'sell', close: { positionIds: ['e1'] } });
    expect(placed[1]?.close).not.toHaveProperty('units');
    expect(etoroPositions).toEqual([{ id: 'u1', units: 3, isBuy: true, openedAt: expect.any(Number) }]);
    // A short, with the trade's stop loss; eToro shows it only later.
    etoroLate = true;
    await nextBar({ signals: [{ side: 'short', time: 9000, entry: 220, sl: 230, tp: 180 }] });
    // 100 USD at 216.
    expect(placed[2]).toMatchObject({ side: 'sell', stopLoss: 230 });
    expect(placed[2]?.amount).toBeCloseTo(100 / 216, 9);
    expect(placed[2]).not.toHaveProperty('close');
    st = JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [bot.id]))!.state) as BotState;
    expect(st.refsWait.AAPL).toMatchObject({ side: 'short' });
    etoroLate = false;
    px.AAPL = 179;
    await look();
    expect(placed[3]).toMatchObject({ side: 'buy', close: { positionIds: ['e2'] } });
    const d = await detail(bot.id);
    expect(d.history.map((t) => t.reason)).toEqual(['tp', 'tp']);
    expect(etoroPositions.map((p) => p.id)).toEqual(['u1']);
  });

  it("eToro: the bot's position closed by hand is found by its id, though the user holds more of the share", async () => {
    etoroPositions.push({ id: 'u1', units: 3, isBuy: true, openedAt: clock - HOUR });
    const bot = await make({ ...stock, accountId: etoro });
    await firstBar();
    await nextBar({ signals: [{ entry: 195, sl: 190, tp: 230 }] });
    expect((await detail(bot.id)).positions).toHaveLength(1);
    etoroPositions = etoroPositions.filter((p) => p.id !== 'e1');
    await look(2 * MIN);
    const d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.history[0]).toMatchObject({ reason: 'external' });
    expect(placed).toHaveLength(1);
  });

  it('eToro shorts need a stop loss: the DCA cycle\'s, the grid\'s "Oprește peste"', async () => {
    const dcaShort = { strategy: 'dca', ...common, exec: 'real', accountId: etoro, market: 'stock', symbols: ['AAPL'], dca: { ...dca, direction: 'short' } };
    expect((await post('/api/bots/check', dcaShort)).json().errors).toContain('eToro cere stop loss la un short: pune stop loss-ul ciclului.');
    expect((await post('/api/bots/check', { ...dcaShort, dca: { ...dca, direction: 'short', stopLoss: 10 } })).json().errors).toEqual([]);
    const gridShort = { strategy: 'grid', ...common, exec: 'real', accountId: etoro, market: 'stock', symbols: ['AAPL'], grid: { ...grid, lower: 190, upper: 210, direction: 'short' } };
    expect((await post('/api/bots/check', gridShort)).json().errors[0]).toMatch(/pune „Oprește peste”/);
    // A DCA short at eToro opens with the cycle's stop loss.
    await make({ ...dcaShort, dca: { ...dca, direction: 'short', stopLoss: 10 } });
    await look();
    expect(placed[0]).toMatchObject({ side: 'sell', market: 'stock' });
    expect(placed[0]?.stopLoss).toBeCloseTo(220, 9);
  });
});

describe('Slingshot Premium (FD-BOT §6)', () => {
  /** The first look notes the closed bar it finds; only the bars that close after it are acted on. */
  const firstBar = async () => {
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
  };
  /** The next hour's bar, with what Slingshot says on it. */
  const nextBar = async (spec: NonNullable<typeof barSpec>) => {
    barSpec = spec;
    await look(HOUR);
  };

  it('enters on a fresh signal with its levels; exits at the stop loss; the journal has the score', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    await nextBar({ signals: [{}] });
    let d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ side: 'long', entry: 101, sl: 90, tp: 115, margin: expect.closeTo(100, 4) });
    const enter = d.events.find((e) => e.kind === 'enter');
    expect(enter?.message).toMatch(/^LONG la 101: SL 90, TP 115, scor/);
    expect(enter?.detail?.score?.parts.map((p) => p.key)).toEqual(['day', 'area', 'general', 'symbol', 'slingshot']);
    // The same signal on the next bar is not a new one.
    await nextBar({ signals: [] });
    expect((await detail(bot.id)).positions).toHaveLength(1);
    px['BTC/USDT'] = 89.9;
    await look();
    d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.history[0]).toMatchObject({ reason: 'sl', exit: 89.9 });
  });

  it("FD-BOTSLRR: enters late with Slingshot's levels whatever the R:R from the price now; a bot saved with a minimum R:R runs", async () => {
    // FIX-BOTBUDGET: 1.000 a trade, so the late entry (its take profit 1,8% away) brings at least 10 there.
    const bot = await make({ strategy: 'premium', ...common, premium: { ...premium, amount: 1000 } });
    // Saved before FD-BOTSLRR: a stop loss and a take profit chosen apart, a minimum R:R of 5 and R as one number.
    const { levels: _l, tpPct: _t, ...rest } = premium;
    const row = await ctx.db.get<{ config: string }>('SELECT config FROM bots WHERE id = ?', [bot.id]);
    const old = { ...JSON.parse(row!.config), premium: { ...rest, amount: 1000, sl: 'slingshot', slPct: 2, tp: 'slingshot', minRr: 5, rr: 3 } };
    await ctx.db.run('UPDATE bots SET config = ? WHERE id = ?', [JSON.stringify(old), bot.id]);
    await firstBar();
    // Entry 95, SL 90, TP 115, the price at 113: 2 of reward for 23 of risk from here; the signal's levels all the same.
    px['BTC/USDT'] = 113;
    await nextBar({ signals: [{}] });
    const d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ side: 'long', entry: 113, sl: 90, tp: 115 });
    const enter = d.events.find((e) => e.kind === 'enter');
    expect(enter?.message).toMatch(/^LONG la 113: SL 90, TP 115, scor/);
    expect(enter?.detail).not.toHaveProperty('rr');
    expect(enter?.detail?.score?.parts.find((p) => p.key === 'slingshot')?.note).not.toMatch(/R:R/);
    expect(d.input).toMatchObject({ premium: { levels: 'slingshot', slPct: 2, tpPct: 6 } });
    const kept = d.input.strategy === 'premium' ? d.input.premium : {};
    expect(['minRr', 'rr', 'sl', 'tp'].filter((k) => k in kept)).toEqual([]);
  });

  it('FD-BOTSLRR: past the stop loss nothing is entered; the AI gets the levels and where they come from, no R:R', async () => {
    // FIX-BOTBUDGET: 2.000 a trade, so the entry at 114 (its take profit 0,9% away) brings at least 10 there.
    const bot = await make({ strategy: 'premium', ...common, maxAmount: 2000, premium: { ...premium, amount: 2000, ai: 'confirm', aiFallback: 'rules' } });
    await firstBar();
    px['BTC/USDT'] = 89;
    await nextBar({ signals: [{}] });
    let d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.events[0]?.message).toBe('LONG: Prețul a trecut deja de stop loss.');
    expect(aiAsked).toHaveLength(0);
    px['BTC/USDT'] = 114;
    aiAnswer = { decision: 'enter', confidence: 70, reason: 'Nimic împotrivă.', risks: [], amount: 0 };
    await nextBar({ signals: [{ time: 9500 }] });
    d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ entry: 114, sl: 90, tp: 115 });
    expect(aiAsked).toHaveLength(1);
    const asked = aiAsked[0]!;
    expect(asked.prompt).toContain('Stop loss: 90.0000. Take profit: 115.0000 (ale semnalului Slingshot).');
    expect(asked.prompt).not.toMatch(/R:R/);
    expect(asked.system).toContain('Nu judeca stop loss-ul, take profit-ul sau raportul risc / câștig');
    expect(asked.system).not.toContain('nivelurile nu au sens');
  });

  it('FD-BOTPCT: "Risc / câștig" enters at the percents from the entry; the check says them and the ratio; out of limits refused', async () => {
    // FIX-BOTBUDGET: 1.000 a trade, so a take profit 2% away brings at least 10 there.
    const bot = await make({ strategy: 'premium', ...common, premium: { ...premium, amount: 1000, levels: 'percent', slPct: 1, tpPct: 2, ai: 'confirm', aiFallback: 'rules' } });
    await firstBar();
    px['BTC/USDT'] = 100;
    aiAnswer = { decision: 'enter', confidence: 70, reason: 'Nimic împotrivă.', risks: [] };
    // The signal's levels (SL 90, TP 115) are not used.
    await nextBar({ signals: [{}] });
    const d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ side: 'long', entry: 100 });
    expect(d.positions[0]?.sl).toBeCloseTo(99, 9);
    expect(d.positions[0]?.tp).toBeCloseTo(102, 9);
    expect(aiAsked[0]?.prompt).toContain('(procentele utilizatorului de la intrare)');
    const check = (await post('/api/bots/check', { strategy: 'premium', ...common, premium: { ...premium, levels: 'percent', slPct: 1.5, tpPct: 3 } })).json() as BotCheck;
    expect(check.summary.join(' ')).toContain('SL 1,5% și TP 3% de la intrare (risc : câștig 1:2).');
    const slingshot = (await post('/api/bots/check', { strategy: 'premium', ...common, premium })).json() as BotCheck;
    expect(slingshot.summary.join(' ')).toContain('SL și TP: ale semnalului Slingshot.');
    const far = await post('/api/bots', { strategy: 'premium', ...common, premium: { ...premium, levels: 'percent', slPct: 1, tpPct: 20 } });
    expect(far.statusCode).toBe(400);
    expect(far.json().error.message).toContain('Raportul risc : câștig 1:20 iese din limite');
    // A tab with an older form (a stop and a take profit chosen apart, a ratio): saved the new way, the same levels.
    const { levels: _l, tpPct: _t, ...rest } = premium;
    const base = { name: 'Test', endsAt: null, endAction: 'finish', dailyLoss: null, lossStop: null, fee: 0.1 };
    const old = await put(`/api/bots/${bot.id}`, { ...base, premium: { ...rest, sl: 'percent', slPct: 2, tp: 'rr', rrRisk: 2, rrReward: 3 } });
    expect(old.statusCode, old.body).toBe(200);
    expect((old.json() as BotDetail).input).toMatchObject({ premium: { levels: 'percent', slPct: 2, tpPct: 3 } });
  });

  it('FD-BOTDIR: the market score is low for a negative market: a short enters under its maximum, a long stays out under its minimum; the other way round when positive', async () => {
    const bot = await make({ strategy: 'premium', ...common, market: 'futures', leverage: 3, premium: { ...premium, direction: 'both', longMin: 55, shortMax: 45, areaVeto: false } });
    await firstBar();
    // 50 + 50 × (20 × −0.6 + 30 × −0.4 + 15 × −0.6) / 85 (no news about the symbol, no break of structure) = 30.6.
    mood = { index: 20, area: 30, areaCount: 20 };
    await nextBar({ signals: [{ side: 'short', time: 9000, sl: 110, tp: 90 }] });
    let d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ side: 'short', sl: 110, tp: 90 });
    const enter = d.events.find((e) => e.kind === 'enter');
    expect(enter?.message).toBe('SHORT la 101 3×: SL 110, TP 90, scor 30,6. Suma: 100,00 USDT, poziția 300,00 USDT.');
    expect(enter?.detail?.score).toMatchObject({ score: 30.6, limit: { side: 'short', value: 45 } });
    expect(enter?.detail?.score?.min).toBeUndefined();
    expect(enter?.detail?.score?.parts.find((p) => p.key === 'area')).toMatchObject({ value: 30, a: -0.4 });
    // A long on the same market: the short closes on the opposite signal, the long stays out.
    await nextBar({ signals: [{ time: 9100 }] });
    d = await detail(bot.id);
    expect(d.history[0]?.reason).toBe('opposite');
    expect(d.positions).toEqual([]);
    expect(d.events[0]?.message).toBe('LONG: scorul pieței 30,6 e sub minimul pentru long (55).');
    expect(d.events[0]?.detail?.score?.limit).toEqual({ side: 'long', value: 55 });
    // A positive market: 50 + 50 × (12 + 3 + 9) / 85 = 64.1.
    mood = { index: 80, area: 55, areaCount: 20 };
    await nextBar({ signals: [{ side: 'short', time: 9200, sl: 110, tp: 90 }] });
    d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.events[0]?.message).toBe('SHORT: scorul pieței 64,1 e peste maximul pentru short (45).');
    await nextBar({ signals: [{ time: 9300 }] });
    d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ side: 'long' });
    expect(d.events.find((e) => e.kind === 'enter')?.message).toMatch(/^LONG la 101 3×: .*, scor 64,1\. Suma: 100,00 USDT, poziția 300,00 USDT\.$/);
  });

  it('FD-BOTDIR: two signals on one bar, both within their thresholds: the side the market favours first, only it asks the AI; the check says the thresholds', async () => {
    const bot = await make({ strategy: 'premium', ...common, market: 'futures', leverage: 3, premium: { ...premium, direction: 'both', longMin: 0, shortMax: 100, areaVeto: false, ai: 'confirm' } });
    await firstBar();
    mood = { index: 20, area: 30, areaCount: 20 };
    aiAnswer = { decision: 'enter', confidence: 70, reason: 'Piața e negativă.', risks: [] };
    await nextBar({ signals: [{ time: 9000 }, { side: 'short', time: 9100, sl: 110, tp: 90 }] });
    const d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ side: 'short' });
    expect(d.events.map((e) => e.message)).toContain('LONG: botul a intrat deja pe semnalul celălalt.');
    expect(aiAsked).toHaveLength(1);
    expect(aiAsked[0]?.prompt).toContain('Scorul pieței (0–100, 50 neutru; peste 50 favorizează long-ul, sub 50 short-ul): 30.6. Un SHORT intră până la 100.');
    expect(aiAsked[0]?.prompt).toContain('- Aria: 30 (negativ, 20 știri), pondere 30.');
    const futures = { strategy: 'premium', ...common, market: 'futures', leverage: 3 };
    const say = async (p: Record<string, unknown>) => (await post('/api/bots/check', { ...futures, premium: { ...premium, ...p } })).json() as BotCheck;
    expect((await say({ direction: 'both', longMin: 39, shortMax: 61 })).summary.join(' ')).toContain(
      'Intră la setup-ul Slingshot long și short de pe 1h, la închiderea primei lumânări cu setup-ul în formare: long când scorul pieței e cel puțin 39, short când e cel mult 61; stop loss-ul stă la V1 (unde Slingshot anulează setup-ul), iar la confirmare SL / TP-ul se mută la cele ale semnalului.',
    );
    expect((await say({ direction: 'short', ai: 'confirm', entry: 'signal' })).summary.join(' ')).toContain('Intră pe semnalele Slingshot short confirmate de pe 1h, când scorul pieței e cel mult 50. AI-ul confirmă fiecare intrare.');
    const never = await say({ direction: 'both', longMin: 95, shortMax: 5 });
    expect(never.warnings).toContain('Cu ponderile alese, scorul pieței ajunge cel mult la 94: cu minimul 95, botul nu intră niciodată long.');
    expect(never.warnings).toContain('Cu ponderile alese, scorul pieței coboară cel mult până la 6: cu maximul 5, botul nu intră niciodată short.');
    expect((await say({ direction: 'long', longMin: 94, shortMax: 5 })).warnings.filter((w) => w.includes('niciodată'))).toEqual([]);
  });

  it('the area against, a short on a long-only bot: no entry, with the reason; a signal before the start is not taken', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    // The bar closed before the bot's first look: noted, not taken.
    barSpec = { signals: [{}] };
    await look(1);
    expect((await detail(bot.id)).positions).toEqual([]);
    mood.area = 30;
    await nextBar({ signals: [{ time: 8500 }, { side: 'short', time: 9000, sl: 110, tp: 90 }] });
    const d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    const msgs = d.events.map((e) => e.message);
    expect(msgs).toContain('LONG: aria Crypto e negativă (30).');
    expect(msgs).toContain('SHORT: botul face doar long.');
  });

  it('the AI can refuse; when it does not answer, the fallback decides; the take profit signal closes', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium: { ...premium, ai: 'confirm', aiFallback: 'rules' } });
    await firstBar();
    aiAnswer = { decision: 'skip', confidence: 80, reason: 'Știrile simbolului sunt negative.', risks: [] };
    await nextBar({ signals: [{}] });
    let d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.events[0]?.message).toBe('LONG: AI-ul a spus nu (80%): Știrile simbolului sunt negative.');
    expect(d.events[0]?.detail?.ai?.decision).toBe('skip');
    aiAnswer = null;
    await nextBar({ signals: [{ time: 9500 }] });
    d = await detail(bot.id);
    expect(d.positions).toHaveLength(1);
    expect(d.events.some((e) => /AI-ul nu a răspuns .* intrarea merge după reguli/.test(e.message))).toBe(true);
    await nextBar({ signals: [], alerts: [{ bar: 10, time: 10_000, type: 'takeProfitSignal', provisional: false }] });
    d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.history[0]?.reason).toBe('tp_signal');
    expect((await ctx.ai.usage.today(1)).bot.calls).toBe(1);
  });

  it('the trend turning closes; a signal the other way closes and, allowed, opens the other side', async () => {
    const bot = await make({ strategy: 'premium', ...common, market: 'futures', leverage: 3, premium: { ...premium, direction: 'both' } });
    await firstBar();
    await nextBar({ signals: [{}] });
    expect((await detail(bot.id)).positions[0]).toMatchObject({ side: 'long', leverage: 3, margin: expect.closeTo(100, 4) });
    await nextBar({ signals: [{ outcome: 'invalidated', outcomeReason: 'trendFlip', closedBar: 10, confirmBar: 9 }] });
    let d = await detail(bot.id);
    expect(d.history[0]?.reason).toBe('flip');
    await nextBar({ signals: [{ time: 9100 }] });
    await nextBar({ signals: [{ time: 9100, confirmBar: 8 }, { side: 'short', time: 9200, sl: 110, tp: 90 }] });
    d = await detail(bot.id);
    expect(d.history[0]?.reason).toBe('opposite');
    expect(d.positions[0]).toMatchObject({ side: 'short', sl: 110, tp: 90 });
  });

  it('edits the filter for the trades to come; FD-BOTEDIT: a grid\'s investment changes too', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    const base = { name: 'Nou', endsAt: null, endAction: 'finish', dailyLoss: null, lossStop: null, fee: 0.2 };
    const r = await put(`/api/bots/${bot.id}`, { ...base, premium: { ...premium, longMin: 70 } });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as BotDetail).input).toMatchObject({ name: 'Nou', fee: 0.2, premium: { longMin: 70, shortMax: 50 } });
    expect((await put(`/api/bots/${bot.id}`, { ...base, endsAt: Date.now() - 1000 })).json().error.message).toBe('Sfârșitul e în trecut.');
    const g = await make({ strategy: 'grid', ...common, accountId: await paperProfile('Paper 2'), grid });
    const r2 = await put(`/api/bots/${g.id}`, { ...base, endAction: 'close', maxAmount: 2000 });
    expect(r2.statusCode, r2.body).toBe(200);
    expect((r2.json() as BotDetail).input).toMatchObject({ name: 'Nou', maxAmount: 2000 });
    const list = (await get('/api/bots')).json() as BotView[];
    expect(list.map((b) => b.name)).toEqual(['Nou', 'Nou']);
  });
});

describe("the signals' timeframe changed on a started bot (FD-BOTTF)", () => {
  const H4 = 4 * HOUR;
  /** The first look on 1h, 2 h into a 4h bar: the 1h bar it notes opened 1 h after the 4h one. */
  const firstBar = async () => {
    clock = Math.ceil(clock / H4) * H4 + 2 * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
  };
  const base = { name: 'Test', endsAt: null, endAction: 'finish', dailyLoss: null, lossStop: null, fee: 0.1 };
  const retf = (id: number, tf: string, more: Record<string, unknown> = { premium }) => put(`/api/bots/${id}`, { ...base, ...more, tf });
  const stateOf = async (id: number) => JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [id]))!.state) as BotState;
  const NOTE = 'Timeframe-ul semnalelor e acum 4h (era 1h): botul ia semnalele de pe lumânările de 4h care se închid de acum.';
  const KEEPS = ' Pozițiile deschise își păstrează SL / TP-ul; semnalul de 1h pe care au intrat nu se mai urmărește.';

  it('takes only the 4h bars that close after the change, the first one too (it opened before the last 1h bar read)', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    const r = await retf(bot.id, '4h');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json() as BotDetail).toMatchObject({ tf: '4h', input: { tf: '4h' } });
    expect(((await get('/api/bots')).json() as BotView[])[0]?.tf).toBe('4h');
    // The 4h bar closed already, with a signal: only noted, as at the start.
    barSpec = { signals: [{}] };
    await look();
    let d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.events.some((e) => e.message.startsWith('LONG'))).toBe(false);
    expect(d.events[0]?.message).toBe(NOTE);
    expect((await stateOf(bot.id)).premium?.tf).toBe('4h');
    // The 4h bar that closes next opened before the last 1h bar read: it is taken all the same.
    barSpec = { signals: [{ time: 9000 }] };
    await look(2 * HOUR);
    d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ side: 'long', sl: 90, tp: 115 });
  });

  it('an open position keeps its levels; a signal of the same time on 4h is not its own; the 4h take profit signal closes it', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    barSpec = { signals: [{}] };
    await look(HOUR);
    expect((await detail(bot.id)).positions).toHaveLength(1);
    expect((await stateOf(bot.id)).premium?.positions[0]?.signalTime).toBe(8000);
    expect((await retf(bot.id, '4h')).statusCode).toBe(200);
    // On 4h, a signal with the position's time is invalidated by the trend: not the position's signal.
    const flip = () => ({ signals: [{ outcome: 'invalidated' as const, outcomeReason: 'trendFlip' as const, closedBar: 10, confirmBar: 9 }] });
    barSpec = flip();
    await look();
    barSpec = flip();
    await look(2 * H4);
    let d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ side: 'long', sl: 90, tp: 115 });
    expect(d.history).toEqual([]);
    expect(d.events.some((e) => e.message === NOTE + KEEPS)).toBe(true);
    expect((await stateOf(bot.id)).premium?.positions[0]?.signalTime).toBeUndefined();
    barSpec = { signals: [], alerts: [{ bar: 10, time: 10_000, type: 'takeProfitSignal', provisional: false }] };
    await look(H4);
    d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.history[0]?.reason).toBe('tp_signal');
  });

  it('there and back before the bot looks: nothing changes for it; a state from before keeps its bars', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    const before = await stateOf(bot.id);
    expect(before.premium?.tf).toBe('1h');
    expect((await retf(bot.id, '4h')).statusCode).toBe(200);
    expect((await retf(bot.id, '1h')).statusCode).toBe(200);
    barSpec = { signals: [] };
    await look();
    let st = await stateOf(bot.id);
    expect(st.premium?.lastBar).toEqual(before.premium?.lastBar);
    expect(st.premium?.nextRead).toEqual(before.premium?.nextRead);
    expect((await detail(bot.id)).events.some((e) => e.message.startsWith('Timeframe-ul semnalelor'))).toBe(false);
    // A state written before FD-BOTTF has no timeframe: the bot's own is taken, the bars stay.
    const { tf: _tf, ...old } = st.premium!;
    await ctx.db.run('UPDATE bots SET state = ? WHERE id = ?', [JSON.stringify({ ...st, premium: old }), bot.id]);
    await look();
    st = await stateOf(bot.id);
    expect(st.premium?.tf).toBe('1h');
    expect(st.premium?.lastBar).toEqual(before.premium?.lastBar);
    expect((await detail(bot.id)).events.some((e) => e.message.startsWith('Timeframe-ul semnalelor'))).toBe(false);
  });

  it('a real entry still being retried when the timeframe changes opens without the old signal', async () => {
    const account = (await ctx.accounts.create(1, { exchange: 'kucoin', label: 'KuCoin', credentials: { apiKey: 'k1234567', secret: 's1234567', password: 'p1234567' } })).id;
    await ctx.accounts.setTrading(account, ['spot', 'futures']);
    const bot = await make({ strategy: 'premium', ...common, exec: 'real', accountId: account, premium });
    await firstBar();
    placeError = new Error('socket hang up');
    barSpec = { signals: [{}] };
    await look(HOUR);
    expect(placed).toHaveLength(0);
    expect((await stateOf(bot.id)).pending).toMatchObject({ purpose: { kind: 'p_open', signalTime: 8000 } });
    expect((await retf(bot.id, '4h')).statusCode).toBe(200);
    barSpec = { signals: [] };
    await look();
    expect(placed).toHaveLength(1);
    const st = await stateOf(bot.id);
    expect(st.pending).toBeNull();
    expect(st.premium?.positions).toHaveLength(1);
    expect(st.premium?.positions[0]?.signalTime).toBeUndefined();
    expect((await detail(bot.id)).events.some((e) => e.message === NOTE + KEEPS)).toBe(true);
  });

  it('FD-BOTEDIT: a grid\'s and a DCA\'s is saved and changes nothing; refused on shares without a Twelve Data key below 1d', async () => {
    const g = await make({ strategy: 'grid', ...common, grid });
    expect((await retf(g.id, '4h', { endAction: 'close' })).statusCode).toBe(200);
    expect((await retf(g.id, '1h', { endAction: 'close' })).statusCode).toBe(200);
    const d = await make({ strategy: 'dca', ...common, symbols: ['ETH/USDT'], dca });
    expect((await retf(d.id, '4h', {})).statusCode).toBe(200);
    px.AAPL = 200;
    const s = await make({ strategy: 'premium', ...common, accountId: paperStocks, market: 'stock', symbols: ['AAPL'], tf: '1d', premium });
    expect((await retf(s.id, '1h')).json().error.message).toBe('AAPL pe 1h cere cheia ta Twelve Data (Setări → Date acțiuni); fără ea, botul merge pe 1d și 1w.');
    expect((await detail(s.id)).tf).toBe('1d');
    const r = await retf(s.id, '1w');
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as BotDetail).input.tf).toBe('1w');
  });
});

describe('FD-BOTEDIT: every setting of a bot that has started', () => {
  const firstBar = async () => {
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
  };
  const nextBar = async (spec: NonNullable<typeof barSpec>) => {
    barSpec = spec;
    await look(HOUR);
  };
  const edit = (id: number, input: unknown, positions?: 'finish' | 'close') => put(`/api/bots/${id}`, { input, ...(positions ? { positions } : {}) });
  const ok = async (r: ReturnType<typeof put>) => {
    const x = await r;
    expect(x.statusCode, x.body).toBe(200);
    return x.json() as BotDetail;
  };
  const checkEdit = async (id: number, input: unknown, positions?: 'finish' | 'close') => {
    const r = await post(`/api/bots/${id}/check`, { input, ...(positions ? { positions } : {}) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as BotCheck;
  };
  const stateOf = async (id: number) => JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [id]))!.state) as BotState;
  const kucoin = async () => {
    const id = (await ctx.accounts.create(1, { exchange: 'kucoin', label: 'KuCoin', credentials: { apiKey: 'k1234567', secret: 's1234567', password: 'p1234567' } })).id;
    await ctx.accounts.setTrading(id, ['spot', 'futures']);
    return id;
  };
  const holding = (qty: number) => [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: qty, size: qty, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: 2, marginMode: 'cross', notional: 101 * qty }] as Portfolio['positions'];

  it('Slingshot: a symbol added enters from the bar that closes after; one taken out keeps its position until it exits', async () => {
    px['ETH/USDT'] = 100;
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    await nextBar({ signals: [{}] });
    expect((await detail(bot.id)).positions).toMatchObject([{ symbol: 'BTC/USDT', side: 'long', margin: expect.closeTo(100, 4) }]);
    // The maximum cannot go under what is in play.
    expect((await checkEdit(bot.id, { ...bot.input, maxAmount: 50, premium: { ...premium, amount: 50 } })).errors).toContain('Suma maximă nu poate coborî sub cât e angajat acum (100).');
    const next = { ...bot.input, symbols: ['ETH/USDT'] };
    const c = await checkEdit(bot.id, next);
    expect(c.errors).toEqual([]);
    expect(c.transition).toBeNull();
    expect(c.summary).toContain('BTC/USDT: scos din bot; poziția lui deschisă iese după regulile ei, fără intrări noi, apoi simbolul dispare din bot.');
    expect(c.summary.some((x) => x.startsWith('Pornește'))).toBe(false);
    expect(await ok(edit(bot.id, next))).toMatchObject({ symbols: ['ETH/USDT'], switching: null, positions: [{ symbol: 'BTC/USDT' }] });
    // A new signal on both: ETH's first bar is only noted; nothing new on BTC (its position's exits only).
    await nextBar({ signals: [{ time: 9000 }] });
    let d = await detail(bot.id);
    expect(d.positions.map((p) => p.symbol)).toEqual(['BTC/USDT']);
    expect(d.events.filter((e) => e.kind === 'enter')).toHaveLength(1);
    // Its stop loss closes it, and the bot forgets the symbol.
    px['BTC/USDT'] = 89.9;
    await look();
    d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.history[0]).toMatchObject({ symbol: 'BTC/USDT', reason: 'sl' });
    expect(Object.keys((await stateOf(bot.id)).premium?.lastBar ?? {})).toEqual(['ETH/USDT']);
    await nextBar({ signals: [{ time: 9100 }] });
    expect((await detail(bot.id)).positions).toMatchObject([{ symbol: 'ETH/USDT', side: 'long', entry: 100 }]);
  });

  it('Paper Trading → a real account, "Se termină": the position on the profile exits by its rules, nothing new meanwhile; then real orders', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    await nextBar({ signals: [{}] });
    const next = { ...bot.input, accountId: account };
    const c = await checkEdit(bot.id, next);
    expect(c.transition).toEqual({ changes: ['contul'], open: 1, modes: ['finish', 'close'], mode: 'finish' });
    expect(c.summary).toContain('Pentru setările noi (contul), poziția deschisă acum se termină întâi cu setările vechi, pe profilul Paper Trading Paper Crypto; botul nu deschide nimic nou până atunci, apoi merge cu cele noi.');
    let d = await ok(edit(bot.id, next, 'finish'));
    expect(d.switching).toEqual({ changes: ['contul'], mode: 'finish' });
    expect(d.positions).toMatchObject([{ symbol: 'BTC/USDT', side: 'long' }]);
    expect(d.events[0]?.message).toBe('Setările au fost schimbate. Pozițiile deschise cu setările vechi se termină întâi (contul), apoi botul merge cu cele noi.');
    await nextBar({ signals: [{ time: 9000 }] });
    d = await detail(bot.id);
    expect(placed).toEqual([]);
    expect(d.events.some((e) => e.message === 'LONG: botul aplică setările noi: întâi se termină pozițiile deschise cu cele vechi.')).toBe(true);
    px['BTC/USDT'] = 89.9;
    await look();
    d = await detail(bot.id);
    // Closed on the profile, not on KuCoin.
    expect(placed).toEqual([]);
    expect(d.history[0]).toMatchObject({ reason: 'sl', exit: 89.9 });
    expect((await ctx.accounts.portfolio(paperCrypto)).positions).toEqual([]);
    expect(d.switching).toBeNull();
    expect(d.events[0]?.message).toBe('Setările noi se aplică de acum (contul).');
    px['BTC/USDT'] = 101;
    await nextBar({ signals: [{ time: 9100 }] });
    expect(placed).toMatchObject([{ market: 'spot', symbol: 'BTC/USDT', side: 'buy', kind: 'market' }]);
    expect((await detail(bot.id)).positions).toMatchObject([{ symbol: 'BTC/USDT', side: 'long' }]);
  });

  it('"Se închid acum": the position on the profile closes at the price ("setări noi"); the next look trades on the real account', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    await nextBar({ signals: [{}] });
    await ok(edit(bot.id, { ...bot.input, accountId: account }, 'close'));
    px['BTC/USDT'] = 103;
    await look();
    const d = await detail(bot.id);
    expect(placed).toEqual([]);
    expect(d.history[0]).toMatchObject({ symbol: 'BTC/USDT', reason: 'edit', exit: 103 });
    expect(d.events.some((e) => e.message.startsWith('Setările noi (contul) cer închiderea pozițiilor deschise cu cele vechi. Poziția long închisă la 103'))).toBe(true);
    expect(d).toMatchObject({ switching: null, exec: 'real', account: { id: account }, positions: [] });
  });

  it('a real account → Paper Trading, "Se închid acum": a real reduce-only close on the account, then cycles from 1 on the profile', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'dca', ...common, accountId: account, market: 'futures', leverage: 2, dca });
    await look();
    expect(placed).toHaveLength(1);
    const qty = placed[0]?.amount as number;
    positions = holding(qty);
    const next = { ...bot.input, accountId: paperCrypto };
    const c = await checkEdit(bot.id, next, 'close');
    expect(c.transition).toMatchObject({ changes: ['contul'], open: 1, mode: 'close' });
    expect(c.summary).toContain('Pentru setările noi (contul), botul închide la piață poziția deschisă acum, cu ordine reale pe contul KuCoin la următoarea verificare (≤ 30 s), apoi merge cu setările noi.');
    await ok(edit(bot.id, next, 'close'));
    await look();
    expect(placed[1]).toMatchObject({ market: 'futures', symbol: 'BTC/USDT:USDT', side: 'sell', reduceOnly: true, amount: qty });
    expect((await detail(bot.id)).history[0]).toMatchObject({ reason: 'edit' });
    positions = [];
    await look();
    const d = await detail(bot.id);
    expect(placed).toHaveLength(2);
    expect(d).toMatchObject({ exec: 'real', account: { id: paperCrypto }, dca: { cycle: 1, deal: { basePrice: 101 } } });
    // The cycle's base order is on the profile.
    expect((await ctx.accounts.portfolio(paperCrypto)).positions).toMatchObject([{ symbol: 'BTC/USDT:USDT', side: 'long', leverage: 2 }]);
  });

  it('DCA: another symbol closes the open cycle ("Se închid acum") or lets it finish with its safety orders; then cycle 1 on the new one', async () => {
    const a = await make({ strategy: 'dca', ...common, dca });
    await look();
    let d = await ok(edit(a.id, { ...a.input, symbols: ['ETH/USDT'], name: 'ETH' }, 'close'));
    expect(d).toMatchObject({ name: 'ETH', symbols: ['ETH/USDT'], switching: { changes: ['simbolul: BTC/USDT → ETH/USDT'], mode: 'close' }, positions: [{ symbol: 'BTC/USDT' }] });
    await look();
    d = await detail(a.id);
    expect(d.history[0]).toMatchObject({ symbol: 'BTC/USDT', reason: 'edit' });
    expect(d.dca).toBeNull();
    await look();
    d = await detail(a.id);
    expect(d).toMatchObject({ dca: { cycle: 1, deal: { basePrice: 2000 } }, positions: [{ symbol: 'ETH/USDT' }] });

    // FD-PAPER: on a profile of its own (bot a trades ETH/USDT on the first one).
    const b = await make({ strategy: 'dca', ...common, accountId: await paperProfile('Paper 2'), dca });
    await look();
    await ok(edit(b.id, { ...b.input, symbols: ['ETH/USDT'] }, 'finish'));
    px['BTC/USDT'] = 96;
    await look();
    d = await detail(b.id);
    expect(d.dca?.deal?.filled).toBe(2);
    px['BTC/USDT'] = (d.dca?.deal?.tp as number) + 0.01;
    await look();
    d = await detail(b.id);
    expect(d.history[0]).toMatchObject({ symbol: 'BTC/USDT', reason: 'tp' });
    expect(d.status).toBe('running');
    await look();
    expect(await detail(b.id)).toMatchObject({ status: 'running', dca: { cycle: 1, deal: { basePrice: 2000 } } });
  });

  it("DCA: a new take profit moves the open cycle's; the direction and the leverage wait for the next cycle; the repeat off between cycles ends the bot", async () => {
    const bot = await make({ strategy: 'dca', ...common, market: 'futures', leverage: 2, dca });
    await look();
    expect((await detail(bot.id)).dca?.deal?.tp).toBeCloseTo(101 * 1.02, 9);
    const tp1 = { ...bot.input, dca: { ...dca, takeProfit: 1 } };
    expect((await checkEdit(bot.id, tp1)).transition).toBeNull();
    expect((await ok(edit(bot.id, tp1))).dca?.deal?.tp).toBeCloseTo(101 * 1.01, 9);
    const short = { ...bot.input, leverage: 3, dca: { ...dca, takeProfit: 1, direction: 'short' } };
    expect((await ok(edit(bot.id, short))).positions[0]).toMatchObject({ side: 'long', leverage: 2 });
    px['BTC/USDT'] = 102.1;
    await look();
    expect((await detail(bot.id)).history[0]).toMatchObject({ side: 'long', reason: 'tp', exit: 102.1 });
    await look();
    expect((await detail(bot.id)).positions[0]).toMatchObject({ side: 'short', leverage: 3, entry: 102.1 });
    await ok(edit(bot.id, { ...short, dca: { ...short.dca, cooldownMin: 60 } }));
    px['BTC/USDT'] = 101;
    await look();
    let d = await detail(bot.id);
    expect(d.history[0]).toMatchObject({ side: 'short', reason: 'tp' });
    expect(d).toMatchObject({ status: 'running', dca: { deal: null } });
    await ok(edit(bot.id, { ...short, dca: { ...short.dca, cooldownMin: 60, repeat: false } }));
    await look();
    d = await detail(bot.id);
    expect(d).toMatchObject({ status: 'ended', statusReason: 'Ciclurile s-au terminat.' });
  });

  it('Grid: the stops apply at once; other limits or another investment close the full intervals ("setări noi"), then a new grid', async () => {
    const bot = await make({ strategy: 'grid', ...common, grid });
    await look();
    expect((await detail(bot.id)).grid?.slots.map((s) => s.entry)).toEqual([null, null, 101, 101]);
    const stops = { ...bot.input, grid: { ...grid, stopBelow: 85 } };
    let c = await checkEdit(bot.id, stops);
    expect(c.transition).toBeNull();
    expect(c.summary).toContain('Grila merge mai departe cu intervalele ei.');
    await ok(edit(bot.id, stops));
    await look();
    expect((await detail(bot.id)).grid?.slots.map((s) => s.entry)).toEqual([null, null, 101, 101]);
    const wider = { ...stops, grid: { ...stops.grid, lower: 80, stopBelow: 75 } };
    const why = 'grila: limitele, grilele, spațierea, direcția, prețul de pornire, suma, levierul sau marja';
    c = await checkEdit(bot.id, wider);
    expect(c.transition).toEqual({ changes: [why], open: 2, modes: ['close'], mode: 'close' });
    expect(c.summary).toContain(`Pentru setările noi (${why}), botul închide la piață cele 2 intervale pline, pe profilul Paper Trading Paper Crypto la următoarea verificare (≤ 30 s), apoi face grila nouă de la prețul de atunci.`);
    expect((await ok(edit(bot.id, wider, 'finish'))).switching).toEqual({ changes: [why], mode: 'close' });
    px['BTC/USDT'] = 102;
    await look();
    let d = await detail(bot.id);
    expect(d.history.filter((t) => t.reason === 'edit')).toHaveLength(2);
    expect(d.grid).toBeNull();
    await look();
    d = await detail(bot.id);
    expect(d.grid?.lines).toEqual([80, 87.5, 95, 102.5, 110]);
    expect(d.grid?.slots.map((s) => s.entry)).toEqual([null, null, 102, 102]);
    expect((await checkEdit(bot.id, { ...wider, maxAmount: 2000 })).transition?.changes).toEqual([why]);
    // A stop the price is already past (a new bot's check too).
    px['BTC/USDT'] = 85;
    const w = (await post('/api/bots/check', { strategy: 'grid', ...common, grid: { ...grid, stopBelow: 88 } })).json() as BotCheck;
    expect(w.warnings.some((x) => /e deja sub „Oprește sub” \(88\): imediat după pornire, botul închide tot și se încheie\./.test(x))).toBe(true);
  });

  it('real: another bot with the symbol on the account, in its settings or in an open position of a symbol taken out of it, is refused', async () => {
    const account = await kucoin();
    px['SOL/USDT'] = 50;
    const a = await make({ strategy: 'dca', ...common, name: 'A', exec: 'real', accountId: account, market: 'futures', leverage: 2, dca });
    await look();
    positions = holding(placed[0]?.amount as number);
    await ok(edit(a.id, { ...a.input, symbols: ['ETH/USDT'] }, 'finish'));
    // A still holds its BTC cycle (on the old symbol): a new real bot on BTC would mix with it.
    expect((await post('/api/bots', { strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 2, dca })).json().error.message).toMatch(/Botul „A” tranzacționează deja BTC\/USDT pe acest cont/);
    const b = await make({ strategy: 'dca', ...common, name: 'B', exec: 'real', accountId: account, market: 'futures', leverage: 2, symbols: ['SOL/USDT'], startsAt: clock + 5 * HOUR, dca });
    expect((await edit(b.id, { ...b.input, symbols: ['ETH/USDT'] })).json().error.message).toMatch(/Botul „A” tranzacționează deja ETH\/USDT pe acest cont/);
    expect((await edit(b.id, { ...b.input, symbols: ['BTC/USDT'] })).json().error.message).toMatch(/Botul „A” tranzacționează deja BTC\/USDT pe acest cont/);
    // On spot the same symbol is another place.
    expect((await edit(b.id, { ...b.input, market: 'spot', leverage: 1, symbols: ['BTC/USDT'] })).statusCode).toBe(200);
  });

  it('a scheduled bot: its start changes ("Acum" starts it at the next look); a started bot keeps its own', async () => {
    const start = Date.now() + 2 * HOUR;
    const bot = await make({ strategy: 'dca', ...common, startsAt: start, dca });
    let d = await ok(edit(bot.id, { ...bot.input, startsAt: start + HOUR }));
    expect(d).toMatchObject({ status: 'scheduled', startsAt: start + HOUR, input: { startsAt: start + HOUR } });
    d = await ok(edit(bot.id, { ...bot.input, startsAt: null }));
    expect(d.startsAt).toBeLessThanOrEqual(Date.now());
    await look(5 * MIN);
    d = await detail(bot.id);
    expect(d.status).toBe('running');
    const begun = d.startsAt;
    d = await ok(edit(bot.id, { ...d.input, startsAt: Date.now() + 5 * HOUR, name: 'Altul' }));
    expect(d).toMatchObject({ name: 'Altul', status: 'running', startsAt: begun });
  });

  it('refuses another type or area; right after a deploy a transition with positions waits for the first look', async () => {
    const bot = await make({ strategy: 'dca', ...common, market: 'futures', leverage: 2, dca });
    expect((await edit(bot.id, { strategy: 'grid', ...common, grid })).json().error.message).toBe('Tipul botului nu se schimbă: „Duplică” face un bot nou.');
    px.AAPL = 200;
    expect((await edit(bot.id, { ...bot.input, market: 'stock', leverage: 1, symbols: ['AAPL'] })).json().error.message).toBe('Aria botului (crypto sau acțiuni) nu se schimbă: „Duplică” face un bot nou.');
    await look();
    // A state from before FD-BOTEDIT: no settings of the positions yet.
    const { basis: _b, ...old } = await stateOf(bot.id);
    delete old.dca?.deal?.lev;
    await ctx.db.run('UPDATE bots SET state = ? WHERE id = ?', [JSON.stringify(old), bot.id]);
    const eth = { ...bot.input, symbols: ['ETH/USDT'] };
    expect((await edit(bot.id, eth)).json().error.message).toBe('Botul se pregătește pentru setări noi; încearcă din nou peste 30 de secunde.');
    // Nor a DCA cycle's leverage (the engine would take the new one for the open cycle).
    expect((await edit(bot.id, { ...bot.input, leverage: 3 })).json().error.message).toMatch(/Botul se pregătește pentru setări noi/);
    expect((await edit(bot.id, { ...bot.input, name: 'X' })).statusCode).toBe(200);
    await look();
    const st = await stateOf(bot.id);
    expect(st.basis).toMatchObject({ name: 'X', symbols: ['BTC/USDT'] });
    expect(st.dca?.deal?.lev).toBe(2);
    expect((await edit(bot.id, { ...bot.input, leverage: 3 })).statusCode).toBe(200);
    expect((await edit(bot.id, eth)).statusCode).toBe(200);
  });

  it('the choice for the positions goes with a "Reia" sent before the bot looks; the engine clears only what it read', async () => {
    const bot = await make({ strategy: 'dca', ...common, dca });
    await look();
    expect((await post(`/api/bots/${bot.id}/pause`)).statusCode).toBe(200);
    await ok(edit(bot.id, { ...bot.input, symbols: ['ETH/USDT'] }, 'close'));
    // Edited again before the bot looks: the choice made stays the default.
    expect((await checkEdit(bot.id, { ...bot.input, symbols: ['ETH/USDT'], name: 'Altul' })).transition?.mode).toBe('close');
    expect((await post(`/api/bots/${bot.id}/resume`)).json().status).toBe('running');
    const command = async () => (await ctx.db.get<{ command: string | null }>('SELECT command FROM bots WHERE id = ?', [bot.id]))?.command ?? null;
    expect(JSON.parse((await command()) as string)).toEqual({ positions: 'close', clearPending: true });
    await look();
    expect((await detail(bot.id)).history[0]).toMatchObject({ symbol: 'BTC/USDT', reason: 'edit' });
    expect(await command()).toBeNull();
    expect(commandLeft('{"positions":"close","clearPending":true}', '{"clearPending":true}')).toBe('{"positions":"close"}');
    expect(commandLeft('{"positions":"close"}', '{"positions":"finish"}')).toBe('{"positions":"close"}');
    expect(commandLeft('{"positions":"close"}', '{"positions":"close"}')).toBeNull();
  });

  it('a stop during a transition decides alone: the page shows the bot ending, not the transition', async () => {
    const bot = await make({ strategy: 'dca', ...common, dca });
    await look();
    expect((await ok(edit(bot.id, { ...bot.input, symbols: ['ETH/USDT'] }, 'finish'))).switching).not.toBeNull();
    expect((await post(`/api/bots/${bot.id}/stop`, { action: 'close' })).json()).toMatchObject({ status: 'ending', switching: null });
    await look();
    const d = await detail(bot.id);
    expect(d).toMatchObject({ status: 'ended', positions: [] });
    expect(d.history[0]).toMatchObject({ symbol: 'BTC/USDT', reason: 'stop' });
  });

  it('the old account deleted during a transition: its positions stay on the platform; the bot goes on with the new settings', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 2, dca });
    await look();
    await ok(edit(bot.id, { ...bot.input, accountId: paperCrypto }, 'finish'));
    await ctx.db.run('DELETE FROM exchange_accounts WHERE id = ?', [account]);
    await look();
    const d = await detail(bot.id);
    expect(d).toMatchObject({ status: 'running', exec: 'real', account: { id: paperCrypto }, switching: null, dca: { cycle: 1 } });
    expect(d.history).toEqual([]);
    expect(d.events.some((e) => e.message.startsWith('Contul cu pozițiile făcute cu setările vechi a fost șters'))).toBe(true);
  });
});

describe('FIX-2ZPRICE: a thin pair without a candle in the last minutes', () => {
  it('the check takes its last trade and says so; a running bot keeps going on it; no price at all is still "fără preț"', async () => {
    px['2Z/USDT'] = 0.0193;
    thin.add('2Z/USDT');
    ticks['2Z/USDT'] = 0.01929;
    const body = { strategy: 'premium', ...common, symbols: ['BTC/USDT', '2Z/USDT'], premium };
    const c = (await post('/api/bots/check', body)).json() as BotCheck;
    expect(c.errors).toEqual([]);
    expect(c.warnings.some((w) => /^Pe \S+, 2Z\/USDT n-a avut tranzacții în ultimele minute: botul ia prețul ultimei tranzacții \(0,01929\)\. La o pereche cu puține tranzacții, prețul de execuție poate fi departe de el\.$/.test(w))).toBe(true);
    // A liquid pair: no word about it.
    expect(c.warnings.some((w) => w.includes('BTC/USDT n-a avut'))).toBe(false);
    const bot = await make(body);
    // Over 10 minutes without a candle on 2Z: the bot goes on (before: a problem, "Prețul nu se poate citi de 10 minute").
    for (let i = 0; i < 25; i++) await look();
    expect(await detail(bot.id)).toMatchObject({ status: 'running', statusReason: null });
    const st = JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [bot.id]))!.state) as BotState;
    expect(st.prices['2Z/USDT']?.p).toBe(0.01929);
    // No candle and nothing in the ticker: no price, as before.
    ticks['2Z/USDT'] = null;
    const none = (await post('/api/bots/check', body)).json() as BotCheck;
    expect(none.errors).toContain('2Z/USDT nu se poate citi la sursa de prețuri: fără preț');
  });

  it('old candles in memory (a chart loaded the history) count as no trade: the ticker, else the last candle', async () => {
    px['2Z/USDT'] = 0.0193;
    stale.add('2Z/USDT');
    ticks['2Z/USDT'] = 0.01929;
    const body = { strategy: 'premium', ...common, symbols: ['2Z/USDT'], premium };
    let c = (await post('/api/bots/check', body)).json() as BotCheck;
    expect(c.errors).toEqual([]);
    expect(c.warnings.some((w) => w.includes('2Z/USDT n-a avut tranzacții în ultimele minute: botul ia prețul ultimei tranzacții (0,01929)'))).toBe(true);
    // The ticker silent: the last candle's close, the last trade too.
    ticks['2Z/USDT'] = null;
    c = (await post('/api/bots/check', body)).json() as BotCheck;
    expect(c.errors).toEqual([]);
    expect(c.warnings.some((w) => w.includes('botul ia prețul ultimei tranzacții (0,0193)'))).toBe(true);
  });
});

describe('FD-TRADES: the trades a bot made, in the account\'s history', () => {
  const firstBar = async () => {
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
  };
  const nextBar = async (spec: NonNullable<typeof barSpec>) => {
    barSpec = spec;
    await look(HOUR);
  };
  const kucoin = async () => {
    const id = (await ctx.accounts.create(1, { exchange: 'kucoin', label: 'KuCoin', credentials: { apiKey: 'k1234567', secret: 's1234567', password: 'p1234567' } })).id;
    await ctx.accounts.setTrading(id, ['spot', 'futures']);
    return id;
  };
  const stateOf = async (id: number) => JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [id]))!.state) as BotState;
  const booked = (id: number) =>
    ctx.db.all<{ account_id: number | null; market: string | null; lev: number | null; sl: number | null; tp: number | null; reason: string; entry: number; exit: number; opened_at: number; closed_at: number }>(
      'SELECT account_id, market, lev, sl, tp, reason, entry, [exit], opened_at, closed_at FROM bot_trades WHERE bot_id = ? ORDER BY id',
      [id],
    );
  const history = async (account: number, period = '30d') => {
    const r = await get(`/api/portfolio/${account}/history?period=${period}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as TradeHistory;
  };
  /** The engine's clock runs ahead of the route's: the bot's trades are moved back by this, as if made earlier today. */
  const backdate = async (id: number, by: number) => ctx.db.run('UPDATE bot_trades SET opened_at = opened_at - ?, closed_at = closed_at - ? WHERE bot_id = ?', [by, by, id]);

  it('a real Slingshot trade on futures: open with its levels, then closed with the account, the market, the leverage, SL / TP; the platform\'s row of it hidden, a manual one listed', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'premium', ...common, name: 'Crypto', exec: 'real', accountId: account, market: 'futures', leverage: 3, premium });
    await firstBar();
    await nextBar({ signals: [{}] });
    const pos = (await stateOf(bot.id)).premium?.positions[0];
    expect(pos).toMatchObject({ symbol: 'BTC/USDT', side: 'long', entry: 101, sl: 90, tp: 115 });
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: pos!.qty, size: pos!.qty, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: pos!.lev, marginMode: 'cross', notional: 101 * pos!.qty }];
    // Open: the bot's row, with its levels and the leverage it runs with.
    let h = await history(account);
    expect(h).toMatchObject({ supported: true, error: null, truncated: false });
    expect(h.rows).toEqual([
      expect.objectContaining({ key: `o|${bot.id}|0`, source: 'bot', bot: { id: bot.id, name: 'Crypto' }, open: true, symbol: 'BTC/USDT', market: 'futures', side: 'long', entry: 101, sl: 90, tp: 115, exit: null, closedAt: null, leverage: pos!.lev, currency: 'USDT', reason: null }),
    ]);
    // The stop loss: closed, booked with what it was made with.
    px['BTC/USDT'] = 89.9;
    await look();
    positions = [];
    const [t] = await booked(bot.id);
    expect(t).toMatchObject({ account_id: account, market: 'futures', lev: pos!.lev, sl: 90, tp: 115, reason: 'sl', entry: 101, exit: 89.9 });
    const by = clock - Date.now() + HOUR;
    await backdate(bot.id, by);
    const opened = t!.opened_at - by;
    const closed = t!.closed_at - by;
    // The exchange has the same trade (opened a few seconds before the bot booked it), and one made by hand.
    closedHistory = [
      { id: 'c1', symbol: 'BTC/USDT:USDT', side: 'long', entryPrice: 101, lastPrice: 89.9, contracts: pos!.qty, contractSize: 1, leverage: pos!.lev, realizedPnl: -1.2, timestamp: opened - 5_000, lastUpdateTimestamp: closed + 2_000, info: {} },
      { id: 'c2', symbol: 'ETH/USDT:USDT', side: 'short', entryPrice: 2000, lastPrice: 1990, contracts: 1, contractSize: 0.01, leverage: 10, realizedPnl: 0.1, timestamp: opened - HOUR, lastUpdateTimestamp: opened - 30 * MIN, info: { type: 'CLOSE_SHORT' } },
    ];
    h = (await get(`/api/portfolio/${account}/history?period=30d&force=1`)).json() as TradeHistory;
    expect(h.rows.map((r) => r.key)).toEqual([expect.stringMatching(/^b\|/), 'a|ETH/USDT:USDT|c2']);
    expect(h.rows[0]).toMatchObject({ source: 'bot', open: false, symbol: 'BTC/USDT', sl: 90, tp: 115, exit: 89.9, reason: 'stop loss', openedAt: opened, closedAt: closed, market: 'futures' });
    expect(h.rows[0]?.pnl).toBeLessThan(0);
    expect(h.rows[0]?.pnlPct).toBeCloseTo(((h.rows[0]?.pnl as number) / ((pos!.qty * 101) / pos!.lev)) * 100, 6);
    // FIX-HISTAMOUNT: what it took from the account, without the leverage; the platform's ETH row from its leverage.
    expect(h.rows[0]?.margin).toBeCloseTo((pos!.qty * 101) / pos!.lev, 6);
    expect(h.rows[1]?.margin).toBeCloseTo((0.01 * 2000) / 10, 9);
    expect(h.rows[1]).toMatchObject({ source: 'account', bot: null, symbol: 'ETH/USDT', side: 'short', qty: 0.01, entry: 2000, exit: 1990, sl: null, tp: null, leverage: 10 });
    // Another account of the user has none of it.
    const other = await ctx.accounts.create(1, { exchange: 'kucoin', label: 'K2', credentials: { apiKey: 'k7654321', secret: 's7654321', password: 'p7654321' } });
    closedHistory = [];
    expect((await history(other.id)).rows).toEqual([]);
  });

  it("the platform's history unreadable, or none: the bots' trades all the same, and why", async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 5, dca: { ...dca, stopLoss: 10 } });
    await look();
    const deal = (await stateOf(bot.id)).dca?.deal;
    expect(deal).toBeTruthy();
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: deal!.qty, size: deal!.qty, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: 5, marginMode: 'cross', notional: 101 * deal!.qty }];
    closedHistory = Object.assign(new Error('kucoin GET https://api-futures.kucoin.com/api/v1/history-positions 429'), { name: 'RateLimitExceeded' });
    const h = await history(account);
    expect(h.error).not.toBeNull();
    // DCA's levels: the take profit from the average price, the stop loss from the base price.
    expect(h.rows).toEqual([expect.objectContaining({ source: 'bot', open: true, tp: expect.closeTo(101 * 1.02, 6), sl: expect.closeTo(101 * 0.9, 6), leverage: 5 })]);
    // The take profit: booked with the cycle's levels and leverage.
    px['BTC/USDT'] = 104;
    await look();
    positions = [];
    const [t] = await booked(bot.id);
    expect(t).toMatchObject({ account_id: account, market: 'futures', lev: 5, reason: 'tp' });
    expect(t?.tp).toBeCloseTo(101 * 1.02, 6);
    expect(t?.sl).toBeCloseTo(101 * 0.9, 6);
  });

  it('a grid on a Paper Trading profile: its trades on the profile, spot, leverage 1, the line it closed at, the stop under it; listed once', async () => {
    const bot = await make({ strategy: 'grid', ...common, grid: { ...grid, stopBelow: 85 } });
    await look();
    px['BTC/USDT'] = 105;
    await look();
    const rows = await booked(bot.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: paperCrypto, market: 'spot', lev: 1, sl: 85, tp: 105, reason: 'grid' });
    // The profile's own row of that sale is the bot's: the history lists it once, as the bot's.
    const ahead = clock - Date.now() + 1000;
    await backdate(bot.id, ahead);
    await ctx.db.run('UPDATE paper_trades SET opened_at = opened_at - ?, closed_at = closed_at - ? WHERE account_id = ?', [ahead, ahead, paperCrypto]);
    expect(await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM paper_trades WHERE account_id = ?', [paperCrypto])).toEqual({ n: 1 });
    const h = await history(paperCrypto);
    expect(h.rows.filter((r) => !r.open)).toEqual([expect.objectContaining({ source: 'bot', symbol: 'BTC/USDT', market: 'spot', entry: 101, exit: 105 })]);
  });

  it('a position closed outside the bot: booked with its levels', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 2, dca });
    await look();
    const qty = placed[0]?.amount as number;
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: qty, size: qty, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: 2, marginMode: 'cross', notional: 101 * qty }];
    await look(2 * MIN);
    positions = [];
    await look();
    const [t] = await booked(bot.id);
    expect(t).toMatchObject({ account_id: account, market: 'futures', lev: 2, sl: null, reason: 'external' });
    expect(t?.tp).toBeCloseTo(101 * 1.02, 6);
  });

  it('a platform without a history of closed positions (Binance): the bots\' trades only, and it says so', async () => {
    const binance = (await ctx.accounts.create(1, { exchange: 'binance', label: 'Binance', credentials: { apiKey: 'k1234567', secret: 's1234567' } })).id;
    const bot = await make({ strategy: 'grid', ...common, grid });
    await ctx.db.run('INSERT INTO bot_trades(bot_id, symbol, side, qty, entry, [exit], pnl, fees, opened_at, closed_at, reason, account_id, market, lev, sl, tp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      bot.id, 'BTC/USDT', 'long', 1, 100, 105, 4.8, 0.2, Date.now() - 3 * 86_400_000, Date.now() - 2 * 86_400_000, 'grid', binance, 'spot', 1, null, 105,
    ]);
    const h = await history(binance);
    expect(h).toMatchObject({ supported: false, error: null });
    expect(h.rows.map((r) => r.source)).toEqual(['bot']);
    // „Azi”: closed two days ago, not in it.
    expect((await history(binance, 'today')).rows).toEqual([]);
  });

  it("only the user's own accounts; a bot's trades stay with the account they were made on", async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'grid', ...common, grid });
    await ctx.db.run('INSERT INTO bot_trades(bot_id, symbol, side, qty, entry, [exit], pnl, fees, opened_at, closed_at, reason, account_id, market, lev, sl, tp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      bot.id, 'BTC/USDT', 'long', 1, 100, 105, 4.8, 0.2, Date.now() - 2 * HOUR, Date.now() - HOUR, 'grid', account, 'spot', 1, null, 105,
    ]);
    const h = await history(account);
    expect(h.rows).toEqual([expect.objectContaining({ source: 'bot', bot: { id: bot.id, name: 'Test' }, market: 'spot', leverage: 1, entry: 100, exit: 105, tp: 105, sl: null, reason: 'grilă', pnl: 4.8 })]);
    expect(h.rows[0]?.pnlPct).toBeCloseTo(4.8, 9);
    // FIX-HISTAMOUNT: a spot trade's amount is its cost.
    expect(h.rows[0]?.margin).toBeCloseTo(100, 9);
    // Somebody else's account: not found.
    await ctx.db.run("INSERT INTO users(email, name, password_hash, role, created_at) VALUES ('b@example.com', 'B', 'x', 'user', 1)");
    const uid = (await ctx.db.get<{ id: number }>("SELECT id FROM users WHERE email = 'b@example.com'"))!.id;
    const theirs = (await ctx.accounts.create(uid, { exchange: 'kucoin', label: 'Theirs', credentials: { apiKey: 'k1111111', secret: 's1111111', password: 'p1111111' } })).id;
    expect((await get(`/api/portfolio/${theirs}/history`)).statusCode).toBe(404);
    expect((await get(`/api/portfolio/${account}/history?period=1y`)).statusCode).toBe(400);
  });

  it('FIX-TRADESOLD: a position opened from Sentiq gets its leverage and the SL / TP in force at its exit, from the journal', async () => {
    const account = await kucoin();
    const t0 = Date.now() - 5 * HOUR;
    const log = (action: string, at: number, side: string | null, leverage: number | null, detail: unknown, status = 'sent') =>
      ctx.db.run(
        "INSERT INTO trade_log(user_id, account_id, exchange, env, account_label, action, market, symbol, side, kind, amount, leverage, status, detail, created_at, updated_at) VALUES (1, ?, N'kucoin', N'live', N'KuCoin', ?, N'futures', N'SOL/USDT:USDT', ?, N'market', 0.9, ?, ?, ?, ?, ?)",
        [account, action, side, leverage, status, JSON.stringify(detail), at, at],
      );
    const ticket = { market: 'futures', symbol: 'SOL/USDT:USDT', side: 'buy', kind: 'market', amount: 0.9, amountIn: 'base', leverage: 3, takeProfit: 109, stopLoss: 104.5 };
    await log('order', t0, 'buy', 3, { ticket, result: { status: 'sent', orderId: 'a', message: null, followUps: [] } });
    // The same form refused once before: not an order.
    await log('order', t0 - 30_000, 'buy', 3, { ticket: { ...ticket, leverage: 10, stopLoss: 1 } }, 'error');
    await log('modify', t0 + HOUR, null, null, {
      steps: [{ change: 0, how: 'place-then-cancel', orderId: 'x', side: 'sell', kind: 'sl', before: { triggerPrice: 104.5 }, after: { price: null, triggerPrice: 106, amount: 9, takeProfit: null, stopLoss: null }, removes: false }],
      result: { status: 'done', steps: [{ change: 0, what: 'ordin nou plasat', ok: true, orderId: 'y', message: null }] },
    });
    closedHistory = [{ id: 'k9', symbol: 'SOL/USDT:USDT', side: 'long', entryPrice: 105, lastPrice: 106, leverage: 0, realizedPnl: 0.8, info: { openTime: t0 + 4_000, closeTime: t0 + 2 * HOUR }, lastUpdateTimestamp: t0 + 2 * HOUR }];
    const h = await history(account);
    expect(h.rows).toEqual([expect.objectContaining({ key: 'a|SOL/USDT:USDT|k9', source: 'account', leverage: 3, sl: 106, tp: 109, fromJournal: ['leverage', 'sl', 'tp'], market: 'futures' })]);
    // Without the journal, the platform's row as it is.
    await ctx.db.run('DELETE FROM trade_log');
    expect((await get(`/api/portfolio/${account}/history?period=30d&force=1`)).json().rows[0]).toMatchObject({ leverage: null, sl: null, tp: null });
  });

  it('migration 11 gives the trades before it their account, market and a Slingshot entry\'s levels', async () => {
    const account = await kucoin();
    const real = await make({ strategy: 'premium', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 3, premium });
    // A simulation (before FD-PAPER): no account.
    const paper = await make({ strategy: 'dca', ...common, dca });
    await ctx.db.run("UPDATE bots SET execution = N'paper', account_id = NULL WHERE id = ?", [paper.id]);
    const insert = (botId: number, openedAt: number) =>
      ctx.db.run('INSERT INTO bot_trades(bot_id, symbol, side, qty, entry, [exit], pnl, fees, opened_at, closed_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [botId, 'BTC/USDT', 'long', 1, 100, 110, 9, 1, openedAt, openedAt + HOUR, 'tp']);
    await insert(real.id, 1000);
    await insert(real.id, 2000);
    await insert(paper.id, 3000);
    await ctx.db.run("INSERT INTO bot_events(bot_id, at, kind, symbol, message, detail) VALUES (?, 1000, N'enter', N'BTC/USDT', N'LONG', ?)", [real.id, JSON.stringify({ side: 'long', price: 100, sl: 95.5, tp: 112.25, leverage: 3 })]);
    // Not JSON: left alone.
    await ctx.db.run("INSERT INTO bot_events(bot_id, at, kind, symbol, message, detail) VALUES (?, 2000, N'enter', N'BTC/USDT', N'LONG', N'not json')", [real.id]);
    for (const batch of (MIGRATIONS[10] as string[]).slice(1)) await ctx.db.run(batch.replace(/^CREATE INDEX bot_trades_account ON bot_trades\(account_id, closed_at\);/, ''));
    const rows = await ctx.db.all<{ bot_id: number; account_id: number | null; market: string; lev: number | null; sl: number | null; tp: number | null }>('SELECT bot_id, account_id, market, lev, sl, tp FROM bot_trades ORDER BY opened_at');
    expect(rows).toEqual([
      { bot_id: real.id, account_id: account, market: 'futures', lev: 3, sl: 95.5, tp: 112.25 },
      { bot_id: real.id, account_id: account, market: 'futures', lev: null, sl: null, tp: null },
      { bot_id: paper.id, account_id: null, market: 'spot', lev: null, sl: null, tp: null },
    ]);
  });
});

describe('FIX-BOTLEVELS: the levels a real bot keeps for its positions (the chart draws them)', () => {
  const kucoin = async () => {
    const id = (await ctx.accounts.create(1, { exchange: 'kucoin', label: 'KuCoin', credentials: { apiKey: 'k1234567', secret: 's1234567', password: 'p1234567' } })).id;
    await ctx.accounts.setTrading(id, ['spot', 'futures']);
    return id;
  };
  const stateOf = async (id: number) => JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [id]))!.state) as BotState;
  const levels = async () => {
    const r = await get('/api/bots/levels');
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as BotLevel[];
  };
  const status = (id: number, s: string) => ctx.db.run('UPDATE bots SET status = ? WHERE id = ?', [s, id]);

  it('a real Slingshot position: its SL / TP on its account; a pause keeps them, a problem marks them inactive, the end takes them away', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'premium', ...common, name: 'Crypto', exec: 'real', accountId: account, market: 'futures', leverage: 3, premium });
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
    expect(await levels()).toEqual([]);
    barSpec = { signals: [{}] };
    await look(HOUR);
    const pos = (await stateOf(bot.id)).premium?.positions[0];
    expect(pos).toBeTruthy();
    expect(await levels()).toEqual([{ bot: { id: bot.id, name: 'Crypto' }, accountId: account, active: true, market: 'futures', symbol: 'BTC/USDT', side: 'long', qty: pos!.qty, entry: 101, sl: 90, tp: 115, openedAt: pos!.openedAt }]);
    // Paused: it still closes at them. A problem: it sends nothing until "Reia".
    await status(bot.id, 'paused');
    expect((await levels())[0]?.active).toBe(true);
    await status(bot.id, 'problem');
    expect((await levels())[0]?.active).toBe(false);
    // Ended (its positions left open): no longer the bot's.
    await status(bot.id, 'ended');
    expect(await levels()).toEqual([]);
    // Somebody else's bots: none of them.
    expect(await ctx.bots.levels(2)).toEqual([]);
  });

  it('a DCA cycle: its levels, on a Paper Trading profile too; a grid: the stop on the side it holds, no take profit', async () => {
    const account = await kucoin();
    // The profile's first: the fake platform checks the newest bot's key.
    const paper = await make({ strategy: 'dca', ...common, name: 'Paper', dca: { ...dca, stopLoss: 10 } });
    const real = await make({ strategy: 'dca', ...common, name: 'DCA', exec: 'real', accountId: account, market: 'futures', leverage: 5, dca: { ...dca, stopLoss: 10 } });
    await look();
    expect((await stateOf(paper.id)).dca?.deal).toBeTruthy();
    const deal = (await stateOf(real.id)).dca?.deal;
    expect(deal).toBeTruthy();
    const got = await levels();
    expect(got).toHaveLength(2);
    expect(got).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bot: { id: real.id, name: 'DCA' }, accountId: account, market: 'futures', side: 'long', qty: deal!.qty, tp: expect.closeTo(101 * 1.02, 6), sl: expect.closeTo(101 * 0.9, 6) }),
        expect.objectContaining({ bot: { id: paper.id, name: 'Paper' }, accountId: paperCrypto, market: 'spot', side: 'long', tp: expect.closeTo(101 * 1.02, 6), sl: expect.closeTo(101 * 0.9, 6) }),
      ]),
    );
    // The history's open row has the same levels.
    const mine = got.find((l) => l.bot.id === real.id);
    expect(await ctx.bots.accountTrades(1, account, 'kucoin', 0)).toEqual([expect.objectContaining({ open: true, tp: mine?.tp, sl: mine?.sl })]);
    await status(real.id, 'ended');
    await status(paper.id, 'ended');
    const g = await make({ strategy: 'grid', ...common, name: 'Grid', exec: 'real', accountId: account, market: 'futures', leverage: 2, grid: { ...grid, stopBelow: 85 } });
    await look();
    const slots = (await stateOf(g.id)).grid?.slots.filter((s) => s.entry !== null) ?? [];
    expect(slots.length).toBeGreaterThan(0);
    expect(await levels()).toEqual([expect.objectContaining({ bot: { id: g.id, name: 'Grid' }, side: 'long', sl: 85, tp: null })]);
    // A grid without a stop: nothing to draw.
    await ctx.db.run('UPDATE bots SET config = REPLACE(config, ?, ?) WHERE id = ?', ['"stopBelow":85', '"stopBelow":null', g.id]);
    expect(await levels()).toEqual([]);
  });
});

describe('FIX-BOTDRAG: a bot’s stop loss / take profit dragged on the chart', () => {
  const kucoin = async () => {
    const id = (await ctx.accounts.create(1, { exchange: 'kucoin', label: 'KuCoin', credentials: { apiKey: 'k1234567', secret: 's1234567', password: 'p1234567' } })).id;
    await ctx.accounts.setTrading(id, ['spot', 'futures']);
    return id;
  };
  const stateOf = async (id: number) => JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [id]))!.state) as BotState;
  const commandOf = async (id: number) => (await ctx.db.get<{ command: string | null }>('SELECT command FROM bots WHERE id = ?', [id]))?.command ?? null;
  const levels = async () => (await get('/api/bots/levels')).json() as BotLevel[];
  const move = (id: number, body: unknown) => post(`/api/bots/${id}/levels`, body);
  const journal = async (id: number) => (await ctx.db.all<{ message: string }>('SELECT message FROM bot_events WHERE bot_id = ? ORDER BY id', [id])).map((e) => e.message);

  it('a Slingshot position: shown at once, applied at the next look, fired there; refused across the price, for another position, an ended bot', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'premium', ...common, name: 'Crypto', exec: 'real', accountId: account, market: 'futures', leverage: 3, premium });
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
    barSpec = { signals: [{}] };
    await look(HOUR);
    const pos = (await stateOf(bot.id)).premium?.positions[0];
    expect(pos).toMatchObject({ sl: 90, tp: 115 });
    const at = { symbol: 'BTC/USDT', side: 'long', openedAt: pos!.openedAt };
    barSpec = { signals: [] };
    // The platform holds it (else the reconciling, a minute on, takes it as closed by hand).
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 100, size: 100, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: 3, marginMode: 'cross', notional: 10_100 }];

    // Across the price (101): refused, nothing written.
    let r = await move(bot.id, { ...at, sl: 102 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain('Stop loss-ul unui long trebuie să fie sub prețul curent');
    r = await move(bot.id, { ...at, tp: 100 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain('Take profit-ul unui long trebuie să fie peste prețul curent');
    expect((await move(bot.id, at)).statusCode).toBe(400);
    // Another position (another opening, the other side): closed meanwhile.
    expect((await move(bot.id, { ...at, openedAt: pos!.openedAt + 1, sl: 95 })).statusCode).toBe(409);
    expect((await move(bot.id, { ...at, side: 'short', sl: 105 })).statusCode).toBe(409);
    // Somebody else's bot: not found.
    await expect(ctx.bots.moveLevel(2, bot.id, { ...at, side: 'long', sl: 95 })).rejects.toThrow();
    expect(await commandOf(bot.id)).toBeNull();

    // The stop loss, then the take profit: both wait for the engine, the chart and the bot's window have them at once.
    r = await move(bot.id, { ...at, sl: 95 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual([expect.objectContaining({ bot: { id: bot.id, name: 'Crypto' }, sl: 95, tp: 115 })]);
    expect((await move(bot.id, { ...at, tp: 120 })).statusCode).toBe(200);
    expect(await levels()).toEqual([expect.objectContaining({ sl: 95, tp: 120 })]);
    expect((await detail(bot.id)).positions[0]).toMatchObject({ sl: 95, tp: 120 });
    expect(JSON.parse((await commandOf(bot.id)) ?? '{}')).toEqual({ levels: [{ ...at, sl: 95, tp: 120 }] });
    expect((await stateOf(bot.id)).premium?.positions[0]).toMatchObject({ sl: 90, tp: 115 });
    expect((await journal(bot.id)).slice(-2)).toEqual(['Mutat de pe grafic: SL BTC/USDT long 90 → 95.', 'Mutat de pe grafic: TP BTC/USDT long 115 → 120.']);

    // The next look: the position has them, the command is read.
    await look();
    expect((await stateOf(bot.id)).premium?.positions[0]).toMatchObject({ sl: 95, tp: 120 });
    expect(await commandOf(bot.id)).toBeNull();
    expect(await levels()).toEqual([expect.objectContaining({ sl: 95, tp: 120 })]);
    // It closes at the new stop loss (the old one, 90, is not reached).
    px['BTC/USDT'] = 94.9;
    await look();
    expect((await stateOf(bot.id)).premium?.positions).toEqual([]);
    expect((await detail(bot.id)).history[0]).toMatchObject({ reason: 'sl' });
    expect(await levels()).toEqual([]);
    expect((await move(bot.id, { ...at, sl: 90 })).statusCode).toBe(409);
    await ctx.db.run("UPDATE bots SET status = N'ended' WHERE id = ?", [bot.id]);
    expect((await move(bot.id, { ...at, sl: 90 })).statusCode).toBe(409);
  });

  it('a DCA cycle keeps the levels moved after a safety order; a grid’s stop is its setting', async () => {
    const account = await kucoin();
    const real = await make({ strategy: 'dca', ...common, name: 'DCA', exec: 'real', accountId: account, market: 'futures', leverage: 5, dca: { ...dca, stopLoss: 10 } });
    await look();
    const deal = (await stateOf(real.id)).dca?.deal;
    expect(deal).toBeTruthy();
    // The platform holds the cycle (else the reconciling, a minute on, takes it as closed by hand).
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 100, size: 100, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: 5, marginMode: 'cross', notional: 10_100 }];
    const at = { symbol: 'BTC/USDT', side: 'long', openedAt: deal!.openedAt };
    expect((await move(real.id, { ...at, sl: 92, tp: 104 })).statusCode).toBe(200);
    expect(await levels()).toEqual([expect.objectContaining({ sl: 92, tp: 104 })]);
    await look();
    expect((await stateOf(real.id)).dca?.deal).toMatchObject({ sl: 92, tp: 104 });
    // A safety order (2 % under 101): the take profit no longer follows the average.
    px['BTC/USDT'] = 98.9;
    await look();
    expect((await stateOf(real.id)).dca?.deal?.filled).toBe(1);
    expect(await levels()).toEqual([expect.objectContaining({ sl: 92, tp: 104 })]);
    expect((await detail(real.id)).dca?.deal).toMatchObject({ sl: 92, tp: 104 });
    // Its stop loss fires there; the next cycle has the settings' levels again.
    px['BTC/USDT'] = 91.9;
    await look();
    expect((await detail(real.id)).history[0]).toMatchObject({ reason: 'sl' });
    await ctx.db.run("UPDATE bots SET status = N'ended' WHERE id = ?", [real.id]);
    positions = [];

    const g = await make({ strategy: 'grid', ...common, name: 'Grid', exec: 'real', accountId: account, market: 'futures', leverage: 2, grid: { ...grid, stopBelow: 85 } });
    px['BTC/USDT'] = 101;
    await look();
    const gat = { symbol: 'BTC/USDT', side: 'long', openedAt: 0 };
    // In the grid: the form's rule; a take profit: none on a grid.
    let r = await move(g.id, { ...gat, sl: 95 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain('„Oprește sub” trebuie să fie sub limita de jos.');
    r = await move(g.id, { ...gat, tp: 120 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain('O grilă nu are take profit');
    r = await move(g.id, { ...gat, sl: 80 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual([expect.objectContaining({ bot: { id: g.id, name: 'Grid' }, sl: 80, tp: null })]);
    expect((await detail(g.id)).input).toMatchObject({ grid: { stopBelow: 80 } });
    expect(await commandOf(g.id)).toBeNull();
    expect((await journal(g.id)).at(-1)).toBe('Mutat de pe grafic: „Oprește sub” BTC/USDT long 85 → 80.');
  });
});

describe('FIX-BOTMARGIN: a futures bot’s margin, Isolated unless Cross is chosen', () => {
  const kucoin = async () => {
    const id = (await ctx.accounts.create(1, { exchange: 'kucoin', label: 'KuCoin', credentials: { apiKey: 'k1234567', secret: 's1234567', password: 'p1234567' } })).id;
    await ctx.accounts.setTrading(id, ['spot', 'futures']);
    return id;
  };
  const stateOf = async (id: number) => JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [id]))!.state) as BotState;
  /** The state as a bot from before FIX-BOTMARGIN has it (and its settings: none of the margin). */
  const fromBefore = async (id: number, strip: (st: BotState) => void) => {
    const row = (await ctx.db.get<{ state: string; config: string }>('SELECT state, config FROM bots WHERE id = ?', [id]))!;
    const st = JSON.parse(row.state) as BotState;
    strip(st);
    if (st.basis) delete (st.basis as Partial<BotInput>).marginMode;
    const config = JSON.parse(row.config) as Partial<BotInput>;
    delete config.marginMode;
    await ctx.db.run('UPDATE bots SET state = ?, config = ? WHERE id = ?', [JSON.stringify(st), JSON.stringify(config), id]);
  };
  // The platform holds what the bot opened (else the reconciling, a minute on, takes it as closed by hand).
  const held = (lev: number) => [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 100, size: 100, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: lev, marginMode: null, notional: 10_100 }] as Portfolio['positions'];
  const edit = async (id: number, input: unknown) => {
    const r = await put(`/api/bots/${id}`, { input });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as BotDetail;
  };
  const check = async (body: unknown) => {
    const r = await post('/api/bots/check', body);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as BotCheck;
  };

  it('a DCA bot: Isolated by default on every order of its cycle, sent again with it; Cross in the settings waits for the next cycle', async () => {
    const account = await kucoin();
    const body = { strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 5, dca };
    const c = await check(body);
    expect(c.errors).toEqual([]);
    expect(c.summary).toContain('Marja: Isolated (fiecare poziție își riscă doar marja ei).');
    const bot = await make(body);
    expect(bot.input.marginMode).toBe('isolated');
    // The network cuts the base order: the next look sends it again with the same key and margin.
    placeError = new Error('socket hang up');
    await look();
    expect((await stateOf(bot.id)).pending).toMatchObject({ mm: 'isolated' });
    await look();
    expect(placed).toMatchObject([{ side: 'buy', leverage: 5, marginMode: 'isolated' }]);
    expect(placed[0]).not.toHaveProperty('reduceOnly');
    expect((await stateOf(bot.id)).dca?.deal).toMatchObject({ mm: 'isolated', lev: 5 });
    positions = held(5);

    // Cross from now on: the open cycle keeps Isolated, its safety order and its take profit.
    const next = await edit(bot.id, { ...bot.input, marginMode: 'cross' });
    expect(next.input.marginMode).toBe('cross');
    px['BTC/USDT'] = 98.9;
    await look();
    expect(placed).toHaveLength(2);
    expect(placed[1]).toMatchObject({ side: 'buy', marginMode: 'isolated' });
    px['BTC/USDT'] = 103;
    await look();
    expect(placed).toHaveLength(3);
    expect(placed[2]).toMatchObject({ side: 'sell', reduceOnly: true, marginMode: 'isolated' });
    expect((await detail(bot.id)).history[0]).toMatchObject({ reason: 'tp' });
    // The next cycle: Cross.
    positions = [];
    await look();
    expect(placed).toHaveLength(4);
    expect(placed[3]).toMatchObject({ side: 'buy', marginMode: 'cross', leverage: 5 });
    expect((await stateOf(bot.id)).dca?.deal).toMatchObject({ mm: 'cross' });
  });

  it('Slingshot: Cross chosen opens Cross and closes with it; a position and settings from before follow the pair, then Isolated', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'premium', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 3, marginMode: 'cross', premium });
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
    barSpec = { signals: [{}] };
    await look(HOUR);
    expect(placed).toMatchObject([{ side: 'buy', marginMode: 'cross' }]);
    expect((await stateOf(bot.id)).premium?.positions[0]).toMatchObject({ mm: 'cross' });
    barSpec = { signals: [] };
    positions = held(3);
    // Isolated in the settings: the open position stays Cross (its stop loss closes it with Cross).
    await edit(bot.id, { ...bot.input, marginMode: 'isolated' });
    px['BTC/USDT'] = 89.9;
    await look();
    expect(placed).toHaveLength(2);
    expect(placed[1]).toMatchObject({ side: 'sell', reduceOnly: true, marginMode: 'cross' });
    positions = [];

    // A bot saved before FIX-BOTMARGIN, with a position it opened then: the settings read Isolated, the position closes
    // with the pair's margin (none named), the next one opens Isolated.
    px['BTC/USDT'] = 101;
    barSpec = { signals: [{}] };
    await look(HOUR);
    expect(placed).toHaveLength(3);
    positions = held(3);
    await fromBefore(bot.id, (st) => st.premium?.positions.forEach((p) => delete p.mm));
    expect((await detail(bot.id)).input.marginMode).toBe('isolated');
    barSpec = { signals: [] };
    px['BTC/USDT'] = 89.9;
    await look();
    expect(placed).toHaveLength(4);
    expect(placed[3]).toMatchObject({ side: 'sell', reduceOnly: true });
    expect(placed[3]).not.toHaveProperty('marginMode');
    positions = [];
    px['BTC/USDT'] = 101;
    barSpec = { signals: [{}] };
    await look(HOUR);
    expect(placed).toHaveLength(5);
    expect(placed[4]).toMatchObject({ side: 'buy', marginMode: 'isolated' });
  });

  it('a grid: every order with its margin, another one makes it again; a grid from before follows the pair', async () => {
    const account = await kucoin();
    const g = await make({ strategy: 'grid', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 2, grid });
    await look();
    expect(placed).toMatchObject([{ side: 'buy', marginMode: 'isolated' }]);
    expect((await stateOf(g.id)).grid).toMatchObject({ mm: 'isolated' });
    positions = held(2);
    const why = 'grila: limitele, grilele, spațierea, direcția, prețul de pornire, suma, levierul sau marja';
    const r = await post(`/api/bots/${g.id}/check`, { input: { ...g.input, marginMode: 'cross' } });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as BotCheck).transition?.changes).toEqual([why]);
    // The price falls to the next line: a grid from before (no margin kept) names none.
    await fromBefore(g.id, (st) => delete st.grid?.mm);
    px['BTC/USDT'] = 94.9;
    await look();
    expect(placed).toHaveLength(2);
    expect(placed[1]).toMatchObject({ side: 'buy' });
    expect(placed[1]).not.toHaveProperty('marginMode');
  });

  it('the check: Cross only on a unified account, the account’s own on Bybit, futures only, a Paper Trading profile', async () => {
    const account = await kucoin();
    const body = { strategy: 'dca', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 5, dca };
    marginModes = ['cross'];
    let c = await check(body);
    expect(c.errors).toContain('Pe KuCoin, contul acesta ia din Sentiq ordine futures doar cu marjă Cross: alege „Cross” la „Marja”.');
    c = await check({ ...body, marginMode: 'cross' });
    expect(c.errors).toEqual([]);
    expect(c.summary).toContain('Marja: Cross (pozițiile folosesc tot soldul futures al contului).');
    marginModes = null;
    c = await check(body);
    expect(c.errors).toEqual([]);
    expect(c.warnings).toContain('Pe KuCoin, marja e cea aleasă în contul KuCoin: botul nu o schimbă.');
    expect(c.summary.some((x) => x.startsWith('Marja:'))).toBe(false);
    // Off futures there is no margin to choose (on a real account: FIX-PAPERLEV).
    expect((await check({ ...body, market: 'spot', leverage: 1, marginMode: 'cross' })).errors).toContain('Marja se alege doar pe futures (pe spot și pe acțiuni, doar pe un profil Paper Trading).');
    c = await check({ ...body, market: 'spot', leverage: 1 });
    expect(c.summary.some((x) => x.startsWith('Marja:'))).toBe(false);
    c = await check({ strategy: 'dca', ...common, market: 'futures', leverage: 5, dca });
    expect(c.summary).toContain('Marja: Isolated (fiecare poziție își riscă doar marja ei).');
  });
});

describe('FIX-BOTBUDGET: the budget, the most a trade takes, shared among the trades to open; none too small', () => {
  const firstBar = async () => {
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
  };
  const nextBar = async (spec: NonNullable<typeof barSpec>) => {
    barSpec = spec;
    await look(HOUR);
  };
  // The settings as saved after FIX-BOTBUDGET: one maximum a trade.
  const { sizing: _s, amount: _a, riskPct: _r, ...budgeted } = premium;
  // Read at each test: the profile is made before it.
  const two = () => ({ strategy: 'premium', ...common, market: 'futures', leverage: 3, maxAmount: 500, symbols: ['BTC/USDT', 'SOL/USDT'] });

  it('two signals at once: the budget shared (250 each, not 450 and the rest); the summary says the budget and the maximum', async () => {
    px['SOL/USDT'] = 101;
    const r = await post('/api/bots/check', { ...two(), premium: { ...budgeted, maxPerTrade: 450, maxOpen: 10 } });
    expect(r.statusCode, r.body).toBe(200);
    const check = r.json() as BotCheck;
    // „Tranzacții deschise odată” above the symbols is saved: two in effect.
    expect(check.errors).toEqual([]);
    expect(check.summary.some((x) => x.startsWith('Bugetul: 500 USDT; pe tranzacție cel mult 450 USDT (poziția până la 1.350 USDT, la 3×); cel mult 2 tranzacții deschise odată (câte simboluri are botul).'))).toBe(true);
    // 10 / 1.350 + 2 × 0,1% of commissions: the take profit at least 0,94% away.
    expect(check.summary).toContain('Ca o tranzacție să aducă 10 USD, take profit-ul semnalului trebuie să fie la cel puțin 0,94% de la intrare (cu suma maximă pe tranzacție); la unul mai aproape, botul nu intră.');
    // „Risc / câștig” with a take profit too close for it: said before the start.
    const close = (await post('/api/bots/check', { ...two(), premium: { ...budgeted, maxPerTrade: 100, levels: 'percent', slPct: 1, tpPct: 2 }, leverage: 1 })).json() as BotCheck;
    expect(close.warnings).toContain('Cu suma maximă pe tranzacție (100 USDT), take profit-ul de 2% aduce cel mult 1,8 USDT după comisioane: sub 10 USD, deci botul nu intră.');
    const bot = await make({ ...two(), premium: { ...budgeted, maxPerTrade: 450, maxOpen: 10 } });
    await firstBar();
    await nextBar({ signals: [{}] });
    const d = await detail(bot.id);
    expect(d.positions.map((p) => [p.symbol, p.margin])).toEqual([
      ['BTC/USDT', expect.closeTo(250, 4)],
      ['SOL/USDT', expect.closeTo(250, 4)],
    ]);
    const enters = d.events.filter((e) => e.kind === 'enter').map((e) => e.message);
    expect(enters.every((m) => / Suma: 250,00 USDT, poziția 750,00 USDT\./.test(m))).toBe(true);
  });

  it('what the account has left is not a trade when it would bring under 10 at the take profit', async () => {
    px['SOL/USDT'] = 101;
    // A profile of 300: the first takes 250 of the bot's 500, the account has ~49 left; at a take profit 3% away (×3),
    // a trade needs ~120 to bring 10.
    const small = await ctx.paper.create(1, { label: 'Paper 300', kind: 'crypto', budget: 300, commissionType: 'percent', commissionValue: 0.1 }, 20);
    const bot = await make({ ...two(), accountId: small, premium: { ...budgeted, maxPerTrade: 450, maxOpen: 2 } });
    await firstBar();
    await nextBar({ signals: [{ tp: 104 }] });
    const d = await detail(bot.id);
    expect(d.positions).toHaveLength(1);
    expect(d.positions[0]?.margin).toBeCloseTo(250, 4);
    expect(d.events.some((e) => /^LONG: în cont sunt disponibili doar [\d,]+ USDT: prea puțin pentru o tranzacție care să aducă cel puțin 10 USD la take profit\.$/.test(e.message))).toBe(true);
  });

  it('with „AI confirmă” the AI chooses the amount within the bounds; it is asked with them', async () => {
    const bot = await make({ strategy: 'premium', ...common, market: 'futures', leverage: 3, maxAmount: 500, premium: { ...budgeted, maxPerTrade: 450, ai: 'confirm' } });
    aiAnswer = { decision: 'enter', confidence: 80, reason: 'Semnal curat.', risks: [], amount: 300 };
    await firstBar();
    await nextBar({ signals: [{}] });
    const d = await detail(bot.id);
    expect(d.positions[0]?.margin).toBeCloseTo(300, 4);
    expect(d.events.find((e) => e.kind === 'enter')?.message).toMatch(/ Suma: 300,00 USDT, poziția 900,00 USDT\. Suma aleasă de AI\.$/);
    expect(aiAsked.at(-1)?.prompt).toMatch(/Suma tranzacției \(marja, fără levier; poziția = suma × 3\): între [\d.]+ și 450\.00 USDT\. Propunerea botului: 450\.00 USDT \(bugetul liber 500\.00 USDT, împărțit la 1 tranzacție care se mai poate deschide\)\./);
    // An amount out of the bounds is brought within them.
    const other = await make({ strategy: 'premium', ...common, accountId: await paperProfile('Paper 2'), market: 'futures', leverage: 3, maxAmount: 500, premium: { ...budgeted, maxPerTrade: 450, ai: 'confirm' } });
    // Its first look notes the bar.
    barSpec = { signals: [] };
    await look(1);
    aiAnswer = { decision: 'enter', confidence: 90, reason: 'Semnal foarte curat.', risks: [], amount: 5000 };
    await nextBar({ signals: [{ time: 9100 }] });
    expect((await detail(other.id)).positions[0]?.margin).toBeCloseTo(450, 4);
  });
});

describe('FIX-PAPERLEV: on a Paper Trading profile every market has leverage, margin and shorts', () => {
  const firstBar = async () => {
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
  };
  const nextBar = async (spec: NonNullable<typeof barSpec>) => {
    barSpec = spec;
    await look(HOUR);
  };
  const check = async (body: unknown) => (await post('/api/bots/check', body)).json() as BotCheck;

  it('a real account: no leverage, margin or short on spot (the check says why); a profile: all three', async () => {
    const account = (await ctx.accounts.create(1, { exchange: 'kucoin', label: 'KuCoin', credentials: { apiKey: 'k1234567', secret: 's1234567', password: 'p1234567' } })).id;
    await ctx.accounts.setTrading(account, ['spot', 'futures']);
    const real = { strategy: 'premium', ...common, accountId: account, premium };
    expect((await check({ ...real, leverage: 3 })).errors).toContain('Levierul se aplică doar pe futures (pe spot și pe acțiuni, doar pe un profil Paper Trading).');
    expect((await check({ ...real, premium: { ...premium, direction: 'both' } })).errors).toContain('Pe spot nu se poate short: doar Long (short pe futures, pe acțiuni sau pe un profil Paper Trading).');
    const c = await check({ strategy: 'premium', ...common, leverage: 5, marginMode: 'cross', premium: { ...premium, direction: 'both' } });
    expect(c.errors).toEqual([]);
    expect(c.summary).toContain('Marja: Cross (pozițiile folosesc toți banii profilului).');
    expect(c.summary.some((x) => x.startsWith('Bugetul: 1.000 USDT; pe tranzacție cel mult 100 USDT (poziția până la 500 USDT, la 5×)'))).toBe(true);
  });

  it('spot: a short at 5× with its margin, Cross, on the profile; closed reduce-only at its stop loss', async () => {
    const bot = await make({ strategy: 'premium', ...common, leverage: 5, marginMode: 'cross', premium: { ...premium, direction: 'both' } });
    await firstBar();
    await nextBar({ signals: [{ side: 'short', entry: 105, sl: 110, tp: 90 }] });
    let d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ symbol: 'BTC/USDT', side: 'short', leverage: 5, margin: expect.closeTo(100, 4) });
    expect((await ctx.accounts.portfolio(paperCrypto)).positions).toMatchObject([{ symbol: 'BTC/USDT', side: 'short', leverage: 5, marginMode: 'cross', size: expect.closeTo(500 / 101, 6) }]);
    px['BTC/USDT'] = 110.5;
    await look();
    d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.history[0]).toMatchObject({ reason: 'sl', side: 'short' });
    expect((await ctx.accounts.portfolio(paperCrypto)).positions).toEqual([]);
  });

  it('shares: a DCA cycle at 2× on the profile, its margin half the value', async () => {
    px.AAPL = 200;
    const bot = await make({ strategy: 'dca', ...common, accountId: paperStocks, market: 'stock', symbols: ['AAPL'], leverage: 2, dca });
    await look();
    const d = await detail(bot.id);
    expect(d.dca?.deal).toMatchObject({ basePrice: 200 });
    expect((await ctx.accounts.portfolio(paperStocks)).positions).toMatchObject([{ symbol: 'AAPL/USD', side: 'long', leverage: 2, size: expect.closeTo(1, 6) }]);
    expect(d.positions[0]).toMatchObject({ symbol: 'AAPL', leverage: 2, margin: expect.closeTo(100, 4) });
  });
});

describe('FIX-BOTSHORTS: the entry at the setup, its levels at the confirmation, the money there is', () => {
  const firstBar = async () => {
    clock = Math.ceil(clock / HOUR) * HOUR + 10 * MIN;
    barSpec = { signals: [] };
    await look(1);
  };
  const nextBar = async (spec: NonNullable<typeof barSpec>) => {
    barSpec = spec;
    await look(HOUR);
  };
  const stateOf = async (id: number) => JSON.parse((await ctx.db.get<{ state: string }>('SELECT state FROM bots WHERE id = ?', [id]))!.state) as BotState;
  const msgs = async (id: number) => (await detail(id)).events.map((e) => e.message);
  const kucoin = async () => {
    const id = (await ctx.accounts.create(1, { exchange: 'kucoin', label: 'KuCoin', credentials: { apiKey: 'k1234567', secret: 's1234567', password: 'p1234567' } })).id;
    await ctx.accounts.setTrading(id, ['spot', 'futures']);
    return id;
  };

  it('enters at the close of the first bar with the setup forming, with its levels; follows its V2; the confirmation brings the signal’s levels, then the signal is followed', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    await nextBar({ signals: [], setups: [{}] });
    let st = await stateOf(bot.id);
    expect(st.premium?.positions[0]).toMatchObject({ side: 'long', entry: 101, sl: 90, tp: 112, signalTime: 9000, setup: { start: 9000, sl: 90, tp: 112 } });
    expect((await detail(bot.id)).events.find((e) => e.kind === 'enter')?.message).toMatch(
      /^LONG la 101: SL 90, TP 112, scor [\d,]+\. Intrare la setup \(semnalul încă în formare\): stop loss-ul e la minimul V1, unde Slingshot anulează setup-ul; la confirmare, SL \/ TP-ul se mută la cele ale semnalului\. Suma: 100,00 USDT\.$/,
    );
    // Its V2 moves (a lower low): followed; the levels stay until the confirmation.
    await nextBar({ signals: [], setups: [{ v2Bar: 10, v2Time: 10_000, entry: 95, sl: 91 }] });
    st = await stateOf(bot.id);
    expect(st.premium?.positions[0]).toMatchObject({ sl: 90, tp: 112, signalTime: 10_000, setup: { start: 9000 } });
    // Confirmed: the signal's levels, no entry tried on it.
    await nextBar({ signals: [{ bar: 10, time: 10_000, sl: 91, tp: 113 }] });
    st = await stateOf(bot.id);
    expect(st.premium?.positions).toHaveLength(1);
    expect(st.premium?.positions[0]).toMatchObject({ sl: 91, tp: 113, signalTime: 10_000 });
    expect(st.premium?.positions[0]?.setup).toBeUndefined();
    const m = await msgs(bot.id);
    expect(m).toContain('Semnalul LONG s-a confirmat: SL 90 → 91, TP 112 → 113.');
    expect(m.some((x) => x.includes('botul are deja o poziție'))).toBe(false);
    // Then what Slingshot does with the signal.
    await nextBar({ signals: [{ bar: 10, time: 10_000, confirmBar: 8, sl: 91, tp: 113, outcome: 'sl', outcomeReason: 'stopLoss', closedBar: 10 }] });
    expect((await detail(bot.id)).history[0]).toMatchObject({ reason: 'sl' });
  });

  it('a setup ended without a signal closes with "Ieși când trendul se întoarce"; a new one enters; a confirmed take profit already passed closes at once', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    await nextBar({ signals: [], setups: [{}] });
    await nextBar({ signals: [] });
    let d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.history[0]).toMatchObject({ reason: 'flip' });
    expect(d.events.some((e) => /^Setup-ul LONG nu s-a confirmat \(s-a anulat\)\. Poziția long închisă la 101 cu /.test(e.message))).toBe(true);
    await nextBar({ signals: [], setups: [{ startTime: 9500, v2Time: 9500 }] });
    expect((await stateOf(bot.id)).premium?.positions[0]).toMatchObject({ setup: { start: 9500 } });
    await nextBar({ signals: [{ bar: 10, time: 10_000, sl: 91, tp: 100.5 }] });
    d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.history[0]).toMatchObject({ reason: 'tp' });
    expect(d.events.some((e) => /^Prețul a trecut deja de take profit-ul semnalului \(100,5\)\./.test(e.message))).toBe(true);
  });

  it('without "Ieși când trendul se întoarce" a cancelled setup keeps the position with its levels; "Risc / câștig" keeps its percents at the confirmation', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium: { ...premium, exitOnFlip: false } });
    await firstBar();
    await nextBar({ signals: [], setups: [{}] });
    await nextBar({ signals: [] });
    const st = await stateOf(bot.id);
    expect(st.premium?.positions[0]).toMatchObject({ sl: 90, tp: 112 });
    expect(st.premium?.positions[0]?.setup).toBeUndefined();
    expect(await msgs(bot.id)).toContain('Setup-ul LONG nu s-a confirmat (s-a anulat): poziția rămâne cu SL / TP-ul ei.');
    // Nothing of it later.
    await nextBar({ signals: [{ time: 9000, outcome: 'invalidated', outcomeReason: 'trendFlip', closedBar: 10, confirmBar: 9 }] });
    expect((await detail(bot.id)).positions).toHaveLength(1);

    // FIX-BOTBUDGET: 1.000 a trade, so a take profit 2% away brings at least 10 there.
    const pct = await make({ strategy: 'premium', ...common, symbols: ['ETH/USDT'], premium: { ...premium, amount: 1000, levels: 'percent', slPct: 1, tpPct: 2 } });
    // Its first look notes the bar.
    barSpec = { signals: [] };
    await look(1);
    await nextBar({ signals: [], setups: [{}] });
    let pos = (await stateOf(pct.id)).premium?.positions[0];
    expect(pos?.sl).toBeCloseTo(1980, 9);
    expect(pos?.tp).toBeCloseTo(2040, 9);
    expect((await detail(pct.id)).events.find((e) => e.kind === 'enter')?.message).toMatch(/Intrare la setup \(semnalul încă în formare\)\. Suma: 1\.000,00 USDT\.$/);
    await nextBar({ signals: [{ time: 9000, sl: 1900, tp: 2300 }] });
    pos = (await stateOf(pct.id)).premium?.positions[0];
    expect(pos?.sl).toBeCloseTo(1980, 9);
    expect(pos?.setup).toBeUndefined();
    expect(await msgs(pct.id)).toContain('Semnalul LONG s-a confirmat; SL / TP-ul rămân cele de la intrare (procentele tale).');
  });

  it('a level moved on the chart stays the user’s at the confirmation; the other one moves', async () => {
    const account = await kucoin();
    const bot = await make({ strategy: 'premium', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 3, premium });
    await firstBar();
    await nextBar({ signals: [], setups: [{}] });
    const pos = (await stateOf(bot.id)).premium!.positions[0]!;
    // The platform holds it (else the reconciling takes it as closed by hand).
    positions = [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: pos.qty, size: pos.qty, entryPrice: 101, markPrice: 101, unrealizedPnl: 0, percentage: null, liquidationPrice: null, leverage: 3, marginMode: 'isolated', notional: 101 * pos.qty }];
    const r = await post(`/api/bots/${bot.id}/levels`, { symbol: 'BTC/USDT', side: 'long', openedAt: pos.openedAt, sl: 95 });
    expect(r.statusCode, r.body).toBe(200);
    await look();
    await nextBar({ signals: [{ time: 9000, sl: 91, tp: 113 }] });
    expect((await stateOf(bot.id)).premium!.positions[0]).toMatchObject({ sl: 95, tp: 113 });
    expect(await msgs(bot.id)).toContain('Semnalul LONG s-a confirmat: TP 112 → 113. SL-ul mutat de tine rămâne.');
  });

  it('one entry a setup: out while it still forms, the bot does not enter it again; its confirmation is an entry of its own', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    await nextBar({ signals: [], setups: [{}] });
    // Out at its take profit while it still forms.
    px['BTC/USDT'] = 112.1;
    await look();
    expect((await detail(bot.id)).history[0]).toMatchObject({ reason: 'tp' });
    px['BTC/USDT'] = 101;
    await nextBar({ signals: [], setups: [{ v2Bar: 10, v2Time: 10_000, entry: 90, sl: 88 }] });
    expect((await detail(bot.id)).positions).toEqual([]);
    expect(placed).toEqual([]);
    await nextBar({ signals: [{ bar: 10, time: 10_000, sl: 88, tp: 113 }] });
    expect((await stateOf(bot.id)).premium?.positions[0]).toMatchObject({ sl: 88, tp: 113, signalTime: 10_000 });
    expect((await stateOf(bot.id)).premium?.positions[0]?.setup).toBeUndefined();
  });

  it('FIX-BOTV1STOP: a setup’s stop is its V1; reached between two looks (the setup ended on the bar), out by the stop whatever "Ieși când trendul se întoarce"; reached while the bot looks, said so', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium: { ...premium, exitOnFlip: false } });
    await firstBar();
    await nextBar({ signals: [], setups: [{}] });
    expect((await stateOf(bot.id)).premium?.positions[0]).toMatchObject({ sl: 90, setup: { sl: 90, v1: 90 } });
    // The price touched 90 between two looks and came back: Slingshot ended the setup on that bar.
    await nextBar({ signals: [], range: { high: 102, low: 89.5 } });
    let d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.history[0]).toMatchObject({ reason: 'sl' });
    expect(d.events.some((e) => /^Stop loss-ul \(90\) a fost atins pe lumânare\. E minimul V1: setup-ul LONG s-a invalidat\. Poziția long închisă la 101 cu /.test(e.message))).toBe(true);
    // A new setup: entered; its V1 reached while the bot looks.
    await nextBar({ signals: [], setups: [{ startTime: 9500, v2Time: 9500 }] });
    expect((await detail(bot.id)).positions).toHaveLength(1);
    px['BTC/USDT'] = 89.9;
    await look();
    d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.events.some((e) => /^Stop loss atins \(90\)\. E minimul V1: setup-ul LONG s-a invalidat\. Poziția long închisă la 89,9 cu /.test(e.message))).toBe(true);
  });

  it('FIX-BOTV1STOP: with "Risc / câștig" the stop of a setup is the user’s percent, not its V1: reached, said without the V1', async () => {
    // FIX-BOTBUDGET: 1.000 a trade, so a take profit 2% away brings at least 10 there.
    const bot = await make({ strategy: 'premium', ...common, premium: { ...premium, amount: 1000, levels: 'percent', slPct: 1, tpPct: 2 } });
    await firstBar();
    await nextBar({ signals: [], setups: [{}] });
    const pos = (await stateOf(bot.id)).premium?.positions[0];
    expect(pos?.sl).toBeCloseTo(99.99, 9);
    expect(pos?.setup).toMatchObject({ v1: 90 });
    px['BTC/USDT'] = 99.9;
    await look();
    const d = await detail(bot.id);
    expect(d.history[0]).toMatchObject({ reason: 'sl' });
    expect(d.events.some((e) => /^Stop loss atins \(99,99\)\. Poziția long închisă/.test(e.message))).toBe(true);
  });

  it('a check that says no is tried again at the next bar the setup forms on, said once', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    mood.area = 30;
    await nextBar({ signals: [], setups: [{}] });
    await nextBar({ signals: [], setups: [{ v2Bar: 10, v2Time: 10_000 }] });
    let d = await detail(bot.id);
    expect(d.positions).toEqual([]);
    expect(d.events.filter((e) => e.message === 'LONG (în formare): aria Crypto e negativă (30).')).toHaveLength(1);
    mood.area = 50;
    await nextBar({ signals: [], setups: [{ v2Bar: 10, v2Time: 10_000 }] });
    d = await detail(bot.id);
    expect(d.positions[0]).toMatchObject({ side: 'long', sl: 90, tp: 112 });
  });

  it('the AI is asked once a setup (it knows it is still forming); its no holds until the confirmation, where it is asked again', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium: { ...premium, ai: 'confirm' } });
    await firstBar();
    aiAnswer = { decision: 'skip', confidence: 80, reason: 'Știrile sunt negative.', risks: [] };
    await nextBar({ signals: [], setups: [{}] });
    await nextBar({ signals: [], setups: [{}] });
    await nextBar({ signals: [], setups: [{}] });
    expect(aiAsked).toHaveLength(1);
    expect(aiAsked[0]?.prompt).toContain(
      'Semnalul e încă în formare (setup-ul Slingshot, la închiderea unei lumânări): confirmarea vine când stocasticul iese din supravânzare. Botul intră acum, înainte de confirmare; stop loss-ul e la minimul V1, unde Slingshot anulează setup-ul; la confirmare, stop loss-ul și take profit-ul se mută la cele ale semnalului.',
    );
    expect(aiAsked[0]?.system).toContain('Un semnal încă în formare nu e, în sine, un motiv de „skip”');
    const m = await msgs(bot.id);
    expect(m.filter((x) => x === 'LONG (în formare): AI-ul a spus nu (80%): Știrile sunt negative.')).toHaveLength(1);
    expect(m.filter((x) => x === 'LONG (în formare): AI-ul a spus deja nu pentru acest setup: e întrebat din nou la confirmare.')).toHaveLength(1);
    aiAnswer = { decision: 'enter', confidence: 70, reason: 'Semnal confirmat.', risks: [] };
    await nextBar({ signals: [{ time: 9000, sl: 91, tp: 113 }] });
    expect(aiAsked).toHaveLength(2);
    expect(aiAsked[1]?.prompt).toContain('Semnalul e confirmat.');
    expect((await stateOf(bot.id)).premium?.positions[0]).toMatchObject({ sl: 91, tp: 113, signalTime: 9000 });
  });

  it('"La confirmare" waits for the confirmed signal; a setup of a side the bot does not trade says nothing', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium: { ...premium, entry: 'signal' } });
    expect((await detail(bot.id)).input).toMatchObject({ premium: { entry: 'signal' } });
    await firstBar();
    await nextBar({ signals: [], setups: [{}] });
    expect((await detail(bot.id)).positions).toEqual([]);
    expect((await msgs(bot.id)).some((x) => x.startsWith('LONG'))).toBe(false);
    await nextBar({ signals: [{}] });
    expect((await detail(bot.id)).positions[0]).toMatchObject({ sl: 90, tp: 115 });

    const one = await make({ strategy: 'premium', ...common, symbols: ['ETH/USDT'], premium });
    barSpec = { signals: [] };
    await look(1);
    await nextBar({ signals: [], setups: [{ side: 'short', sl: 2100, tp: 1900 }] });
    expect((await detail(one.id)).positions).toEqual([]);
    expect((await msgs(one.id)).some((x) => x.startsWith('SHORT'))).toBe(false);
  });

  it('less in the account than the trade asks: it enters with what is there, at the same leverage; nothing there: no entry; two entries in one look share it', async () => {
    const account = await kucoin();
    px['ETH/USDT'] = 100;
    const bot = await make({ strategy: 'premium', ...common, exec: 'real', accountId: account, market: 'futures', leverage: 3, symbols: ['BTC/USDT', 'ETH/USDT'], premium: { ...premium, maxOpen: 2 } });
    await firstBar();
    futuresFree = 0;
    await nextBar({ signals: [], setups: [{}] });
    expect(placed).toEqual([]);
    expect((await msgs(bot.id)).filter((x) => x === 'LONG (în formare): în cont nu e nimic disponibil.')).toHaveLength(2);
    // BTC: 100 of margin and 0,3 of fee fit in 150; ETH: what is left (49,7), less its fee, at 3×.
    futuresFree = 150;
    await nextBar({ signals: [], setups: [{}] });
    expect(placed).toHaveLength(2);
    expect(placed[0]).toMatchObject({ symbol: 'BTC/USDT:USDT', leverage: 3, amount: 2.9702 });
    expect(placed[1]).toMatchObject({ symbol: 'ETH/USDT:USDT', leverage: 3 });
    expect(placed[1]?.amount).toBeCloseTo(Math.floor(((49.7 / 1.003) * 3) / 100 / 0.0001) * 0.0001, 9);
    const eth = (await stateOf(bot.id)).premium!.positions.find((x) => x.symbol === 'ETH/USDT');
    expect(eth?.margin).toBeCloseTo((placed[1]!.amount * 100) / 3, 9);
    expect((await msgs(bot.id)).some((x) => /^LONG la 100 3×: .* Suma: 49,55 USDT, poziția 148,65 USDT\. Suma a fost micșorată la cât e disponibil în cont \(49,70 USDT\)\.$/.test(x))).toBe(true);
  });

  it('FD-BOTTF: another timeframe keeps the position’s levels and no longer follows its setup', async () => {
    const bot = await make({ strategy: 'premium', ...common, premium });
    await firstBar();
    await nextBar({ signals: [], setups: [{}] });
    const r = await put(`/api/bots/${bot.id}`, { name: 'Test', endsAt: null, endAction: 'finish', dailyLoss: null, lossStop: null, fee: 0.1, premium, tf: '4h' });
    expect(r.statusCode, r.body).toBe(200);
    barSpec = { signals: [] };
    await look();
    const pos = (await stateOf(bot.id)).premium?.positions[0];
    expect(pos).toMatchObject({ sl: 90, tp: 112 });
    expect(pos?.setup).toBeUndefined();
    expect(pos?.signalTime).toBeUndefined();
    await look(4 * HOUR);
    expect((await detail(bot.id)).positions).toHaveLength(1);
  });
});
