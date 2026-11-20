// FD-MARKETMOVE: the stock market's own reaction in the stocks part of the index (and so in the day's). On the worst days
// of the year the news alone stayed near neutral (19 Nov 2026: S&P 500 −2,02%, stocks 53,8; 20 Nov: S&P 500 −2%,
// Nasdaq 100 −3,75%, stocks 40,6), because most of the day's stock news are company news (results, ratings).
//
// Each index's move since the previous close is measured in normal days: the median move of its 60 sessions before
// (S&P 500 ±0,51%, Nasdaq 100 ±0,85% in Nov 2026; the user: „o zi proastă pentru S&P 500 este −0,5”). Their mean, m,
// enters the stocks part as one more item, scored tanh(m / 4), with a share of the part that grows with how rare the move
// is, |m| / (|m| + 1,5): a normal day a little, a panic most of it. After the close the reaction stays what it was and
// its share halves every 8 hours, like a news item's weight.
//
// The same for crypto (the user, after the stocks: „vreau un mecanism similar pentru crypto”): BTC and ETH, a market
// that never closes, so their move over the last 24 hours (the reaction lasts as long as the move is in that window),
// against their normal day (the median daily move of the 60 days before: ±0,91% / ±0,88% in Nov 2026), in the crypto part.
import type { Candle } from '../../shared/indicator/slingshot.ts';
import { dayKey, zonedTimeToUtc } from '../../shared/time.ts';

const NY = 'America/New_York';
const HOUR = 3_600_000;

/** The indices the reaction reads (the two of the Today page's strip), each counting the same. */
export const MARKET_INDICES = [
  { id: '^SPX', name: 'S&P 500' },
  { id: '^NDX', name: 'Nasdaq 100' },
] as const;

/**
 * `sessions`: the sessions a normal day is measured on (their median move), at least `minSessions` of them;
 * `scale`: the move (in normal days) whose score is tanh(1) = 0,76; `strength`: the move at which the reaction has half
 * of the stocks part.
 */
export const MARKET_RULES = { sessions: 60, minSessions: 20, scale: 4, strength: 1.5 } as const;

/** One session of an index (New York day), from its daily bars. */
export interface MarketSession {
  day: string;
  /** 9:30 and 16:00 New York time (an early close is not known: until 16:00 the last price counts as live). */
  openAt: number;
  closeAt: number;
  prevClose: number;
  open: number;
  /** The close; for the session in progress, its last price. */
  close: number;
  /** A normal day's move (a fraction), from the sessions before; null with fewer than `minSessions`. */
  typical: number | null;
}

export interface MarketSeries {
  id: string;
  name: string;
  sessions: MarketSession[];
  /** 30-minute bars that have ended (their end and close), for the past hours of a session; the newest last. */
  bars: { end: number; close: number }[];
}

/** BTC and ETH (FD-MARKETMOVE §crypto), each counting the same, from the admin's default exchange. */
export const CRYPTO_COINS = [
  { id: 'BTC', name: 'BTC', symbol: 'BTC/USDT' },
  { id: 'ETH', name: 'ETH', symbol: 'ETH/USDT' },
] as const;

/** A coin's candles: hourly (the move over 24 hours; the newest may be the one forming) and daily (its normal day), UTC. */
export interface CryptoSeries {
  id: string;
  name: string;
  hours: Candle[];
  days: Candle[];
}

/** What the reaction is read from: every index's sessions and bars; the coins' candles. */
export interface MarketTape {
  series: MarketSeries[];
  crypto?: CryptoSeries[];
}

export interface MarketIndexMove {
  id: string;
  name: string;
  /** The move since the previous close, in percent. */
  changePct: number;
  /** A normal day's move, in percent. */
  typicalPct: number;
  /** changePct ÷ typicalPct: how many normal days. */
  z: number;
}

export interface MarketPoint {
  /** Which part it enters: the US stock market (a session) or crypto (the last 24 hours, never closed). */
  area: 'stocks' | 'crypto';
  /** The New York day of the session read; for crypto, the UTC day. */
  day: string;
  /** The session is still on (its last price); otherwise its close, `closedAt`. */
  live: boolean;
  closedAt: number | null;
  indices: MarketIndexMove[];
  /** m: the indices' mean move in normal days. */
  move: number;
  /** tanh(m / scale): the reaction's score, as a news item's (−1…+1). */
  sentiment: number;
  /** The reaction alone, on the index's 0–100 scale. */
  value: number;
  /** |m| / (|m| + strength). */
  strength: number;
  /** 1 while the session is on; then halved every `halfLifeH` hours. */
  decay: number;
  /** strength × decay: the reaction's share of the stocks part. */
  share: number;
}

/** Median of a non-empty list. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * The sessions of an index from its daily bars (at New York midnight, oldest first): each with its previous close and
 * the median move of the `MARKET_RULES.sessions` before it. The last `keep` only.
 */
export function sessionsOf(daily: Candle[], keep = 400): MarketSession[] {
  const out: MarketSession[] = [];
  const moves: number[] = [];
  for (let k = 1; k < daily.length; k++) {
    const prev = daily[k - 1] as Candle;
    const cur = daily[k] as Candle;
    if (!(prev.c > 0) || !(cur.c > 0)) continue;
    if (k >= daily.length - keep) {
      const last = moves.slice(-MARKET_RULES.sessions);
      const day = dayKey(cur.t, NY);
      out.push({
        day,
        openAt: zonedTimeToUtc(day, NY, 9, 30),
        closeAt: zonedTimeToUtc(day, NY, 16, 0),
        prevClose: prev.c,
        open: cur.o,
        close: cur.c,
        typical: last.length >= MARKET_RULES.minSessions ? median(last) : null,
      });
    }
    moves.push(Math.abs(cur.c / prev.c - 1));
  }
  return out;
}

/** The latest session that had opened by `t`. */
function sessionAt(sessions: MarketSession[], t: number): MarketSession | null {
  for (let i = sessions.length - 1; i >= 0; i--) if ((sessions[i] as MarketSession).openAt <= t) return sessions[i] as MarketSession;
  return null;
}

/**
 * The price of a session still on at `t`: the close of the last 30-minute bar ended by `t`; after the last bar, the live
 * price (`close`); before the first bar ended, the open. Without bars of the session, its last price.
 */
function priceAt(s: MarketSession, bars: MarketSeries['bars'], t: number): number {
  const mine = bars.filter((b) => b.end > s.openAt && b.end <= s.closeAt);
  const lastBar = mine.at(-1);
  if (!lastBar || t > lastBar.end) return s.close;
  let price = s.open;
  for (const b of mine) {
    if (b.end > t) break;
    price = b.close;
  }
  return price;
}

/**
 * The market's reaction at `t`, or null without data. Only the indices of the latest session (a source a day behind
 * would mix two days). `gamma` and `halfLifeH`: the index's own (the same scale and the same freshness as the news).
 */
export function marketAt(tape: MarketTape | null, t: number, p: { gamma: number; halfLifeH: number }): MarketPoint | null {
  if (!tape) return null;
  const found = tape.series
    .map((x) => ({ x, s: sessionAt(x.sessions, t) }))
    .filter((r): r is { x: MarketSeries; s: MarketSession } => r.s !== null && r.s.typical !== null && r.s.typical > 0 && r.s.prevClose > 0);
  if (found.length === 0) return null;
  const day = found.map((r) => r.s.day).sort().at(-1) as string;
  const used = found.filter((r) => r.s.day === day);
  const live = used.some((r) => t < r.s.closeAt);
  const indices = used.map(({ x, s }) => {
    const price = t < s.closeAt ? priceAt(s, x.bars, t) : s.close;
    const change = price / s.prevClose - 1;
    return { id: x.id, name: x.name, changePct: change * 100, typicalPct: (s.typical as number) * 100, z: change / (s.typical as number) };
  });
  const closedAt = live ? null : Math.max(...used.map((r) => r.s.closeAt));
  const decay = closedAt === null ? 1 : Math.pow(0.5, Math.max(0, t - closedAt) / (p.halfLifeH * HOUR));
  return pointOf('stocks', day, closedAt, indices, decay, p);
}

/** The reaction from its moves: their mean in normal days, the score, the strength and (× freshness) the share. */
function pointOf(area: MarketPoint['area'], day: string, closedAt: number | null, indices: MarketIndexMove[], decay: number, p: { gamma: number }): MarketPoint {
  const move = indices.reduce((a, i) => a + i.z, 0) / indices.length;
  const strength = Math.abs(move) / (Math.abs(move) + MARKET_RULES.strength);
  const sentiment = Math.tanh(move / MARKET_RULES.scale);
  return {
    area,
    day,
    live: closedAt === null,
    closedAt,
    indices,
    move,
    sentiment,
    value: 50 + 50 * Math.tanh(p.gamma * sentiment),
    strength,
    decay,
    share: strength * decay,
  };
}

const DAY_MS = 86_400_000;
/** A coin's price is the close of an hourly candle at most this old (stale candles: no reaction rather than an old one). */
const CRYPTO_STALE_MS = 2 * HOUR;

/** A coin's price at `t`: the newest candle's last price while it forms, else the close of the last candle ended by `t`. */
function coinPriceAt(hours: Candle[], t: number): number | null {
  const newest = hours.at(-1);
  if (newest && newest.t <= t && t < newest.t + HOUR) return newest.c > 0 ? newest.c : null;
  let ended: Candle | null = null;
  for (const h of hours) {
    if (h.t + HOUR > t) break;
    ended = h;
  }
  return ended && t - (ended.t + HOUR) <= CRYPTO_STALE_MS && ended.c > 0 ? ended.c : null;
}

/** A coin's normal day before the UTC day of `t`: the median daily move of the `sessions` complete days before it. */
function coinTypical(days: Candle[], t: number): number | null {
  const start = Math.floor(t / DAY_MS) * DAY_MS;
  const closes = days.filter((d) => d.t + DAY_MS <= start && d.c > 0);
  const moves: number[] = [];
  for (let k = 1; k < closes.length; k++) moves.push(Math.abs((closes[k] as Candle).c / (closes[k - 1] as Candle).c - 1));
  const last = moves.slice(-MARKET_RULES.sessions);
  return last.length >= MARKET_RULES.minSessions ? median(last) : null;
}

/** FD-MARKETMOVE (crypto): BTC and ETH over the 24 hours before `t`, in normal days; null without data. Always "live". */
export function cryptoAt(tape: MarketTape | null, t: number, p: { gamma: number }): MarketPoint | null {
  const indices: MarketIndexMove[] = [];
  for (const c of tape?.crypto ?? []) {
    const now = coinPriceAt(c.hours, t);
    const before = coinPriceAt(c.hours, t - 24 * HOUR);
    const typical = coinTypical(c.days, t);
    if (now === null || before === null || typical === null || !(typical > 0)) continue;
    const change = now / before - 1;
    indices.push({ id: c.id, name: c.name, changePct: change * 100, typicalPct: typical * 100, z: change / typical });
  }
  return indices.length ? pointOf('crypto', dayKey(t, 'UTC'), null, indices, 1, p) : null;
}

/** What the reaction needs from the index data (`IndexData`): the daily history, the 30-minute bars, the live quote. */
export interface MarketDeps {
  history(id: string): Promise<{ candles: Candle[] }>;
  intraday(id: string, tf: '30m', count: number): Promise<Candle[]>;
  quote(id: string): Promise<{ last: number | null; change: number | null }>;
  /** A coin's candles from the admin's default exchange (none: no crypto reaction). */
  crypto?: (symbol: string, tf: '1h' | '1d', count: number) => Promise<Candle[]>;
  now: () => number;
}

/** A tape is read again after this long (the quotes are kept 20 s, the bars 30 s, the history 5 min by `IndexData`). */
export const TAPE_TTL_MS = 20_000;
/** 30-minute bars of about a week (13 a session). */
const BARS = 13 * 6;
/** 9:30 New York time, from its midnight (the same on a DST day: the change is at 2:00). */
const OPEN_MS = (9 * 60 + 30) * 60_000;
/** A quote's previous close (last − change) is the history's last close within this (the change is rounded to 0,01). */
const SAME_CLOSE = 2e-4;

/** Hourly candles of 100 days (the history recomputed reaches 90, the news' retention) and daily ones of 200. */
const CRYPTO_HOURS = 24 * 100;
const CRYPTO_DAYS = 200;

/** An index's last good history is used this long when a read of it fails (the sources fail now and then). */
export const KEEP_HISTORY_MS = 15 * 60_000;

/**
 * Reads the tape for the index, at most once per `TAPE_TTL_MS`. A failed read of an index's history uses its last good
 * one for `KEEP_HISTORY_MS`, a failed read of its bars the last good bars (else the past hours of the day would all take
 * the last price and the day's chart would jump); after that the index is left out. Null when none has data (the
 * index then has no market part: it is not frozen, see `DailySentimentService.refreshZone`).
 */
export class MarketMoves {
  private readonly deps: MarketDeps;
  private kept: { tape: MarketTape | null; at: number } | null = null;
  private inflight: Promise<MarketTape | null> | null = null;
  /** Per index: the last history and bars read. */
  private readonly good = new Map<string, { candles: Candle[]; at: number; bars: Candle[] }>();
  /** Per coin: the last candles read. */
  private readonly goodCoins = new Map<string, { hours: Candle[]; days: Candle[]; at: number }>();

  constructor(deps: MarketDeps) {
    this.deps = deps;
  }

  tape(): Promise<MarketTape | null> {
    const k = this.kept;
    if (k && this.deps.now() - k.at < TAPE_TTL_MS) return Promise.resolve(k.tape);
    if (this.inflight) return this.inflight;
    this.inflight = this.read()
      .then((tape) => {
        this.kept = { tape, at: this.deps.now() };
        return tape;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async read(): Promise<MarketTape | null> {
    const now = this.deps.now();
    const today = dayKey(now, NY);
    const midnight = zonedTimeToUtc(today, NY);
    const series = await Promise.all(
      MARKET_INDICES.map(async ({ id, name }): Promise<MarketSeries | null> => {
        const good = this.good.get(id);
        let candles: Candle[];
        try {
          candles = (await this.deps.history(id)).candles;
          if (candles.length === 0) throw new Error('no bars');
        } catch {
          if (!good || now - good.at >= KEEP_HISTORY_MS) return null;
          candles = good.candles;
        }
        const raw = await this.deps.intraday(id, '30m', BARS).catch(() => good?.bars ?? []);
        this.good.set(id, { candles, at: candles === good?.candles ? good.at : now, bars: raw.length ? raw : (good?.bars ?? []) });
        const q = await this.deps.quote(id).catch(() => null);
        const lastBar = candles.at(-1);
        if (q?.last && q.last > 0 && lastBar && lastBar.t < midnight && now >= midnight + OPEN_MS && q.change !== null && Math.abs((q.last - q.change) / lastBar.c - 1) < SAME_CLOSE) {
          // Today's session while the history has no bar of it yet (its read of the quote failed, or it is up to
          // 5 minutes old): the quote is measured from the history's last close, so it is today's.
          const first = raw.find((b) => b.t >= midnight + OPEN_MS);
          candles = [...candles, { t: midnight, o: first?.o ?? lastBar.c, h: q.last, l: q.last, c: q.last, v: 0 }];
        }
        const sessions = sessionsOf(candles);
        if (sessions.length === 0) return null;
        const last = sessions.at(-1) as MarketSession;
        // Today's session: its last price from the live quote (the history keeps today's bar up to 5 minutes).
        if (last.day === today && q?.last && q.last > 0) sessions[sessions.length - 1] = { ...last, close: q.last };
        const bars = raw.map((b) => ({ end: b.t + 30 * 60_000, close: b.c })).filter((b) => b.end <= now && b.close > 0);
        return { id, name, sessions, bars };
      }),
    );
    const ok = series.filter((x): x is MarketSeries => x !== null);
    const coins = (await this.coins(now)).filter((x): x is CryptoSeries => x !== null);
    return ok.length || coins.length ? { series: ok, crypto: coins } : null;
  }

  /** BTC and ETH; a failed read uses the coin's last good candles for `KEEP_HISTORY_MS`. */
  private coins(now: number): Promise<(CryptoSeries | null)[]> {
    const read = this.deps.crypto;
    if (!read) return Promise.resolve([]);
    return Promise.all(
      CRYPTO_COINS.map(async ({ id, name, symbol }): Promise<CryptoSeries | null> => {
        const good = this.goodCoins.get(id);
        try {
          const [hours, days] = await Promise.all([read(symbol, '1h', CRYPTO_HOURS), read(symbol, '1d', CRYPTO_DAYS)]);
          if (hours.length === 0 || days.length === 0) throw new Error('no candles');
          this.goodCoins.set(id, { hours, days, at: now });
          return { id, name, hours, days };
        } catch {
          if (!good || now - good.at >= KEEP_HISTORY_MS) return null;
          return { id, name, hours: good.hours, days: good.days };
        }
      }),
    );
  }
}
