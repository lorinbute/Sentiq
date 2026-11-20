import { afterEach, describe, expect, it } from 'vitest';
import { testDb } from '../test/db.ts';
import { setFetchImpl } from '../net/http.ts';
import { MarketError } from './market.ts';
import { parseCnn, readStockContext, refreshStockContext } from './stock-context.ts';
import {
  cleanCompanyName,
  CreditBudget,
  defaultStockAliases,
  editDistance,
  nasdaqNumber,
  parseNasdaqEt,
  StockData,
  stockTimeframes,
  TwelveDataClient,
  weeklyFromDaily,
  zonedToUtc,
  type MarketStatus,
  type NasdaqClient,
} from './stocks.ts';

type Route = (url: URL) => { status?: number; body: unknown } | undefined;
const seen: string[] = [];
function serve(...routes: Route[]) {
  setFetchImpl((async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url.toString());
    for (const r of routes) {
      const res = r(url);
      if (res) return new Response(typeof res.body === 'string' ? res.body : JSON.stringify(res.body), { status: res.status ?? 200 });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch);
}

afterEach(() => {
  setFetchImpl(null);
  seen.length = 0;
});

const NY = 'America/New_York';

describe('company names', () => {
  it('drops legal suffixes and share classes', () => {
    expect(cleanCompanyName('Alphabet Inc. Class A Common Stock')).toBe('Alphabet');
    expect(cleanCompanyName('Coinbase Global, Inc. - Class A Common Stock')).toBe('Coinbase Global');
    expect(cleanCompanyName('The Walt Disney Company')).toBe('Walt Disney');
    expect(cleanCompanyName('Coca-Cola Company (The)')).toBe('Coca-Cola');
    expect(cleanCompanyName('AT&T Inc.')).toBe('AT&T');
  });

  it('adds the brand when the second word is generic, never a plain first word', () => {
    expect(defaultStockAliases('Palantir Technologies Inc. Class A Common Stock')).toEqual(['Palantir Technologies', 'Palantir']);
    expect(defaultStockAliases('General Motors Company')).toEqual(['General Motors']);
    expect(defaultStockAliases('Advanced Micro Devices, Inc. Common Stock')).toEqual(['Advanced Micro Devices']);
    expect(defaultStockAliases('Booking Holdings Inc.')).toEqual(['Booking']);
    // Too short for an alias (the news detector needs 3 letters at least).
    expect(defaultStockAliases('3M Company')).toEqual([]);
    expect(defaultStockAliases(null)).toEqual([]);
  });
});

describe('Nasdaq parsing', () => {
  it('reads prices written as text', () => {
    expect(nasdaqNumber('$340.97')).toBe(340.97);
    expect(nasdaqNumber('25,900,600')).toBe(25_900_600);
    expect(nasdaqNumber('+1.29%')).toBe(1.29);
    expect(nasdaqNumber('N/A')).toBeNull();
    expect(nasdaqNumber('')).toBeNull();
  });

  it('reads New York times across the DST change', () => {
    expect(parseNasdaqEt('Oct 13, 2026 09:30 AM ET')).toBe(Date.parse('2026-10-13T13:30:00Z'));
    expect(parseNasdaqEt('Dec 1, 2026 04:00 PM ET')).toBe(Date.parse('2026-12-01T21:00:00Z'));
    expect(parseNasdaqEt('Dec 1, 2026 12:15 AM ET')).toBe(Date.parse('2026-12-01T05:15:00Z'));
    expect(parseNasdaqEt('soon')).toBeNull();
    expect(zonedToUtc(2026, 3, 9, 9, 30, 0, NY)).toBe(Date.parse('2026-03-09T13:30:00Z'));
  });

  it('builds weeks starting Monday in New York', () => {
    const day = (d: string, o: number, c: number) => ({ t: zonedToUtc(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10), 0, 0, 0, NY), o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 10 });
    const w = weeklyFromDaily([day('2026-10-02', 1, 2), day('2026-10-05', 2, 3), day('2026-10-07', 3, 5), day('2026-10-09', 5, 4), day('2026-10-12', 4, 6)]);
    expect(w.map((x) => new Date(x.t).toISOString())).toEqual(['2026-09-28T04:00:00.000Z', '2026-10-05T04:00:00.000Z', '2026-10-12T04:00:00.000Z']);
    expect(w[1]).toMatchObject({ o: 2, c: 4, h: 6, l: 1, v: 30 });
  });
});

describe('Twelve Data budget', () => {
  it('allows 8 a minute and 800 a day, and remembers the day across restarts', async () => {
    const db = await testDb();
    let now = Date.parse('2026-10-13T10:00:00Z');
    const b = new CreditBudget({ db, now: () => now });
    await b.ready;
    for (let i = 0; i < 8; i++) b.take();
    expect(() => b.take()).toThrow(/8 cereri pe minut/);
    now += 61_000;
    b.take();
    expect(b.status()).toMatchObject({ used: 9, minuteUsed: 1, perDay: 800 });
    await b.settled();
    const again = new CreditBudget({ db, now: () => now });
    await again.ready;
    expect(again.status().used).toBe(9);
    // A new UTC day starts from zero.
    now = Date.parse('2026-10-14T00:00:01Z');
    expect(again.status().used).toBe(0);
  });

  it('stops at the daily limit with the time it comes back', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    const b = new CreditBudget({ now: () => now, perMinute: 1000, perDay: 3 });
    b.take(3);
    expect(() => b.take()).toThrow(/limita zilnică Twelve Data \(3 cereri\).*00:00 UTC/);
  });
});

describe('FIX-TDBOTS: the bots come first in the credits', () => {
  it('what the bots read lately is kept for them each minute; the rest uses what is left; a bot may use all', () => {
    let now = Date.parse('2026-11-20T15:00:00Z');
    const b = new CreditBudget({ now: () => now, perMinute: 55, perDay: null });
    for (let i = 0; i < 13; i++) b.noteBot(`S${i}|5m`);
    for (let i = 0; i < 13; i++) b.noteBot(`S${i}|1h`);
    expect(b.reserve()).toBe(26);
    // The rest: 55 − 26 = 29.
    for (let i = 0; i < 29; i++) b.take(1);
    expect(() => b.take(1)).toThrow(/26 din cele 55 cereri Twelve Data pe minut sunt păstrate pentru boți; revine în \d+ s/);
    // The bots: up to the whole minute.
    for (let i = 0; i < 26; i++) b.take(1, 'bot');
    expect(() => b.take(1, 'bot')).toThrow(/limita Twelve Data de 55 cereri pe minut/);
    // The same thing read again counts once; after 15 minutes without it, nothing is kept.
    now += 5 * 60_000;
    b.noteBot('S0|5m');
    expect(b.reserve()).toBe(26);
    now += 10 * 60_000;
    expect(b.reserve()).toBe(1);
    now += 5 * 60_000;
    expect(b.reserve()).toBe(0);
  });

  it("through the candles: a bot's read reserves its credits and is served while the rest is refused", async () => {
    const db = await testDb();
    const now = Date.parse('2026-10-21T15:45:11Z');
    const budget = new CreditBudget({ now: () => now, perMinute: 8, perDay: null });
    const s = new StockData({ db, key: async () => 'b'.repeat(32), now: () => now, nasdaq: fakeNasdaq().n, budget });
    serve((u) =>
      u.pathname === '/time_series'
        ? { body: { meta: { exchange: 'NASDAQ', exchange_timezone: 'America/New_York' }, values: [{ datetime: '2026-10-21 11:40:00', open: '2', high: '2.2', low: '1.9', close: '2.1', volume: '5' }], status: 'ok' } }
        : undefined,
    );
    // A bot reads four shares on 5m: four credits kept for the bots.
    for (const sym of ['AAA', 'BBB', 'CCC', 'DDD']) await s.candles(sym, '5m', 50, 1, false, 'bot');
    expect(budget.reserve()).toBe(4);
    // The rest (a chart, the scanner): the 8 − 4 left are used up, the next one is refused...
    await expect(s.candles('EEE', '5m', 50, 1)).rejects.toThrow(/păstrate pentru boți/);
    // ...while a bot's read still gets through, up to the minute's 8.
    await s.candles('FFF', '5m', 50, 1, false, 'bot');
    expect(budget.status().minuteUsed).toBe(5);
  });

  it('the rest keeps at least a quarter of the minute; without bots, everything', () => {
    const now = Date.parse('2026-11-20T15:00:00Z');
    const b = new CreditBudget({ now: () => now, perMinute: 8, perDay: null });
    expect(b.reserve()).toBe(0);
    for (let i = 0; i < 20; i++) b.noteBot(`S${i}|5m`);
    expect(b.reserve()).toBe(6);
    b.take(1);
    b.take(1);
    expect(() => b.take(1)).toThrow(/păstrate pentru boți/);
    b.take(6, 'bot');
  });
});

describe('Twelve Data plan (FD-TDPLAN)', () => {
  it('applies the key’s plan: 55 a minute and no daily limit on Grow; kept in the database for the other instance', async () => {
    const db = await testDb();
    let now = Date.parse('2026-10-13T10:00:00Z');
    const b = new CreditBudget({ db, now: () => now });
    await b.ready;
    expect(b.status()).toMatchObject({ perMinute: 8, perDay: 800, plan: { category: 'basic', assumed: true, at: null } });
    await b.setPlan({ category: 'grow', perMinute: 55, perDay: null }, 'abcd');
    for (let i = 0; i < 55; i++) b.take();
    expect(() => b.take()).toThrow(/55 cereri pe minut/);
    expect(b.status()).toMatchObject({ perMinute: 55, perDay: null, plan: { category: 'grow', assumed: false, at: now } });
    // No daily limit: thousands in a day.
    for (let m = 1; m <= 40; m++) {
      now += 61_000;
      b.take(50);
    }
    expect(b.status().used).toBe(2055);
    // The other instance (Mac / Azure) reads the same plan, and picks a change up within 5 minutes.
    const other = new CreditBudget({ db, now: () => now });
    await other.ready;
    expect(other.planFor('abcd')).toMatchObject({ category: 'grow', perMinute: 55, perDay: null });
    expect(other.planFor('wxyz')).toBeNull();
    await b.setPlan({ category: 'pro', perMinute: 610, perDay: null }, 'abcd');
    expect(other.status().perMinute).toBe(55);
    now += 5 * 60_000;
    other.status();
    await new Promise((r) => setTimeout(r, 300));
    expect(other.status().perMinute).toBe(610);
    // The key removed: back to the free plan's limits.
    await b.clearPlan();
    expect(b.status()).toMatchObject({ perMinute: 8, perDay: 800, plan: { assumed: true } });
  });

  it('reads the plan from /api_usage (one credit): a daily limit only when Twelve Data gives one', async () => {
    const budget = new CreditBudget({ now: () => Date.parse('2026-10-13T15:00:00Z') });
    const client = new TwelveDataClient(async () => 'k'.repeat(32), budget);
    serve((u) => (u.pathname === '/api_usage' ? { body: { timestamp: '2026-10-13 15:00:00', current_usage: 3, plan_limit: 8, daily_usage: 40, plan_daily_limit: 800, plan_category: 'basic' } } : undefined));
    expect(await client.plan()).toEqual({ category: 'basic', perMinute: 8, perDay: 800 });
    serve((u) => (u.pathname === '/api_usage' ? { body: { timestamp: '2026-10-13 15:00:00', current_usage: 0, plan_limit: 55, plan_category: 'Grow' } } : undefined));
    expect(await client.plan()).toEqual({ category: 'grow', perMinute: 55, perDay: null });
    expect(budget.status().used).toBe(2);
    serve((u) => (u.pathname === '/api_usage' ? { body: { timestamp: 'x', current_usage: 0 } } : undefined));
    await expect(client.plan()).rejects.toThrow(/răspuns neașteptat la citirea planului/);
  });

  it('StockData reads the plan for the key, forgets it without one, and keeps the last on a failed read', async () => {
    const db = await testDb();
    let key: string | null = 'a'.repeat(28) + 'wxyz';
    // Another day than the test above, whose thousands of credits are still in this schema's count.
    const s = new StockData({ db, key: async () => key, now: () => Date.parse('2026-10-20T15:00:00Z') });
    await s.budget(1).ready;
    serve((u) => (u.pathname === '/api_usage' ? { body: { current_usage: 0, plan_limit: 55, plan_category: 'grow', timestamp: 'x' } } : undefined));
    expect(await s.refreshPlan(1)).toEqual({ category: 'grow', perMinute: 55, perDay: null });
    expect(s.budget(1).planFor('wxyz')).toMatchObject({ perMinute: 55 });
    serve(() => ({ status: 500, body: { status: 'error', code: 500, message: 'down' } }));
    await expect(s.refreshPlan(1)).rejects.toThrow();
    expect(s.budget(1).status().perMinute).toBe(55);
    key = null;
    expect(await s.refreshPlan(1)).toBeNull();
    expect(s.budget(1).status()).toMatchObject({ perMinute: 8, perDay: 800 });
  });

  it("FD-TDKEYS: each user's key has its own credits, plan, candles and timeframes; without a key, Nasdaq for everyone", async () => {
    const db = await testDb();
    const keys: Record<number, string | null> = { 1: 'a'.repeat(28) + 'aaaa', 2: 'b'.repeat(28) + 'bbbb', 3: null };
    const now = Date.parse('2026-10-21T15:00:00Z');
    const f = fakeNasdaq();
    const s = new StockData({ db, key: async (u) => keys[u] ?? null, now: () => now, nasdaq: f.n });
    const used: string[] = [];
    serve((u) => {
      if (u.pathname === '/api_usage') return { body: { plan_limit: u.searchParams.get('apikey')?.startsWith('a') ? 55 : 8, plan_daily_limit: u.searchParams.get('apikey')?.startsWith('a') ? null : 800, plan_category: 'x' } };
      if (u.pathname === '/time_series') {
        used.push(u.searchParams.get('apikey')!.slice(0, 1));
        return { body: { meta: { exchange: 'NASDAQ', exchange_timezone: 'America/New_York' }, values: [{ datetime: '2026-10-21 10:00:00', open: '1', high: '2', low: '1', close: '2', volume: '5' }], status: 'ok' } };
      }
      // FIX-STOCKLIVE: the candle forming, from the live price (a credit).
      if (u.pathname === '/price') return { body: { price: '2.5' } };
      return undefined;
    });
    await s.refreshPlan(1);
    await s.refreshPlan(2);
    expect(s.budget(1).status()).toMatchObject({ perMinute: 55, perDay: null });
    expect(s.budget(2).status()).toMatchObject({ perMinute: 8, perDay: 800 });
    expect(await s.timeframes(1)).toContain('1h');
    expect(await s.timeframes(3)).toEqual(['1d', '1w']);
    // The same share for two users with keys: each with their own key and credits, no candles shared.
    await s.candles('AAPL', '1h', 50, 1);
    await s.candles('AAPL', '1h', 50, 2);
    await s.candles('AAPL', '1h', 50, 1);
    expect(used).toEqual(['a', 'b']);
    expect(s.budget(1).status().used).toBe(2);
    expect(s.budget(2).status().used).toBe(2);
    // Without a key: 1h is not there, the daily is Nasdaq's.
    await expect(s.candles('AAPL', '1h', 50, 3)).rejects.toMatchObject({ code: 'UNSUPPORTED_TIMEFRAME', message: expect.stringContaining('Setări → Ale mele → Date pentru acțiuni') });
    expect((await s.candles('AAPL', '1d', 50, 3)).exchange).toBe('nasdaq');
    // Persisted apart; a new key starts the day from nothing; a forgotten user leaves memory.
    await s.budget(1).settled();
    await s.budget(2).settled();
    expect(await db.get("SELECT 1 AS x FROM market_cache WHERE [key] = N'td:usage:2'")).toBeDefined();
    await s.budget(2).reset();
    expect(s.budget(2).status().used).toBe(0);
    expect(new CreditBudget({ db, now: () => now, scope: '1' }).perMinute).toBe(8);
    const again = new CreditBudget({ db, now: () => now, scope: '1' });
    await again.ready;
    expect(again.status()).toMatchObject({ used: 2, perMinute: 55 });
    s.forget(1);
    expect(s.budget(1)).not.toBe(again);
  });
});

describe('FIX-STOCKLIVE: the candle forming, from the live price', () => {
  it('builds the candles Twelve Data has not published from the live price, follows it, and gives way to its own', async () => {
    const db = await testDb();
    // 11:45:11 in New York; Twelve Data has published up to the 11:43 candle (closed ones only, a minute late).
    let now = Date.parse('2026-10-21T15:45:11Z');
    const f = fakeNasdaq();
    const s = new StockData({ db, key: async () => 'a'.repeat(28) + 'aaaa', now: () => now, nasdaq: f.n });
    let published = ['2026-10-21 11:42:00', '2026-10-21 11:43:00'];
    let price = 2.5;
    const calls: string[] = [];
    serve((u) => {
      if (u.pathname === '/time_series') {
        calls.push('series');
        return { body: { meta: { exchange: 'NASDAQ', exchange_timezone: 'America/New_York' }, values: published.map((d) => ({ datetime: d, open: '2', high: '2.2', low: '1.9', close: '2.1', volume: '5' })), status: 'ok' } };
      }
      if (u.pathname === '/price') {
        calls.push('price');
        return { body: { price: String(price) } };
      }
      return undefined;
    });
    const t = (hm: string) => Date.parse(`2026-10-21T15:${hm}:00Z`);
    let r = await s.candles('AAPL', '1m', 50, 1, true);
    // The 11:45 candle, from the 11:43 close to the live price.
    expect(r.candles.map((c) => c.t)).toEqual([t('42'), t('43'), t('45')]);
    expect(r.candles.at(-1)).toMatchObject({ o: 2.1, h: 2.5, l: 2.1, c: 2.5 });
    // 30 s later: the price read again (kept 25 s), the candles not (kept a minute): the same candle follows it.
    now += 30_000;
    price = 2.7;
    r = await s.candles('AAPL', '1m', 50, 1, true);
    expect(r.candles.at(-1)).toMatchObject({ t: t('45'), o: 2.1, h: 2.7, c: 2.7 });
    // 11:46:07: a new candle opens at the last close.
    now += 26_000;
    price = 2.6;
    r = await s.candles('AAPL', '1m', 50, 1, true);
    expect(r.candles.slice(-2).map((c) => c.t)).toEqual([t('45'), t('46')]);
    expect(r.candles.at(-1)).toMatchObject({ o: 2.7, c: 2.6 });
    // Twelve Data publishes 11:44 and 11:45: its own replace the one built; 11:46 (not published yet) and the forming
    // 11:47 stay.
    published = [...published, '2026-10-21 11:44:00', '2026-10-21 11:45:00'];
    now += 61_000;
    r = await s.candles('AAPL', '1m', 50, 1, true);
    expect(r.candles.map((c) => c.t)).toEqual([t('42'), t('43'), t('44'), t('45'), t('46'), t('47')]);
    expect(r.candles.find((c) => c.t === t('45'))).toMatchObject({ c: 2.1 });
    // The credits: a series a minute, a price each read past 25 s.
    expect(calls).toEqual(['series', 'price', 'price', 'price', 'series', 'price']);
    // A bot's or the scanner's read: Twelve Data's own candles only (no candle built from prices).
    expect((await s.candles('AAPL', '1m', 50, 1)).candles.map((c) => c.t)).toEqual([t('42'), t('43'), t('44'), t('45')]);
  });

  it('moves the forming candle Twelve Data gives on 5m with the live price (it updates it only as minutes close)', async () => {
    const db = await testDb();
    // 13:21:27 in New York: Twelve Data's 5m candle 13:20 is forming, at the 13:20 minute's close.
    const now = Date.parse('2026-10-21T17:21:27Z');
    const f = fakeNasdaq();
    const s = new StockData({ db, key: async () => 'a'.repeat(28) + 'aaaa', now: () => now, nasdaq: f.n });
    serve((u) => {
      if (u.pathname === '/time_series') return { body: { meta: { exchange: 'NASDAQ', exchange_timezone: 'America/New_York' }, values: [{ datetime: '2026-10-21 13:15:00', open: '348', high: '348.5', low: '347.9', close: '348.14', volume: '1' }, { datetime: '2026-10-21 13:20:00', open: '348.14', high: '348.6', low: '348.1', close: '348.545', volume: '1' }], status: 'ok' } };
      if (u.pathname === '/price') return { body: { price: '348.9' } };
      return undefined;
    });
    const r = await s.candles('AAPL', '5m', 50, 1, true);
    expect(r.candles).toHaveLength(2);
    expect(r.candles.at(-1)).toMatchObject({ t: Date.parse('2026-10-21T17:20:00Z'), o: 348.14, h: 348.9, l: 348.1, c: 348.9 });
  });

  it('builds nothing outside the session, nor on a daily chart', async () => {
    const db = await testDb();
    const now = Date.parse('2026-10-21T15:45:11Z');
    const closed = fakeNasdaq({ status: 'closed' });
    const s = new StockData({ db, key: async () => 'a'.repeat(28) + 'aaaa', now: () => now, nasdaq: closed.n });
    let prices = 0;
    serve((u) => {
      if (u.pathname === '/time_series') return { body: { meta: { exchange: 'NASDAQ', exchange_timezone: 'America/New_York' }, values: [{ datetime: '2026-10-21 11:43:00', open: '2', high: '2', low: '2', close: '2', volume: '1' }], status: 'ok' } };
      if (u.pathname === '/price') {
        prices += 1;
        return { body: { price: '3' } };
      }
      return undefined;
    });
    expect((await s.candles('AAPL', '1m', 50, 1, true)).candles).toHaveLength(1);
    expect(prices).toBe(0);
  });
});

describe('FD-FXCOMMODITIES: forex pairs and commodities', () => {
  const fxServe = (calls: string[], closes: string[] = ['1.0800', '1.0810']) =>
    serve((u) => {
      calls.push(u.pathname);
      if (u.pathname === '/forex_pairs')
        return {
          body: {
            data: [
              { symbol: 'AED/ARS', currency_group: 'Exotic', currency_base: 'UAE Dirham', currency_quote: 'Argentinian Peso' },
              { symbol: 'EUR/GBP', currency_group: 'Minor', currency_base: 'Euro', currency_quote: 'British Pound' },
              { symbol: 'EUR/USD', currency_group: 'Major', currency_base: 'Euro', currency_quote: 'US Dollar' },
              { symbol: 'GBP/USD', currency_group: 'Major', currency_base: 'British Pound', currency_quote: 'US Dollar' },
            ],
            status: 'ok',
          },
        };
      if (u.pathname === '/commodities')
        return { body: { data: [{ symbol: 'XAU/USD', name: 'Gold Spot', category: 'Precious Metal' }, { symbol: 'XAGg/EUR', name: 'Gram Silver', category: 'Precious Metal' }, { symbol: 'WTI/USD', name: 'Crude Oil WTI Spot', category: 'Energy' }, { symbol: 'HG1', name: 'Copper Spot', category: 'Industrial Metal' }], status: 'ok' } };
      // FIX-FXTIME: as Twelve Data answers a pair: no exchange_timezone; its times in UTC only when asked so (else Sydney's).
      if (u.pathname === '/time_series')
        return {
          body: {
            meta: { symbol: 'EUR/USD', type: 'Physical Currency' },
            values: closes.map((c, i) => ({ datetime: u.searchParams.get('timezone') === 'UTC' ? `2026-11-21 0${i}:00:00` : `2026-11-21 1${i + 1}:00:00`, open: c, high: c, low: c, close: c })),
            status: 'ok',
          },
        };
      if (u.pathname === '/quote') return { body: { symbol: 'EUR/USD', close: '1.0812', change: '0.0012', percent_change: '0.11', is_market_open: false, status: 'ok' } };
      return undefined;
    });

  it('lists them once a day, searches the majors first, leaves the mixed-case symbols out and names the commodities in Romanian', async () => {
    const db = await testDb();
    const now = Date.parse('2026-11-20T10:00:00Z');
    const s = new StockData({ db, key: async () => 'a'.repeat(28) + 'aaaa', now: () => now, nasdaq: fakeNasdaq().n });
    const calls: string[] = [];
    fxServe(calls);
    expect((await s.fxSearch(1, 'forex', '')).map((r) => r.symbol)).toEqual(['EUR/USD', 'GBP/USD', 'EUR/GBP', 'AED/ARS']);
    expect((await s.fxSearch(1, 'forex', 'eur')).map((r) => r.symbol)).toEqual(['EUR/USD', 'EUR/GBP']);
    expect((await s.fxSearch(1, 'forex', 'eurusd')).map((r) => r.symbol)).toEqual(['EUR/USD']);
    expect((await s.fxSearch(1, 'forex', 'pound')).map((r) => r.symbol)).toEqual(['GBP/USD', 'EUR/GBP']);
    expect(await s.fxSearch(1, 'commodity', '')).toEqual([
      { symbol: 'XAU/USD', name: 'Aur', group: 'Precious Metal' },
      { symbol: 'WTI/USD', name: 'Petrol WTI', group: 'Energy' },
      { symbol: 'HG1', name: 'Cupru', group: 'Industrial Metal' },
    ]);
    expect((await s.fxSearch(1, 'commodity', 'aur')).map((r) => r.symbol)).toEqual(['XAU/USD']);
    // Found in English too (the user looked for „crude oil”): Twelve Data's name, the aliases.
    expect((await s.fxSearch(1, 'commodity', 'crude oil')).map((r) => r.symbol)).toEqual(['WTI/USD']);
    expect((await s.fxSearch(1, 'commodity', 'oil')).map((r) => r.symbol)).toEqual(['WTI/USD']);
    expect((await s.fxSearch(1, 'commodity', 'gold')).map((r) => r.symbol)).toEqual(['XAU/USD']);
    expect((await s.fxSearch(1, 'commodity', 'petrol')).map((r) => r.symbol)).toEqual(['WTI/USD']);
    expect(calls.filter((c) => c === '/forex_pairs')).toHaveLength(1);
    expect(await s.fxEntry(1, 'forex', 'EUR/USD')).toMatchObject({ name: 'Euro / US Dollar' });
    expect(await s.fxEntry(1, 'forex', 'EUR/XYZ')).toBeNull();
  });

  it('without a key: nothing found, candles refused', async () => {
    const db = await testDb();
    const s = new StockData({ db, key: async () => null, now: () => Date.parse('2026-11-20T10:00:00Z'), nasdaq: fakeNasdaq().n });
    expect(await s.fxSearch(1, 'forex', 'eur')).toEqual([]);
    await expect(s.fxCandles('EUR/USD', '1h', 50, 1)).rejects.toThrow(/cer cheia ta Twelve Data/);
  });

  it('candles from Twelve Data in its time zone; over the weekend nothing is built from the live price; the quote kept a minute', async () => {
    const db = await testDb();
    // Saturday: the 24/5 week is closed.
    let now = Date.parse('2026-11-21T10:00:00Z');
    const s = new StockData({ db, key: async () => 'a'.repeat(28) + 'aaaa', now: () => now, nasdaq: fakeNasdaq().n });
    const calls: string[] = [];
    fxServe(calls);
    const r = await s.fxCandles('EUR/USD', '1h', 50, 1, true);
    expect(r.candles.map((c) => c.t)).toEqual([Date.parse('2026-11-21T00:00:00Z'), Date.parse('2026-11-21T01:00:00Z')]);
    // A pair's four decimals on the chart (1,0810), not a share's two.
    expect(r.pricePrecision).toBe(4);
    expect(calls).not.toContain('/price');
    const q = await s.fxQuote(1, 'EUR/USD');
    expect(q).toMatchObject({ symbol: 'EUR/USD', last: 1.0812, changePct: 0.11, open: false });
    now += 30_000;
    await s.fxQuote(1, 'EUR/USD');
    expect(calls.filter((c) => c === '/quote')).toHaveLength(1);
  });
});

describe('Twelve Data client', () => {
  const td = (key: string | null = 'k'.repeat(32)) => new TwelveDataClient(async () => key, new CreditBudget({ now: () => Date.parse('2026-10-13T15:00:00Z') }));

  it('maps the exchange-time datetimes to UTC, oldest first', async () => {
    serve((u) =>
      u.pathname === '/time_series'
        ? {
            body: {
              meta: { symbol: 'AAPL', exchange_timezone: NY, exchange: 'NASDAQ' },
              values: [
                { datetime: '2026-10-12 10:30:00', open: '2', high: '3', low: '1', close: '2.5', volume: '100' },
                { datetime: '2026-10-12 09:30:00', open: '1', high: '2', low: '0.5', close: '2', volume: '50' },
              ],
              status: 'ok',
            },
          }
        : undefined,
    );
    const r = await td().timeSeries('AAPL', '1h', 2);
    expect(r.candles.map((c) => new Date(c.t).toISOString())).toEqual(['2026-10-12T13:30:00.000Z', '2026-10-12T14:30:00.000Z']);
    expect(r.candles[1]).toMatchObject({ o: 2, h: 3, l: 1, c: 2.5, v: 100 });
    expect(seen[0]).toContain('interval=1h');
    expect(seen[0]).toContain('order=ASC');
  });

  it('explains its errors', async () => {
    serve(() => ({ body: { code: 401, message: '**apikey** parameter is incorrect', status: 'error' } }));
    await expect(td().timeSeries('AAPL', '1h', 2)).rejects.toThrow(/cheia nu e validă/);
    serve(() => ({ body: { code: 400, message: 'symbol not found', status: 'error' } }));
    await expect(td().timeSeries('ZZZZ', '1h', 2)).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL' });
    await expect(td(null).timeSeries('AAPL', '1h', 2)).rejects.toThrow(/Cheia ta Twelve Data lipsește \(Setări → Ale mele → Date pentru acțiuni\)/);
  });

  it('pauses for the rest of the minute after a 429', async () => {
    serve(() => ({ status: 429, body: { code: 429, message: 'You have run out of API credits for the current minute', status: 'error' } }));
    const c = td();
    await expect(c.timeSeries('AAPL', '1h', 2)).rejects.toThrow(/limita de cereri/);
    await expect(c.timeSeries('AAPL', '1h', 2)).rejects.toThrow(/pe minut a fost atinsă/);
    expect(seen).toHaveLength(1);
  });

  it('keeps US shares and ETFs from the symbol search', async () => {
    serve(() => ({
      body: {
        data: [
          { symbol: 'AAPL', instrument_name: 'Apple Inc', exchange: 'NASDAQ', country: 'United States', instrument_type: 'Common Stock' },
          { symbol: 'APC', instrument_name: 'Apple Inc', exchange: 'XETR', country: 'Germany', instrument_type: 'Common Stock' },
          { symbol: 'AAPX', instrument_name: 'T-Rex 2X Long Apple', exchange: 'CBOE', country: 'United States', instrument_type: 'ETF' },
        ],
        status: 'ok',
      },
    }));
    expect(await td().search('apple')).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc', exchange: 'NASDAQ', type: 'Acțiune' },
      { symbol: 'AAPX', name: 'T-Rex 2X Long Apple', exchange: 'CBOE', type: 'ETF' },
    ]);
  });
});

/** A Nasdaq stand-in: `daily` returns `days` bars ending yesterday. */
function fakeNasdaq(opts: { fail?: boolean; status?: MarketStatus['state'] } = {}) {
  const calls = { daily: 0, today: 0, quote: 0 };
  const n = {
    daily: async () => {
      calls.daily++;
      if (opts.fail) throw new MarketError('EXCHANGE_ERROR', 'Nasdaq: HTTP 503');
      return Array.from({ length: 300 }, (_, i) => ({ t: Date.parse('2026-01-01T05:00:00Z') + i * 86_400_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }));
    },
    today: async () => {
      calls.today++;
      return null;
    },
    quote: async (sym: string, now: number) => {
      calls.quote++;
      if (opts.fail) throw new MarketError('UNKNOWN_SYMBOL', `${sym} nu e listat la Nasdaq / NYSE`);
      return { symbol: sym, name: 'Apple Inc. Common Stock', last: 340.97, change: 4.33, changePct: 1.29, status: 'Closed', fetchedAt: now };
    },
    marketStatus: async (now: number) => ({ state: opts.status ?? 'open', label: 'Market Open', opensAt: null, closesAt: null, fetchedAt: now }),
    search: async () => [{ symbol: 'AAPL', name: 'Apple Inc. Common Stock', exchange: 'NASDAQ-GS', type: 'Acțiune' }],
    earnings: async () => [],
    ndx: async (now: number) => ({ last: 30664.7, changePct: -0.71, fetchedAt: now }),
  };
  return { n: n as unknown as NasdaqClient, calls, opts };
}

describe('StockData', () => {
  it('has 1d and 1w without a key, everything Twelve Data has with one', () => {
    expect(stockTimeframes(false)).toEqual(['1d', '1w']);
    expect(stockTimeframes(true)).toEqual(['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']);
  });

  it('asks for the key on intraday timeframes', async () => {
    const s = new StockData({ key: async () => null, nasdaq: fakeNasdaq().n });
    await expect(s.candles('AAPL', '1h', 100, 1)).rejects.toMatchObject({ code: 'UNSUPPORTED_TIMEFRAME' });
    await expect(s.candles('aapl!', '1d', 100, 1)).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL' });
  });

  it('suggests listed symbols for one the source does not know', async () => {
    const f = fakeNasdaq();
    const n = f.n as unknown as { daily: () => Promise<never>; search: (q: string) => Promise<unknown[]> };
    n.daily = async () => Promise.reject(new MarketError('UNKNOWN_SYMBOL', 'FB nu are istoric la Nasdaq'));
    n.search = async () => [
      { symbol: 'FB', name: 'old', exchange: '', type: 'Acțiune' },
      { symbol: 'META', name: 'Meta Platforms, Inc. Class A Common Stock', exchange: 'NASDAQ-GS', type: 'Acțiune' },
    ];
    const s = new StockData({ key: async () => null, nasdaq: f.n });
    await expect(s.candles('FB', '1d', 50, 1)).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL', message: 'FB nu are istoric la Nasdaq; încearcă META', suggestions: ['META'] });
    // The closest spelling first.
    n.search = async () => ['AADX', 'AAOI', 'AAPL', 'APLE'].map((symbol) => ({ symbol, name: symbol, exchange: '', type: 'Acțiune' }));
    await expect(s.candles('APPL', '1d', 50, 1)).rejects.toMatchObject({ suggestions: ['AAPL', 'APLE', 'AADX'] });
    expect(editDistance('APPL', 'AAPL')).toBe(1);
    expect(editDistance('BRK.B', 'BRKB')).toBe(1);
  });

  it('serves daily candles from Nasdaq, cached, and the last ones when Nasdaq fails', async () => {
    let now = Date.parse('2026-10-13T15:00:00Z');
    const f = fakeNasdaq();
    const s = new StockData({ key: async () => null, nasdaq: f.n, now: () => now });
    const a = await s.candles('AAPL', '1d', 100, 1);
    expect(a).toMatchObject({ exchange: 'nasdaq', symbol: 'AAPL', tf: '1d', pricePrecision: 2 });
    expect(a.candles).toHaveLength(100);
    await s.candles('AAPL', '1d', 100, 1);
    expect(f.calls.daily).toBe(1);
    // Weekly bars come from the same daily history.
    const w = await s.candles('AAPL', '1w', 20, 1);
    expect(w.candles.length).toBeLessThanOrEqual(20);
    now += 16 * 60_000;
    f.opts.fail = true;
    const stale = await s.candles('AAPL', '1d', 100, 1);
    expect(stale.fetchedAt).toBeLessThan(now);
    expect(stale.candles).toHaveLength(100);
    expect(stale.notice).toBe('Nasdaq: HTTP 503');
  });

  it('keeps candles read outside the session until it opens again, whatever Nasdaq says about the next open', async () => {
    let now = Date.parse('2026-10-17T15:00:00Z'); // a Saturday
    let state: MarketStatus['state'] = 'closed';
    const f = fakeNasdaq();
    const n = f.n as unknown as { marketStatus: (now: number) => Promise<MarketStatus> };
    // On weekends the "opening time" Nasdaq reports can be in the past: it must not matter.
    n.marketStatus = async (t) => ({ state, label: '', opensAt: Date.parse('2026-10-16T13:30:00Z'), closesAt: null, fetchedAt: t });
    const s = new StockData({ key: async () => null, nasdaq: f.n, now: () => now });
    await s.candles('AAPL', '1d', 50, 1);
    now += 30 * 3_600_000;
    await s.candles('AAPL', '1d', 50, 1);
    expect(f.calls.daily).toBe(1);
    // Monday's pre-market is still outside the session; the open brings fresh candles.
    state = 'pre';
    now = Date.parse('2026-10-19T12:00:00Z');
    await s.candles('AAPL', '1d', 50, 1);
    expect(f.calls.daily).toBe(1);
    state = 'open';
    now = Date.parse('2026-10-19T13:40:00Z');
    await s.candles('AAPL', '1d', 50, 1);
    expect(f.calls.daily).toBe(2);
    // Read during the session: the short TTL applies, then one more read after the close.
    now += 16 * 60_000;
    await s.candles('AAPL', '1d', 50, 1);
    expect(f.calls.daily).toBe(3);
  });

  it('FIX-SESSIONOPEN: the announced open counts at once (a "pre" read at 9:29 is not kept until 9:34), then the close', async () => {
    const open = Date.parse('2026-11-20T14:30:00Z'); // 9:30 New York
    const close = Date.parse('2026-11-20T21:00:00Z'); // 16:00
    let now = open - 60_000;
    let state: MarketStatus['state'] = 'pre';
    let reads = 0;
    const f = fakeNasdaq();
    const n = f.n as unknown as { marketStatus: (now: number) => Promise<MarketStatus> };
    n.marketStatus = async (t) => (reads++, { state, label: state, opensAt: open, closesAt: close, fetchedAt: t });
    const s = new StockData({ key: async () => null, nasdaq: f.n, now: () => now });
    expect((await s.marketStatus())?.state).toBe('pre');
    // The open has passed: open by the clock, though Nasdaq still says "pre" (it is asked again every 20 s, not 5 min).
    now = open + 5_000;
    expect((await s.confirmedStatus())?.state).toBe('open');
    expect(reads).toBe(2);
    now += 10_000;
    expect((await s.marketStatus())?.state).toBe('open');
    expect(reads).toBe(2);
    now += 15_000;
    state = 'open';
    expect((await s.marketStatus())?.state).toBe('open');
    expect(reads).toBe(3);
    // Nasdaq agrees: the normal 5 minutes again.
    now += 4 * 60_000;
    await s.marketStatus();
    expect(reads).toBe(3);
    // The close passed: no longer open, by the clock.
    now = close + 1_000;
    expect((await s.marketStatus())?.state).toBe('after');
    // A state read after the close names the day's open, already past: no reason to ask again before 5 minutes.
    state = 'after';
    now = close + 2 * 3_600_000;
    await s.marketStatus();
    const r = reads;
    now += 60_000;
    expect((await s.marketStatus())?.state).toBe('after');
    expect(reads).toBe(r);
  });

  it('does not trust a market state Nasdaq could not confirm for a while', async () => {
    let now = Date.parse('2026-10-17T15:00:00Z');
    let down = false;
    const f = fakeNasdaq({ status: 'closed' });
    const n = f.n as unknown as { marketStatus: (now: number) => Promise<MarketStatus> };
    n.marketStatus = async (t) => {
      if (down) throw new Error('HTTP 403');
      return { state: 'closed', label: '', opensAt: null, closesAt: null, fetchedAt: t };
    };
    const s = new StockData({ key: async () => null, nasdaq: f.n, now: () => now });
    await s.candles('AAPL', '1d', 50, 1);
    // Nasdaq's state stops answering over the weekend; on Monday the chart refreshes on its normal TTL.
    down = true;
    now = Date.parse('2026-10-19T14:00:00Z');
    await s.candles('AAPL', '1d', 50, 1);
    expect(f.calls.daily).toBe(2);
  });

  it('keeps quotes 15 minutes while the market is closed', async () => {
    let now = Date.parse('2026-10-17T15:00:00Z');
    const f = fakeNasdaq({ status: 'closed' });
    const s = new StockData({ key: async () => null, nasdaq: f.n, now: () => now });
    await s.marketStatus();
    await s.quote('AAPL');
    now += 10 * 60_000;
    await s.marketStatus();
    await s.quote('AAPL');
    expect(f.calls.quote).toBe(1);
    now += 6 * 60_000;
    await s.marketStatus();
    await s.quote('AAPL');
    expect(f.calls.quote).toBe(2);
  });

  it('caches quotes a minute and keeps the last one on errors', async () => {
    let now = Date.parse('2026-10-13T15:00:00Z');
    const f = fakeNasdaq();
    const s = new StockData({ key: async () => null, nasdaq: f.n, now: () => now });
    expect((await s.quote('AAPL')).last).toBe(340.97);
    await s.quote('AAPL');
    expect(f.calls.quote).toBe(1);
    now += 61_000;
    f.opts.fail = true;
    expect((await s.quote('AAPL')).last).toBe(340.97);
    await expect(s.quote('MSFT')).rejects.toThrow(/nu e listat/);
  });

  it('FIX-BOTPRICE: a bot\'s look takes a quote at most 25 s old; the others keep a minute', async () => {
    let now = Date.parse('2026-10-13T15:00:00Z');
    const f = fakeNasdaq();
    const s = new StockData({ key: async () => null, nasdaq: f.n, now: () => now });
    await s.quote('AAPL', 25_000);
    now += 20_000;
    await s.quote('AAPL', 25_000);
    expect(f.calls.quote).toBe(1);
    now += 10_000;
    await s.quote('AAPL');
    expect(f.calls.quote).toBe(1);
    await s.quote('AAPL', 25_000);
    expect(f.calls.quote).toBe(2);
  });
});

describe('stock market context', () => {
  const cnn = {
    fear_and_greed: { score: 45.4, rating: 'neutral', timestamp: '2026-10-13T00:00:00+00:00', previous_close: 45.7, previous_1_week: 46.8 },
    fear_and_greed_historical: { data: [{ x: 1791763200000, y: 44 }, { x: 1791849600000, y: 45.4 }, { x: 1791849600000, y: 45.4 }] },
    market_momentum_sp500: { data: [{ x: 1791590400000, y: 7811.54 }, { x: 1791763200000, y: 7807.24 }, { x: 1791837301000, y: 7807.24 }] },
    market_volatility_vix: { data: [{ x: 1791590400000, y: 14.84 }, { x: 1791763200000, y: 15.21 }] },
  };

  it('reads CNN: one value a day, the change against the day before', () => {
    const r = parseCnn(cnn);
    expect(r.fearGreed).toMatchObject({ value: 45, rating: 'neutral', previousClose: 45.7 });
    expect(r.fearGreed.history).toEqual([
      { value: 44, timestamp: 1791763200000 },
      { value: 45.4, timestamp: 1791849600000 },
    ]);
    const spx = r.indices.find((i) => i.id === 'SPX');
    expect(spx?.last).toBe(7807.24);
    expect(spx?.changePct).toBeCloseTo(((7807.24 - 7811.54) / 7811.54) * 100, 6);
    expect(r.indices.find((i) => i.id === 'VIX')?.last).toBe(15.21);
  });

  it('stores the state always, CNN and the Nasdaq-100 hourly while the market is closed', async () => {
    const db = await testDb();
    let now = Date.parse('2026-10-13T06:00:00Z');
    const f = fakeNasdaq({ status: 'closed' });
    const s = new StockData({ key: async () => null, nasdaq: f.n, now: () => now });
    let cnnCalls = 0;
    const fetchCnn = async () => {
      cnnCalls++;
      return cnn;
    };
    expect(await refreshStockContext(db, s, now, fetchCnn)).toEqual([]);
    const ctx = await readStockContext(db);
    expect(ctx.market?.state).toBe('closed');
    expect(ctx.indices?.items.map((i) => i.id)).toEqual(['SPX', 'NDX', 'VIX']);
    expect(ctx.fearGreed?.value).toBe(45);
    now += 10 * 60_000;
    await refreshStockContext(db, s, now, fetchCnn);
    expect(cnnCalls).toBe(1);
    // A failing source keeps its last value.
    now += 61 * 60_000;
    await expect(refreshStockContext(db, s, now, async () => Promise.reject(new Error('HTTP 418')))).resolves.toEqual(['cnn fear&greed: HTTP 418']);
    expect((await readStockContext(db)).indices?.items.find((i) => i.id === 'SPX')?.last).toBe(7807.24);
  });
});
