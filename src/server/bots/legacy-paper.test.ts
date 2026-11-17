// FD-PAPER §7: the bots still simulating move onto Paper Trading profiles of their own, with their open positions.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/database.ts';
import { testDb } from '../test/db.ts';
import { silentLogger } from '../log.ts';
import { DEFAULT_WEIGHTS } from '../../shared/bot.ts';
import type { QuoteDeps } from '../market/quote.ts';
import { PaperService } from '../paper/service.ts';
import { migrateSimulatedBots } from './legacy-paper.ts';
import { ACTIVE_BOTS } from './engine.ts';
import { newState, type BotState } from './state.ts';

let db: Db;
let paper: PaperService;
const NOW = Date.parse('2026-11-15T12:00:00Z');

const common = { name: 'A', exec: 'paper', accountId: null, market: 'futures', symbols: ['BTC/USDT'], tf: '1h', maxAmount: 1000, leverage: 2, startsAt: null, endsAt: null, endAction: 'finish', dailyLoss: null, lossStop: null, fee: 0.2 };
const premium = { direction: 'long', sizing: 'fixed', amount: 100, riskPct: 1, maxPerTrade: null, levels: 'slingshot', slPct: 1, tpPct: 2, exitOnTpSignal: true, exitOnFlip: true, exitOnOpposite: true, longMin: 50, shortMax: 50, areaVeto: true, newsWindowMin: 0, weights: DEFAULT_WEIGHTS, ai: 'off', aiFallback: 'skip', maxOpen: 1, cooldownMin: 0 };
const dca = { direction: 'long', baseOrder: 100, safetyOrders: 2, safetyOrder: 100, volumeScale: 1, deviation: 2, stepScale: 1, takeProfit: 2, stopLoss: null, slAction: 'stop', repeat: true, maxCycles: null, cooldownMin: 0 };

const insert = async (config: Record<string, unknown>, state: BotState, status = 'running', execution = 'paper', accountId: number | null = null) => {
  const market = config.market as string;
  const r = await db.run(
    'INSERT INTO bots(user_id, name, strategy, execution, account_id, market, area, symbols, tf, config, status, state, starts_at, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)',
    [config.name as string, config.strategy as string, execution, accountId, market, market === 'stock' ? 'stocks' : 'crypto', JSON.stringify(config.symbols), config.tf as string, JSON.stringify(config), status, JSON.stringify(state)],
  );
  return r.lastInsertRowid;
};
const bot = (id: number) => db.get<{ execution: string; account_id: number | null; status: string; status_reason: string | null; config: string; state: string }>('SELECT execution, account_id, status, status_reason, config, state FROM bots WHERE id = ?', [id]);
const positionsOf = (accountId: number) => db.all('SELECT market, symbol, side, qty, entry, leverage, margin_mode, margin, sl, tp, fees FROM paper_positions WHERE account_id = ? ORDER BY id', [accountId]);
const migrate = (maxAccounts = 20) => migrateSimulatedBots({ db, paper, log: silentLogger, maxAccounts, now: () => NOW });

beforeEach(async () => {
  db = await testDb();
  paper = new PaperService({ db, quotes: {} as QuoteDeps, log: silentLogger, now: () => NOW });
});

describe('the simulating bots move onto Paper Trading (FD-PAPER §7)', () => {
  it('each onto a profile of its own, with its market, 100.000 USD and its fee; its open positions in it, without SL / TP; then it trades there', async () => {
    const st = newState(null);
    st.premium = { lastBar: {}, nextRead: {}, positions: [{ symbol: 'BTC/USDT', side: 'long', qty: 0.5, entry: 100, margin: 25, lev: 2, fees: 0.1, openedAt: NOW - 1000, sl: 90, tp: 120, mm: 'isolated' }], cooldownUntil: 0, ai: { day: '', n: 0 }, recent: [] };
    const a = await insert({ ...common, strategy: 'premium', premium }, st);
    const sd = newState(null);
    sd.dca = { cycle: 1, cooldownUntil: 0, done: false, deal: { side: 'long', basePrice: 100, filled: 1, qty: 2, cost: 196, margin: 196, fees: 0.4, openedAt: NOW - 2000 } };
    const b = await insert({ ...common, name: 'B', strategy: 'dca', market: 'spot', leverage: 1, fee: 0.1, dca }, sd);
    const c = await insert({ ...common, name: 'C', strategy: 'premium', market: 'stock', symbols: ['QQQ'], tf: '1d', leverage: 1, premium }, newState(null));
    const ended = await insert({ ...common, name: 'D', strategy: 'premium', premium }, newState(null), 'ended');
    // Not run while simulating: they wait to be moved.
    expect((await db.all<{ id: number }>(ACTIVE_BOTS)).map((r) => r.id)).toEqual([]);

    expect(await migrate()).toEqual({ moved: 3, failed: 0 });
    const ra = await bot(a);
    expect(ra).toMatchObject({ execution: 'real', status: 'running' });
    const pa = ra!.account_id as number;
    expect(await paper.account(pa)).toMatchObject({ label: 'Paper · A', kind: 'crypto', budget: 100_000, cash: 100_000, commission_type: 'percent', commission_value: 0.2 });
    expect(JSON.parse(ra!.config)).toMatchObject({ exec: 'real', accountId: pa });
    expect(await positionsOf(pa)).toEqual([{ market: 'futures', symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.5, entry: 100, leverage: 2, margin_mode: 'isolated', margin: 25, sl: null, tp: null, fees: 0.1 }]);
    expect(await db.get("SELECT message FROM bot_events WHERE bot_id = ? AND kind = N'info'", [a])).toEqual({ message: 'Simularea a trecut pe contul Paper Trading „Paper · A” (100.000 USD, comision 0,2% pe execuție).' });

    // Spot: a position at 1× (FIX-PAPERLEV), its cost held as margin, the money not spent.
    const pb = (await bot(b))!.account_id as number;
    expect(await positionsOf(pb)).toEqual([{ market: 'spot', symbol: 'BTC/USDT', side: 'long', qty: 2, entry: 98, leverage: 1, margin_mode: 'isolated', margin: 196, sl: null, tp: null, fees: 0.4 }]);
    expect((await paper.account(pb))!.cash).toBe(100_000);
    // Shares: a profile of shares.
    const pc = (await bot(c))!.account_id as number;
    expect(await paper.account(pc)).toMatchObject({ label: 'Paper · C', kind: 'stocks' });
    expect(await bot(ended)).toMatchObject({ execution: 'paper', account_id: null, status: 'ended' });
    expect((await db.all<{ id: number }>(ACTIVE_BOTS)).map((r) => r.id)).toEqual([a, b, c]);
    // Once: nothing left to move.
    expect(await migrate()).toEqual({ moved: 0, failed: 0 });
    expect(await db.get('SELECT count(*) AS n FROM paper_accounts')).toEqual({ n: 3 });
  });

  it('without room for a profile the bot ends; a transition from a real account keeps its real positions with that account', async () => {
    const kucoin = (await db.run("INSERT INTO exchange_accounts(user_id, exchange, label, api_key, secret, key_hint, env, created_at) VALUES (1, N'kucoin', N'KuCoin', N'x', N'x', N'x', N'live', 1)")).lastInsertRowid;
    const real = { ...common, name: 'R', strategy: 'premium', exec: 'real', accountId: kucoin, premium };
    const st: BotState = { ...newState(null), basis: real as never };
    st.premium = { lastBar: {}, nextRead: {}, positions: [{ symbol: 'BTC/USDT', side: 'long', qty: 0.5, entry: 100, margin: 25, lev: 2, fees: 0.1, openedAt: NOW - 1000, sl: 90, tp: 120 }], cooldownUntil: 0, ai: { day: '', n: 0 }, recent: [] };
    // Settings changed from the real account to a simulation, the real position still finishing.
    const r = await insert({ ...real, exec: 'paper', accountId: null }, st);
    const full = await insert({ ...common, name: 'F', strategy: 'premium', premium }, newState(null));
    expect(await migrate(2)).toEqual({ moved: 1, failed: 0 });
    const rr = await bot(r);
    const pr = rr!.account_id as number;
    expect(pr).not.toBe(kucoin);
    expect(await positionsOf(pr)).toEqual([]);
    expect((JSON.parse(rr!.state) as BotState).basis).toMatchObject({ exec: 'real', accountId: kucoin });
    expect(JSON.parse(rr!.config)).toMatchObject({ exec: 'real', accountId: pr });
    expect(await bot(full)).toMatchObject({ status: 'ended', status_reason: 'Simularea se face acum doar cu un cont Paper Trading: fă unul și pornește botul din nou.' });
  });
});
