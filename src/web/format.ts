// Formatting helpers (Romanian locale, user time zone).
import { maxDecimals, priceDecimals } from '../shared/decimals.ts';

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('ro-RO', { timeZone: tz, ...opts });
    cache.set(key, f);
  }
  return f;
}

export const fmtTime = (ts: number, tz: string) => dtf(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
export const fmtDate = (ts: number, tz: string) => dtf(tz, { day: '2-digit', month: 'short' }).format(ts);
export const fmtDateTime = (ts: number, tz: string) =>
  dtf(tz, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
export const fmtWeekday = (ts: number, tz: string) => dtf(tz, { weekday: 'long', day: 'numeric', month: 'long' }).format(ts);

export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return fmtIn(ts, now);
  if (s < 60) return 'acum';
  const m = Math.round(s / 60);
  if (m < 60) return `acum ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `acum ${h} h`;
  const d = Math.floor(h / 24);
  return `acum ${d} ${d === 1 ? 'zi' : 'zile'}`;
}

export function fmtIn(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ts - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h >= 24) return `în ${Math.floor(h / 24)} z ${h % 24} h`;
  if (h > 0) return `în ${h} h ${String(m).padStart(2, '0')} min`;
  return `în ${m}:${String(sec).padStart(2, '0')}`;
}

/** Compact countdown for the cockpit tiles: "1z 17h 44m", "3h 05m", "12m 09s"; 0 once the time has passed. */
export function fmtCountdown(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((ts - now) / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}z ${h}h ${two(m)}m`;
  if (h > 0) return `${h}h ${two(m)}m`;
  return `${m}m ${two(sec)}s`;
}

const nf = new Map<string, Intl.NumberFormat>();
function numFmt(min: number, max: number, extra: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${min}|${max}|${JSON.stringify(extra)}`;
  let f = nf.get(key);
  if (!f) {
    f = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: min, maximumFractionDigits: max, ...extra });
    nf.set(key, f);
  }
  return f;
}

export function fmtPrice(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return numFmt(digits, digits).format(v);
}

/** At most `max` decimals (at least `min`); FIX-DECIMALS: never more than two from 1 on, four under 1 (`maxDecimals`). */
export function fmtNum(v: number | null | undefined, max = 2, min = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const m = Math.min(max, maxDecimals(v));
  return numFmt(Math.min(min, m), m).format(v);
}

export function fmtPct(v: number | null | undefined, digits = 2, signed = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const d = Math.min(digits, maxDecimals(v));
  const s = numFmt(d, d).format(v);
  return `${signed && v > 0 ? '+' : ''}${s}%`;
}

/** USD amounts in the same (Romanian) number style as the rest of the UI: "1.234,50 USD", "2,82 tril. USD". */
export function fmtUsd(v: number | null | undefined, compact = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return numFmt(compact ? 0 : 2, 2, { style: 'currency', currency: 'USD', notation: compact ? 'compact' : 'standard' }).format(v);
}

/**
 * An amount in a currency (FD-SENTIQ §3): "1.234,50 €", "980,00 GBP"-style through Intl for ISO codes, and
 * "1.234,50 USDT" for the crypto quote coins Intl does not know.
 */
export function fmtMoney(v: number | null | undefined, currency = 'USD'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (/^[A-Z]{3}$/.test(currency)) {
    try {
      return numFmt(2, 2, { style: 'currency', currency }).format(v);
    } catch {
      // unknown ISO code: plain number with the code
    }
  }
  return `${numFmt(2, 2).format(v)} ${currency}`;
}

/** A price's decimals without the exchange's precision (FIX-DECIMALS): 2 from 1 on, 4 under 1; `fx` a rate's 4 under 10. */
export const autoDigits = (v: number, fx = false): number => priceDecimals(v, fx);

/**
 * FIX-DECIMALS: a number as the order forms write it beside their fields (a dot, no grouping), shown, not typed: at most
 * two decimals from 1 on, four under 1; with `fx` set, a price (a forex / commodity rate keeps four under 10).
 */
export function fmtPlain(v: number | null | undefined, max = 8, fx: boolean | null = null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return String(Number(v.toFixed(Math.min(max, fx === null ? maxDecimals(v) : priceDecimals(v, fx)))));
}

export type Tone = 'bull' | 'bear' | 'neutral';

export function indexTone(index: number): Tone {
  if (index >= 60) return 'bull';
  if (index < 40) return 'bear';
  return 'neutral';
}

export function indexLabel(index: number): string {
  if (index < 20) return 'Foarte negativ';
  if (index < 40) return 'Negativ';
  if (index < 60) return 'Neutru';
  if (index < 80) return 'Pozitiv';
  return 'Foarte pozitiv';
}

export const confidenceLabel: Record<string, string> = { low: 'încredere scăzută', medium: 'încredere medie', high: 'încredere ridicată' };

export const toneText: Record<Tone, string> = { bull: 'text-bull', bear: 'text-bear', neutral: 'text-muted' };

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  // The database's maximum size (FD-AZURE §5): 2 GB, 250 GB.
  return `${Number((n / 1024 ** 3).toFixed(1))} GB`;
}

/** A count in Romanian: "1 desen", "3 desene", "20 de desene", "101 desene" (with "de" from 20 on, unless it ends in 01–19). */
export function countRo(n: number, one: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  const r = n % 100;
  return `${n} ${n < 20 || (r >= 1 && r <= 19) ? '' : 'de '}${many}`;
}

/**
 * FD-TRADESMOBILE: the space before an amount's unit ("1.000,00 USD", "70 %") an ordinary one, so on a narrow card only
 * the unit goes to the next line; the amount itself stays whole.
 */
export const breakableUnit = (v: string): string => v.replace(/\u00a0(?=[^\s\u00a0\d.,−+-]+$)/, ' ');

/**
 * FIX-POSAMOUNT: what a futures position took from the account, without leverage (its margin): in dollars when it
 * settles in a dollar coin (USDT, USDC, USD), else in its settlement coin (an inverse contract: BTC); a dash when unknown.
 */
export function positionAmount(pos: { symbol: string; margin?: number | null }): string {
  return amountIn(pos.margin, pos.symbol.split(':')[1] ?? pos.symbol.split('/')[1] ?? 'USDT');
}

/** FIX-HISTAMOUNT: an amount in a settlement currency: in dollars for USDT / USDC / USD, else in its coin; a dash when unknown. */
export function amountIn(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return ['USDT', 'USDC', 'USD'].includes(currency.toUpperCase()) ? fmtUsd(v) : `${fmtNum(v, 8)} ${currency}`;
}
