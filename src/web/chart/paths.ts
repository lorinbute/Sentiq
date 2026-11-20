// Addresses of the Charts page: /charts/BTC/USDT for a pair, /charts/s/AAPL for a stock (FD-SENTIQ §4.3),
// /charts/i/SPX for an index (FD-INDICES), /charts/f/EUR-USD for a forex pair and /charts/m/XAU-USD for a commodity
// (FD-FXCOMMODITIES: "-" for the "/" of the symbol, readable).
import type { FxKind } from '../../shared/fx.ts';
import { plainSymbol } from '../../shared/indices.ts';
import { tfSeconds, type Timeframe } from '../../shared/time.ts';

export const stockChartPath = (sym: string) => `/charts/s/${encodeURIComponent(sym)}`;

/** An index by its id ("^SPX") or symbol ("SPX"): the address has the symbol. */
export const indexChartPath = (id: string) => `/charts/i/${encodeURIComponent(plainSymbol(id))}`;

/** FD-FXCOMMODITIES: a pair's or a commodity's chart ("EUR/USD" → /charts/f/EUR-USD). */
export const fxChartPath = (kind: FxKind, sym: string) => `/charts/${kind === 'forex' ? 'f' : 'm'}/${encodeURIComponent(sym.replace('/', '-'))}`;
/** The symbol of a forex or commodity chart's address ("EUR-USD" → "EUR/USD"). */
export const fxFromPath = (seg: string) => decodeURIComponent(seg).replace('-', '/').toUpperCase();

export const chartPathOf = (w: { kind?: 'crypto' | 'stock' | 'index' | 'forex' | 'commodity'; coin: string; quote: string }) =>
  w.kind === 'stock' ? stockChartPath(w.coin) : w.kind === 'index' ? indexChartPath(w.coin) : w.kind === 'forex' || w.kind === 'commodity' ? fxChartPath(w.kind, w.coin) : `/charts/${w.coin}/${w.quote}`;

/** `charts.symbol` as saved ("BTC/USDT", "stock:AAPL", "index:SPX", "forex:EUR/USD" or "commodity:XAU/USD") → its address. */
export function rememberedPath(saved: string): string {
  if (saved.startsWith('stock:')) return stockChartPath(saved.slice('stock:'.length));
  if (saved.startsWith('index:')) return indexChartPath(saved.slice('index:'.length));
  if (saved.startsWith('forex:')) return fxChartPath('forex', saved.slice('forex:'.length));
  if (saved.startsWith('commodity:')) return fxChartPath('commodity', saved.slice('commodity:'.length));
  const [b = 'BTC', q = 'USDT'] = saved.split('/');
  return `/charts/${b}/${q}`;
}

/**
 * The timeframe a chart shows for the saved one: itself when the source has it (the stock source, or the exchange of a
 * coin, FD-MARKETSRC), else the closest (longer on a tie).
 */
export function nearestTimeframe(tf: Timeframe, supported: readonly Timeframe[]): Timeframe {
  if (supported.includes(tf) || supported.length === 0) return supported.length === 0 ? '1d' : tf;
  const sec = tfSeconds(tf);
  return [...supported].sort((a, b) => Math.abs(tfSeconds(a) - sec) - Math.abs(tfSeconds(b) - sec) || tfSeconds(b) - tfSeconds(a))[0] as Timeframe;
}
