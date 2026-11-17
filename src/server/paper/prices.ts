// FD-PAPER §5: the prices Paper Trading executes at: a coin's from the user's chart exchange (a perpetual: its spot
// pair's), a share's Nasdaq quote; and the window of prices since the last look, so a wick between two looks is not
// missed and one before an order was placed does not fill it.
import type { Candle } from '../../shared/indicator/slingshot.ts';
import { readQuote, type QuoteDeps } from '../market/quote.ts';
import type { PaperMarket, PriceWindow } from './model.ts';

/** The pair whose price a paper symbol trades at: a perpetual's spot pair (BTC/USDT:USDT → BTC/USDT). */
export const priceSymbol = (symbol: string): string => symbol.split(':')[0] as string;

/** What the last look saw of a pair: its forming 1-minute candle and the price then. */
interface Seen {
  t: number;
  high: number;
  low: number;
  last: number;
  at: number;
}

/** A pair's prices now: its last price and the 1-minute candles since a moment (crypto). */
export interface Prices {
  last: number;
  candles: Candle[];
  at: number;
}

const MAX_CANDLES = 180;

export class PaperPrices {
  private readonly d: QuoteDeps;
  /** By user and pair: what the last look saw (lost on a restart: then the candles since each item's moment). */
  private readonly seen = new Map<string, Seen>();

  constructor(d: QuoteDeps) {
    this.d = d;
  }

  /** The price now (`closed`: a share while the market is closed and `open` is asked). Throws when it cannot be read. */
  async last(userId: number, market: PaperMarket, symbol: string, open = false): Promise<number | 'closed'> {
    const q = await readQuote(this.d, userId, market === 'stock' ? 'stock' : 'spot', priceSymbol(symbol), open);
    return q === 'closed' ? q : q.price;
  }

  /** The price now and, for a coin, the 1-minute candles since `since` (at most 3 hours): one read per look and pair. */
  async read(userId: number, market: PaperMarket, symbol: string, since: number, now: number): Promise<Prices | 'closed'> {
    const last = await this.last(userId, market, symbol, true);
    if (last === 'closed') return last;
    if (market === 'stock') return { last, candles: [], at: now };
    const pair = priceSymbol(symbol);
    const exchange = await this.d.source.forSymbol(userId, pair, '1m');
    const count = Math.min(MAX_CANDLES, Math.max(2, Math.ceil((now - since) / 60_000) + 2));
    const c = await this.d.market.candles(exchange, pair, '1m', count).catch(() => null);
    return { last, candles: c?.candles ?? [], at: now };
  }

  /**
   * The window an item placed (or last changed) at `since` sees: after the last look, the candles begun since it and the
   * new highs / lows of the one it saw forming; for an item newer than the last look, only the candles begun after it.
   * Always with the price now; opened at the last look's price (or the first candle's; unknown without either).
   */
  windowFor(userId: number, symbol: string, p: Prices, since: number): PriceWindow {
    const s = this.seen.get(`${userId}|${priceSymbol(symbol)}`);
    const bars: { o: number; h: number; l: number }[] = [];
    let open: number | null = null;
    if (s && since <= s.at) {
      open = s.last;
      for (const c of p.candles) {
        if (c.t > s.t) bars.push({ o: c.o, h: c.h, l: c.l });
        else if (c.t === s.t) bars.push({ o: s.last, h: Math.max(s.last, c.h > s.high ? c.h : s.last), l: Math.min(s.last, c.l < s.low ? c.l : s.last) });
      }
    } else {
      for (const c of p.candles) if (c.t >= since) bars.push({ o: c.o, h: c.h, l: c.l });
    }
    // Without a price seen before it (the item's first look, a share's first quote), nothing says the window jumped
    // past a level: its opening is unknown (NaN), so an order fills at its own level.
    open ??= bars[0]?.o ?? NaN;
    const seen = Number.isNaN(open) ? [] : [open];
    const high = Math.max(...seen, p.last, ...bars.map((b) => b.h));
    const low = Math.min(...seen, p.last, ...bars.map((b) => b.l));
    return { open, high, low, last: p.last };
  }

  /** What this look saw of a pair, for the next one's window. */
  remember(userId: number, symbol: string, p: Prices): void {
    const forming = p.candles.at(-1);
    const key = `${userId}|${priceSymbol(symbol)}`;
    if (!forming) {
      this.seen.set(key, { t: -1, high: p.last, low: p.last, last: p.last, at: p.at });
      return;
    }
    this.seen.set(key, { t: forming.t, high: forming.h, low: forming.l, last: p.last, at: p.at });
  }
}
