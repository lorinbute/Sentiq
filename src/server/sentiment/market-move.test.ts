// FD-MARKETMOVE: the stock market's reaction in the stocks part of the index (and the day's): the move in normal days, its
// score and share, the freshness after the close, the tape read from the index data, and no day frozen without it.
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../shared/indicator/slingshot.ts';
import { addDays, dayBounds, dayKey, zonedTimeToUtc } from '../../shared/time.ts';
import { testDb } from '../test/db.ts';
import { SecretBox } from '../secrets/crypto.ts';
import { SettingsService } from '../settings.ts';
import { readJobData } from '../jobs/scheduler.ts';
import { computeIndex, DEFAULT_INDEX_PARAMS, effects, explainIndex, indexValue, intradaySeries, toIndex, type IndexItem } from './daily-index.ts';
import { DAILY_JOB, DailySentimentService, INDEX_VERSION } from './daily.ts';
import { cryptoAt, KEEP_HISTORY_MS, MARKET_RULES, MarketMoves, marketAt, sessionsOf, TAPE_TTL_MS, type CryptoSeries, type MarketSeries, type MarketTape } from './market-move.ts';

const NY = 'America/New_York';
const H = 3_600_000;
const P = DEFAULT_INDEX_PARAMS;

/** `n` weekdays (New York) up to and including `last`, oldest first. */
function weekdays(last: string, n: number): string[] {
  const out: string[] = [];
  for (let d = last; out.length < n; d = addDays(d, -1)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.unshift(d);
  }
  return out;
}

/** Daily bars of the sessions `days`: alternately ±`typical` from 100, the last one moving `last` (a fraction). */
function daily(days: string[], typical: number, last: number): Candle[] {
  let c = 100;
  return days.map((day, i) => {
    if (i > 0) c *= 1 + (i === days.length - 1 ? last : i % 2 ? typical : -typical);
    return { t: zonedTimeToUtc(day, NY), o: c, h: c, l: c, c, v: 0 };
  });
}

const DAY = '2026-11-20'; // a Friday
const DAYS = weekdays(DAY, 70);
const at = (h: number, m = 0, day = DAY) => zonedTimeToUtc(day, NY, h, m);

/** S&P 500 −2% (4 normal days of 0,5%) and Nasdaq 100 −3% (3 normal days of 1%) on `DAY`; 30-minute bars from 9:30. */
function crashTape(opts: { bars?: boolean } = {}): MarketTape {
  const make = (id: string, name: string, typical: number, last: number): MarketSeries => {
    const sessions = sessionsOf(daily(DAYS, typical, last));
    const s = sessions.at(-1);
    // Bars: the price walks linearly from the previous close to the close over the session.
    const bars = opts.bars === false || !s ? [] : Array.from({ length: 13 }, (_, k) => ({ end: s.openAt + (k + 1) * 30 * 60_000, close: s.prevClose + ((s.close - s.prevClose) * (k + 1)) / 13 }));
    return { id, name, sessions, bars };
  };
  return { series: [make('^SPX', 'S&P 500', 0.005, -0.02), make('^NDX', 'Nasdaq 100', 0.01, -0.03)] };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Now, for the coins: 20 Nov 2026, 15:20 UTC (inside an hourly candle). */
const NOW_C = Date.UTC(2026, 10, 20, 15, 20);

/**
 * BTC and ETH: 70 complete UTC days alternating ±`typical` (BTC 1%, ETH 2%), then hourly candles of the last 3 days:
 * flat until 24 hours ago, then down `last` (BTC −6%, ETH −8%) by now; the newest candle is the one forming.
 */
function coinTape(o: { last?: [number, number]; stale?: boolean } = {}): CryptoSeries[] {
  const [btc, eth] = o.last ?? [-0.06, -0.08];
  const make = (id: string, typical: number, last: number): CryptoSeries => {
    const today = Math.floor(NOW_C / DAY_MS) * DAY_MS;
    let c = 100;
    const days = Array.from({ length: 71 }, (_, i) => {
      if (i > 0) c *= 1 + (i % 2 ? typical : -typical);
      return { t: today - (70 - i) * DAY_MS, o: c, h: c, l: c, c, v: 0 };
    });
    const base = days.at(-2)?.c as number;
    const end = o.stale ? NOW_C - 5 * HOUR_MS : NOW_C;
    const first = Math.floor(end / HOUR_MS) * HOUR_MS - 72 * HOUR_MS;
    const hours = Array.from({ length: 73 }, (_, k) => {
      const t = first + k * HOUR_MS;
      // The price at the candle's close (its end), or now for the one forming.
      const at = Math.min(t + HOUR_MS, end);
      const into = Math.max(0, Math.min(1, (at - (NOW_C - 24 * HOUR_MS)) / (24 * HOUR_MS)));
      const px = base * (1 + last * into);
      return { t, o: px, h: px, l: px, c: px, v: 0 };
    });
    return { id, name: id, hours, days };
  };
  return [make('BTC', 0.01, btc), make('ETH', 0.02, eth)];
}

describe('the market move, in normal days (FD-MARKETMOVE)', () => {
  it("a session's normal day is the median move of the 60 before it; none with fewer than 20", () => {
    const s = sessionsOf(daily(DAYS, 0.005, -0.02));
    expect(s).toHaveLength(69);
    expect(s.slice(0, 20).every((x) => x.typical === null)).toBe(true);
    expect(s[20]?.typical).toBeCloseTo(0.005, 12);
    const last = s.at(-1);
    expect(last).toMatchObject({ day: DAY, openAt: at(9, 30), closeAt: at(16) });
    expect(last?.typical).toBeCloseTo(0.005, 12);
    expect(last && last.close / last.prevClose - 1).toBeCloseTo(-0.02, 12);
  });

  it('during the session: each index in normal days, their mean, the score and the share', () => {
    const m = marketAt(crashTape({ bars: false }), at(16) - 1, P);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.live).toBe(true);
    expect(m.closedAt).toBeNull();
    expect(m.day).toBe(DAY);
    expect(m.indices.map((i) => [i.name, Number(i.changePct.toFixed(6)), Number(i.typicalPct.toFixed(6)), Number(i.z.toFixed(6))])).toEqual([
      ['S&P 500', -2, 0.5, -4],
      ['Nasdaq 100', -3, 1, -3],
    ]);
    expect(m.move).toBeCloseTo(-3.5, 9);
    expect(m.sentiment).toBeCloseTo(Math.tanh(-3.5 / MARKET_RULES.scale), 12);
    expect(m.strength).toBeCloseTo(3.5 / (3.5 + MARKET_RULES.strength), 12);
    expect(m.decay).toBe(1);
    expect(m.share).toBeCloseTo(0.7, 12);
    expect(m.value).toBeCloseTo(50 + 50 * Math.tanh(P.gamma * m.sentiment), 12);
    expect(m.value).toBeLessThan(10);
  });

  it("the user's reference: a bad day for the S&P 500 is −0,5%, one normal day; a calm day weighs little", () => {
    const one = { series: [{ id: '^SPX', name: 'S&P 500', sessions: sessionsOf(daily(DAYS, 0.005, -0.005)), bars: [] }] };
    const m = marketAt(one, at(12), P);
    expect(m?.move).toBeCloseTo(-1, 9);
    expect(m?.strength).toBeCloseTo(0.4, 12);
    const calm = marketAt({ series: [{ ...one.series[0], sessions: sessionsOf(daily(DAYS, 0.005, 0.001)) }] as MarketSeries[] }, at(12), P);
    expect(calm?.move).toBeCloseTo(0.2, 9);
    expect(calm?.share).toBeLessThan(0.12);
    // The same rally up as the crash down: the mirror image.
    const up = marketAt({ series: [{ ...one.series[0], sessions: sessionsOf(daily(DAYS, 0.005, 0.005)) }] as MarketSeries[] }, at(12), P);
    expect(up?.move).toBeCloseTo(1, 9);
    expect((up?.value ?? 0) - 50).toBeCloseTo(50 - (m?.value ?? 0), 9);
  });

  it("a past hour reads the 30-minute bar ended by then; after the last bar, the live price; before the first, the open", () => {
    const tape = crashTape();
    const spx = tape.series[0] as MarketSeries;
    const s = spx.sessions.at(-1);
    if (!s) throw new Error('no session');
    // 10:00: the first bar (9:30–10:00) ended: 1/13 of the way.
    expect(marketAt(tape, at(10), P)?.indices[0]?.changePct).toBeCloseTo(-2 / 13, 9);
    // 9:45: no bar ended yet: the open (here the previous close).
    expect(marketAt(tape, at(9, 45), P)?.indices[0]?.changePct).toBeCloseTo((s.open / s.prevClose - 1) * 100, 9);
    // Past the last bar of a session still on (the bars stop at 12:00): the live price, `close`.
    const short = { series: [{ ...spx, bars: spx.bars.slice(0, 5) }] };
    expect(marketAt(short, at(12, 10), P)?.indices[0]?.changePct).toBeCloseTo(-2, 9);
    // Without bars: the last price at any hour of the session.
    expect(marketAt(crashTape({ bars: false }), at(10), P)?.indices[0]?.changePct).toBeCloseTo(-2, 9);
  });

  it('after the close the reaction stays; its share halves every 8 hours, until the next session opens', () => {
    const tape = crashTape();
    const close = at(16);
    const after = marketAt(tape, close + 8 * H, P);
    expect(after).toMatchObject({ live: false, closedAt: close, day: DAY });
    expect(after?.move).toBeCloseTo(-3.5, 9);
    expect(after?.decay).toBeCloseTo(0.5, 12);
    expect(after?.share).toBeCloseTo(0.35, 12);
    // Over the weekend, little is left by Sunday.
    expect(marketAt(tape, close + 56 * H, P)?.share).toBeLessThan(0.01);
    // The morning before: the session before, decayed.
    const before = marketAt(tape, at(9), P);
    expect(before?.day).toBe(DAYS.at(-2));
    expect(before?.live).toBe(false);
  });

  it('an index a day behind is left out (two days never mixed); no data, no index of its own: no reaction', () => {
    const tape = crashTape({ bars: false });
    const ndx = tape.series[1] as MarketSeries;
    const behind = { series: [tape.series[0] as MarketSeries, { ...ndx, sessions: ndx.sessions.slice(0, -1) }] };
    const m = marketAt(behind, at(15), P);
    expect(m?.indices.map((i) => i.name)).toEqual(['S&P 500']);
    expect(m?.move).toBeCloseTo(-4, 9);
    expect(marketAt(null, at(15), P)).toBeNull();
    expect(marketAt({ series: [] }, at(15), P)).toBeNull();
    // Fewer than 20 sessions before: no normal day yet.
    const young = { series: [{ id: '^SPX', name: 'S&P 500', sessions: sessionsOf(daily(DAYS.slice(-15), 0.005, -0.02)), bars: [] }] };
    expect(marketAt(young, at(15), P)).toBeNull();
  });
});

describe('crypto: BTC and ETH over 24 hours (FD-MARKETMOVE)', () => {
  it('the move over the last 24 hours in normal days (the median daily move of the 60 complete days before), always live', () => {
    const m = cryptoAt({ series: [], crypto: coinTape() }, NOW_C, P);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m).toMatchObject({ area: 'crypto', live: true, closedAt: null, decay: 1, day: '2026-11-20' });
    expect(m.indices.map((i) => [i.name, Number(i.changePct.toFixed(6)), Number(i.typicalPct.toFixed(6)), Number(i.z.toFixed(6))])).toEqual([
      ['BTC', -6, 1, -6],
      ['ETH', -8, 2, -4],
    ]);
    expect(m.move).toBeCloseTo(-5, 9);
    expect(m.share).toBeCloseTo(5 / 6.5, 12);
    expect(m.sentiment).toBeCloseTo(Math.tanh(-5 / MARKET_RULES.scale), 12);
  });

  it('a past hour: the close of the candle ended by then; a stale source or too few days: no reaction', () => {
    const tape = { series: [], crypto: coinTape() };
    // 12 hours ago: half of the fall.
    const half = cryptoAt(tape, Math.floor(NOW_C / HOUR_MS) * HOUR_MS - 12 * HOUR_MS + 20 * 60_000, P);
    expect(half?.indices[0]?.changePct).toBeLessThan(-2.5);
    expect(half?.indices[0]?.changePct).toBeGreaterThan(-3.5);
    expect(cryptoAt({ series: [], crypto: coinTape({ stale: true }) }, NOW_C, P)).toBeNull();
    const young = coinTape().map((c) => ({ ...c, days: c.days.slice(-15) }));
    expect(cryptoAt({ series: [], crypto: young }, NOW_C, P)).toBeNull();
    expect(cryptoAt(null, NOW_C, P)).toBeNull();
  });

  it('into the crypto part and the day, beside the stocks one; a rise the other way', () => {
    const w = dayBounds('2026-11-20', 'Europe/Bucharest');
    const items = [
      ...Array.from({ length: 10 }, () => ({ ...item({ category: 'crypto', sentiment: 0.1 }), publishedAt: NOW_C - 2 * HOUR_MS })),
      ...Array.from({ length: 10 }, () => ({ ...item({ sentiment: 0.1 }), publishedAt: NOW_C - 2 * HOUR_MS })),
    ];
    const plain = computeIndex(items, w, NOW_C);
    const r = computeIndex(items, w, NOW_C, P, { series: [], crypto: coinTape() });
    const c = r.crypto;
    expect(c).not.toBeNull();
    if (!c) return;
    expect(r.market).toBeNull();
    expect(c.weight).toBeCloseTo((c.share / (1 - c.share)) * plain.breakdown.crypto.weight, 9);
    expect(r.breakdown.crypto.raw).toBeCloseTo((1 - c.share) * plain.breakdown.crypto.raw + c.share * c.sentiment, 12);
    expect(r.breakdown.crypto.index).toBeLessThan(15);
    expect(r.breakdown.stocks).toEqual(plain.breakdown.stocks);
    expect(c.news).toBe(plain.breakdown.crypto.index);
    // Both markets at once: each its own part; the day takes both weights.
    const both = computeIndex(items, w, asOfBoth(), P, { ...crashTapeAt(), crypto: coinTape() });
    expect(both.market?.area).toBe('stocks');
    expect(both.crypto?.area).toBe('crypto');
    expect((both.market?.dayShare ?? 0) + (both.crypto?.dayShare ?? 0)).toBeCloseTo(((both.market?.weight ?? 0) + (both.crypto?.weight ?? 0)) / both.weight, 12);
    const e = explainIndex(items, w, asOfBoth(), P, { ...crashTapeAt(), crypto: coinTape() });
    expect([e.market, e.crypto]).toEqual([both.market, both.crypto]);
    expect(e.total.index).toBe(both.index);
    const up = computeIndex(items, w, NOW_C, P, { series: [], crypto: coinTape({ last: [0.06, 0.08] }) });
    expect(up.breakdown.crypto.index).toBeGreaterThan(80);
  });
});

/** The stock crash tape, shifted to 20 Nov (its own `DAY`), and a moment inside its session that the coins also cover. */
const crashTapeAt = () => crashTape({ bars: false });
const asOfBoth = () => NOW_C;

const window = dayBounds(DAY, 'Europe/Bucharest');
const asOf = at(15); // 22:00 in Bucharest

let seq = 0;
function item(over: Partial<IndexItem> = {}): IndexItem {
  seq++;
  return {
    id: `n${seq}`,
    title: `t${seq}`,
    url: null,
    sourceId: `s${seq % 5}`,
    sourceName: `S${seq % 5}`,
    sourceWeight: 1,
    category: 'stocks',
    publishedAt: asOf - 2 * H,
    relevance: 1,
    impact: 1,
    flags: [],
    clusterId: `c${seq}`,
    sentiment: 0.2,
    ...over,
  };
}

describe('the reaction in the index (FD-MARKETMOVE)', () => {
  const items = [...Array.from({ length: 20 }, () => item()), ...Array.from({ length: 6 }, () => item({ category: 'crypto', sentiment: -0.4 }))];

  it('one more item of the stocks part, with its share of it; the day takes it with its weight', () => {
    const plain = computeIndex(items, window, asOf);
    const r = computeIndex(items, window, asOf, P, crashTape({ bars: false }));
    const m = r.market;
    expect(plain.market).toBeNull();
    expect(m).not.toBeNull();
    if (!m) return;
    const ws = plain.breakdown.stocks.weight;
    expect(ws).toBeGreaterThan(P.shrinkK);
    expect(m.weight).toBeCloseTo((0.7 / 0.3) * ws, 9);
    // The stocks part: (1 − share) × the news' mean + share × the reaction's score.
    expect(r.breakdown.stocks.raw).toBeCloseTo(0.3 * plain.breakdown.stocks.raw + 0.7 * m.sentiment, 12);
    expect(r.breakdown.stocks.weight).toBeCloseTo(ws + m.weight, 9);
    expect(r.breakdown.stocks.count).toBe(20);
    expect(r.breakdown.stocks.index).toBe(toIndex(r.breakdown.stocks.raw, r.breakdown.stocks.weight, P));
    expect(m.news).toBe(plain.breakdown.stocks.index);
    // Positive news, a market in panic: the part goes very negative.
    expect(plain.breakdown.stocks.index).toBeGreaterThan(60);
    expect(r.breakdown.stocks.index).toBeLessThan(25);
    // The day: the same item, with its weight among all the news.
    expect(r.weight).toBeCloseTo(plain.weight + m.weight, 9);
    expect(r.raw).toBeCloseTo((plain.raw * plain.weight + m.sentiment * m.weight) / (plain.weight + m.weight), 12);
    expect(m.dayShare).toBeCloseTo(m.weight / r.weight, 12);
    expect(r.index).toBeLessThan(plain.index);
    // The other parts and the drivers are the news'.
    expect(r.breakdown.crypto).toEqual(plain.breakdown.crypto);
    expect(r.drivers).toEqual(plain.drivers);
  });

  it('few stock news: the reaction weighs at least as much as `shrinkK` of news; none: the part waits for the first', () => {
    const one = [item({ impact: 1, relevance: 0.5 }), item({ category: 'crypto' })];
    const r = computeIndex(one, window, asOf, P, crashTape({ bars: false }));
    expect(r.market?.weight).toBeCloseTo((0.7 / 0.3) * P.shrinkK, 9);
    const none = [item({ category: 'crypto' })];
    const n = computeIndex(none, window, asOf, P, crashTape());
    expect(n.market).toBeNull();
    expect(n.index).toBe(computeIndex(none, window, asOf).index);
  });

  it('"Cum s-a calculat?" and each item\'s effect: the same numbers, with the market', () => {
    const tape = crashTape();
    const r = computeIndex(items, window, asOf, P, tape);
    const e = explainIndex(items, window, asOf, P, tape);
    expect(e.total).toMatchObject({ raw: r.raw, weight: r.weight, index: r.index, confidence: r.confidence });
    expect(e.market).toEqual(r.market);
    expect(e.breakdown).toEqual(r.breakdown);
    const plain = explainIndex(items, window, asOf);
    expect(e.news).toEqual({ raw: plain.total.raw, weight: plain.total.weight });
    expect(e.items.reduce((a, it) => a + it.contribution, 0)).toBeCloseTo(e.news.raw, 12);
    const id = items[0]?.id as string;
    const fx = effects(items, window, asOf, [id], P, tape).get(id);
    const without = computeIndex(items.filter((it) => it.id !== id), window, asOf, P, tape);
    expect(fx?.without).toBeCloseTo(indexValue(without.raw, without.weight, P), 12);
    expect(fx?.effect).toBeCloseTo(indexValue(r.raw, r.weight, P) - (fx?.without ?? 0), 12);
  });

  it("the hourly points: each hour with that hour's reaction (before the open the session before, decayed)", () => {
    const tape = crashTape();
    const series = intradaySeries(items.map((it) => ({ ...it, publishedAt: window.start + H })), window, asOf, P, tape);
    const plainSeries = intradaySeries(items.map((it) => ({ ...it, publishedAt: window.start + H })), window, asOf);
    const byT = (t: number) => series.find((x) => x.t === t)?.index;
    // 16:00 in Bucharest (9:00 New York): the session before (−1 normal day, the alternation), decayed.
    const morning = marketAt(tape, at(9), P);
    expect(morning?.move).toBeCloseTo(-1, 9);
    expect(morning?.decay).toBeCloseTo(Math.pow(0.5, 17 / 8), 9);
    // During the session the index falls with the market.
    expect(byT(at(15)) as number).toBeLessThan(byT(at(10)) as number);
    expect(byT(at(15)) as number).toBeLessThan(plainSeries.find((x) => x.t === at(15))?.index as number);
  });
});

describe('the tape from the index data (FD-MARKETMOVE)', () => {
  /** Index data as `IndexData` gives it; `today`: the history has today's bar. */
  function deps(o: { now: number; today?: boolean; quote?: { last: number; change: number } | null; fail?: string[] }) {
    const calls = { history: 0 };
    const hist = (id: string) => {
      const typical = id === '^SPX' ? 0.005 : 0.01;
      const bars = daily(DAYS, typical, -0.02);
      return o.today === false ? bars.slice(0, -1) : bars;
    };
    return {
      calls,
      d: {
        now: () => o.now,
        history: async (id: string) => {
          calls.history++;
          if (o.fail?.includes(id)) throw new Error('down');
          return { candles: hist(id) };
        },
        intraday: async () => [{ t: at(9, 30), o: 99, h: 99, l: 99, c: 99, v: 0 }],
        quote: async (id: string) => {
          if (o.quote === null) throw new Error('no quote');
          const bars = hist(id);
          return o.quote ?? { last: (bars.at(-1) as Candle).c * 0.99, change: 0 };
        },
      },
    };
  }

  it("today's last price from the live quote; a bar ended only", async () => {
    const now = at(12);
    const { d } = deps({ now });
    const tape = await new MarketMoves(d).tape();
    const spx = tape?.series[0];
    const hist = daily(DAYS, 0.005, -0.02);
    expect(spx?.sessions.at(-1)?.close).toBeCloseTo((hist.at(-1) as Candle).c * 0.99, 9);
    expect(spx?.bars).toEqual([{ end: at(10), close: 99 }]);
  });

  it("today's session while the history has no bar of it yet: from the quote measured from the history's last close", async () => {
    const hist = daily(DAYS, 0.005, -0.02).slice(0, -1);
    const prev = (hist.at(-1) as Candle).c;
    const now = at(12);
    const live = await new MarketMoves(deps({ now, today: false, quote: { last: prev * 0.98, change: prev * 0.98 - prev } }).d).tape();
    const s = live?.series[0]?.sessions.at(-1);
    expect(s?.day).toBe(DAY);
    expect(s && s.close / s.prevClose - 1).toBeCloseTo(-0.02, 9);
    expect(s?.open).toBe(99);
    // A quote measured from an older close (a holiday, before the open): no session of today.
    const old = await new MarketMoves(deps({ now, today: false, quote: { last: prev, change: prev * 0.01 } }).d).tape();
    expect(old?.series[0]?.sessions.at(-1)?.day).toBe(DAYS.at(-2));
    // Before 9:30: none either.
    const early = await new MarketMoves(deps({ now: at(9), today: false, quote: { last: prev * 0.98, change: prev * 0.98 - prev } }).d).tape();
    expect(early?.series[0]?.sessions.at(-1)?.day).toBe(DAYS.at(-2));
  });

  it('an index whose data fails is left out; none: no tape; read again after the TTL', async () => {
    let now = at(12);
    const one = deps({ now, fail: ['^NDX'] });
    one.d.now = () => now;
    const moves = new MarketMoves(one.d);
    expect((await moves.tape())?.series.map((x) => x.id)).toEqual(['^SPX']);
    await moves.tape();
    expect(one.calls.history).toBe(2);
    now += TAPE_TTL_MS;
    await moves.tape();
    expect(one.calls.history).toBe(4);
    expect(await new MarketMoves(deps({ now, fail: ['^SPX', '^NDX'] }).d).tape()).toBeNull();
  });

  it('the coins from the exchange; a failed read keeps their last good candles for 15 minutes', async () => {
    let now = NOW_C;
    let down = false;
    const coins = coinTape();
    const d = {
      now: () => now,
      history: async () => {
        throw new Error('no stocks here');
      },
      intraday: async () => [],
      quote: async () => ({ last: null, change: null }),
      crypto: async (symbol: string, tf: '1h' | '1d') => {
        if (down) throw new Error('down');
        const c = coins.find((x) => symbol.startsWith(x.id)) as CryptoSeries;
        return tf === '1h' ? c.hours : c.days;
      },
    };
    const moves = new MarketMoves(d);
    const first = await moves.tape();
    expect(first?.series).toEqual([]);
    expect(first?.crypto?.map((c) => c.id)).toEqual(['BTC', 'ETH']);
    down = true;
    now += TAPE_TTL_MS;
    expect((await moves.tape())?.crypto?.[0]?.hours).toBe(coins[0]?.hours);
    now += KEEP_HISTORY_MS;
    expect(await moves.tape()).toBeNull();
  });

  it('a failed read keeps the last good bars, and the history for 15 minutes', async () => {
    let now = at(12);
    let down = false;
    const bar = (h: number, c: number) => ({ t: at(h), o: c, h: c, l: c, c, v: 0 });
    const d = {
      now: () => now,
      history: async () => {
        if (down) throw new Error('down');
        return { candles: daily(DAYS, 0.005, -0.02) };
      },
      intraday: async () => {
        if (down) throw new Error('down');
        return [bar(10, 98), bar(10.5, 97)];
      },
      quote: async () => ({ last: 97, change: null }),
    };
    const moves = new MarketMoves(d);
    const first = await moves.tape();
    expect(first?.series[0]?.bars).toHaveLength(2);
    down = true;
    now += TAPE_TTL_MS;
    const second = await moves.tape();
    expect(second?.series[0]?.bars).toEqual(first?.series[0]?.bars);
    expect(second?.series[0]?.sessions.at(-1)?.day).toBe(DAY);
    // Past 15 minutes without a history: the index is left out.
    now += KEEP_HISTORY_MS;
    expect(await moves.tape()).toBeNull();
  });
});

describe('no day frozen without the market (FD-MARKETMOVE)', () => {
  async function setup(tape: () => Promise<MarketTape | null>) {
    const db = await testDb();
    const settings = new SettingsService(db, new SecretBox(Buffer.alloc(32, 4)));
    await settings.updateFor(1, true, { timezone: 'UTC' });
    await db.run("INSERT INTO sources(id, name, url, category, builtin) VALUES ('s1', 'Source 1', 'https://s1.example/rss', 'stocks', 0)");
    const now = Date.now();
    const day = addDays(dayKey(now, 'UTC'), -2);
    const t = dayBounds(day, 'UTC').start + 12 * H;
    await db.run(
      `INSERT INTO news(id, source_id, title, published_at, fetched_at, category, relevance, impact, cluster_id, sentiment, sentiment_label, sentiment_engine)
       VALUES ('a', 's1', 'A', ?, ?, 'stocks', 1, 1, 'a', 0.3, 'positive', 'local')`,
      [t, t],
    );
    return { db, now, day, daily: new DailySentimentService(db, settings, null, async () => null, tape) };
  }
  const finalOf = async (db: Awaited<ReturnType<typeof testDb>>, day: string) => (await db.get<{ final: number }>("SELECT final FROM daily_sentiment WHERE tz = 'UTC' AND day = ?", [day]))?.final;

  it('without every index the elapsed days stay provisional; with them they are frozen', async () => {
    let tape: MarketTape | null = null;
    const { db, now, day, daily } = await setup(async () => tape);
    await daily.refreshZone('UTC', now);
    expect(await finalOf(db, day)).toBe(0);
    tape = { series: [crashTape().series[0] as MarketSeries], crypto: coinTape() };
    await daily.refreshZone('UTC', now);
    expect(await finalOf(db, day)).toBe(0);
    // Both indices, no coins: still provisional.
    tape = crashTape();
    await daily.refreshZone('UTC', now);
    expect(await finalOf(db, day)).toBe(0);
    tape = { ...crashTape(), crypto: coinTape() };
    await daily.refreshZone('UTC', now);
    expect(await finalOf(db, day)).toBe(1);
  });

  it('the history is rebuilt with the reaction once the index data is there', async () => {
    let tape: MarketTape | null = null;
    const { db, now, daily } = await setup(async () => tape);
    expect(await daily.upgradeHistory(now)).toBe(false);
    expect((await readJobData(db, DAILY_JOB, { indexVersion: 1 })).indexVersion).toBe(1);
    tape = { ...crashTape(), crypto: coinTape() };
    expect(await daily.upgradeHistory(now)).toBe(true);
    expect((await readJobData(db, DAILY_JOB, { indexVersion: 1 })).indexVersion).toBe(INDEX_VERSION);
  });
});
