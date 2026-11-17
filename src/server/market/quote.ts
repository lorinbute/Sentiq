// The price of a symbol now (FD-BOT §8), shared by the bots and Paper Trading (FD-PAPER §5): a coin's last 1-minute close
// from the user's price source, a share's Nasdaq quote.
import type { BotInput } from '../../shared/bot.ts';
import { MarketError, type MarketData } from './market.ts';
import type { MarketSource } from './source.ts';
import type { StockData } from './stocks.ts';

export interface QuoteDeps {
  market: MarketData;
  stocks: StockData | null;
  source: MarketSource;
}

/** A symbol's price now and where it comes from: `lastTrade` is the ticker's (no candle in the last minutes). */
export interface Quote {
  price: number;
  lastTrade: boolean;
  /** The exchange it was read at (crypto). */
  exchange?: string;
}

/**
 * A symbol's price now (FD-BOT §8): a coin's last 1-minute close from the user's price source, a share's Nasdaq quote.
 * FIX-2ZPRICE: without a candle in the last 2 minutes (a thin pair, no trades), the source's last trade (its ticker).
 * `open`: a share's only while the market trades ('closed' otherwise).
 */
export async function readQuote(d: QuoteDeps, userId: number, market: BotInput['market'], sym: string, open: boolean): Promise<Quote | 'closed'> {
  if (market === 'stock') {
    const stocks = d.stocks;
    if (!stocks) throw new Error('datele pentru acțiuni nu sunt disponibile');
    if (open && (await stocks.confirmedStatus())?.state !== 'open') return 'closed';
    const q = await stocks.quote(sym);
    if (q.last === null || !(q.last > 0)) throw new Error('fără preț');
    return { price: q.last, lastTrade: false };
  }
  const exchange = await d.source.forSymbol(userId, sym, '1m');
  let c;
  let tfMs = 60_000;
  try {
    c = await d.market.candles(exchange, sym, '1m', 2);
  } catch (err) {
    if (!(err instanceof MarketError) || err.code !== 'UNSUPPORTED_TIMEFRAME') throw err;
    c = await d.market.candles(exchange, sym, '5m', 2);
    tfMs = 5 * 60_000;
  }
  const last = c.candles.at(-1);
  const valid = last && last.c > 0 ? last : null;
  // A candle of the last two periods (the cache may hold older ones: a chart loaded the pair's history).
  if (valid && c.fetchedAt - valid.t <= 2 * tfMs) return { price: valid.c, lastTrade: false, exchange };
  // No trade in the last minutes: the exchange gives no candle, its ticker has the last trade (else the last candle's).
  const p = await d.market.lastPrice(exchange, sym).catch(() => null);
  if (p !== null) return { price: p, lastTrade: true, exchange };
  if (valid) return { price: valid.c, lastTrade: true, exchange };
  throw new Error('fără preț');
}

export async function readPrice(d: QuoteDeps, userId: number, market: BotInput['market'], sym: string, open: boolean): Promise<number | 'closed'> {
  const q = await readQuote(d, userId, market, sym, open);
  return q === 'closed' ? q : q.price;
}

