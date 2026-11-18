// Stock logos (FD-STOCKLOGOS): a company's logo where the UI showed a stock's initials. TradingView's symbol logos, the
// source the "Date financiare" quarters already come from: the screener's `logoid`, then the SVG from its logo CDN.
// Downloaded the first time a stock's logo is asked for, kept in `market_cache` for everyone (30 days; a stock without
// one, 7), so the UI asks this server only. The requests of one moment (a list with many stocks) go to the screener as one.
import type { Db } from '../db/database.ts';
import type { Logger } from '../log.ts';
import { httpRequest } from '../net/http.ts';
import { isTvSymbol, tvScan } from '../calendar/sources.ts';

export const LOGO_KEPT_MS = 30 * 86_400_000;
export const LOGO_MISSING_MS = 7 * 86_400_000;
/** After a network failure the symbol is not asked again for this long (kept in memory only, never in the base). */
export const LOGO_RETRY_MS = 10 * 60_000;
export const LOGO_MAX_BYTES = 64 * 1024;
const LOGO_URL = 'https://s3-symbol-logo.tradingview.com/';
const BATCH_MS = 25;
const BATCH_MAX = 50;
const DOWNLOADS_AT_ONCE = 6;
const TV_LOGO_COLUMNS = ['name', 'is_primary', 'logoid'] as const;
/** A logo id as TradingView writes them ("apple", "spdr-sandp500-etf-tr", "country/US"): no dots, no "..", no host. */
const LOGO_ID = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

const logoKey = (symbol: string) => `logo:v1:stock:${symbol}`;

/** A stock's symbol a logo can be asked for: TradingView's own rule (`AAPL`, `BRK.B`), upper case. */
export function stockLogoSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  return s.length <= 15 && isTvSymbol(s) ? s : null;
}

/**
 * The SVG as served, or null when it is not a plain picture: comments and an XML declaration before it go; it must be
 * one `<svg>` element; no script, embedded document or image, no event handler, nothing outside the file (`href` and
 * `url(…)` only to `#…`).
 */
export function cleanSvg(body: string): string | null {
  if (body.length > LOGO_MAX_BYTES) return null;
  let s = body.trim();
  for (;;) {
    const lead = s.match(/^(?:<!--[\s\S]*?-->|<\?xml[^>]*\?>)\s*/);
    if (!lead) break;
    s = s.slice(lead[0].length);
  }
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>$/i.test(s)) return null;
  if (/<(?:script|foreignObject|image|iframe|object|embed|use|a)[\s>/]/i.test(s)) return null;
  if (/\son[a-z]+\s*=/i.test(s) || /javascript:/i.test(s) || /<!(?:DOCTYPE|ENTITY)/i.test(s)) return null;
  for (const m of s.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) if (!m[1]?.startsWith('#')) return null;
  for (const m of s.matchAll(/url\(\s*['"]?([^'")\s]*)/gi)) if (!m[1]?.startsWith('#')) return null;
  return s;
}

/** The screener's answer for these names → each name's logo id (its primary listing's, else the first with one). */
export function pickLogoIds(body: string, names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let rows: { s?: unknown; d?: unknown }[] = [];
  try {
    const json = JSON.parse(body) as { data?: unknown };
    rows = Array.isArray(json.data) ? (json.data as { d?: unknown }[]) : [];
  } catch {
    throw new Error('TradingView: răspunsul nu e JSON');
  }
  const wanted = new Set(names);
  const best = new Map<string, { id: string; primary: boolean }>();
  for (const r of rows) {
    const d = Array.isArray(r.d) ? r.d : [];
    const [name, primary, id] = d;
    if (typeof name !== 'string' || !wanted.has(name) || typeof id !== 'string' || !LOGO_ID.test(id)) continue;
    const had = best.get(name);
    if (!had || (!had.primary && primary === true)) best.set(name, { id, primary: primary === true });
  }
  for (const [name, b] of best) out.set(name, b.id);
  return out;
}

type Waiter = { symbol: string; resolve: (svg: string | null) => void };

export class StockLogos {
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly retryAfter = new Map<string, number>();
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private downloads = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly db: Db;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(db: Db, log: Logger, now: () => number = Date.now) {
    this.db = db;
    this.log = log;
    this.now = now;
  }

  /**
   * A logo downloaded already (any age), without asking anyone: what an anonymous caller (the app's notification
   * extension, which has no session) may have.
   */
  async kept(raw: string): Promise<string | null> {
    const symbol = stockLogoSymbol(raw);
    if (!symbol) return null;
    const row = await this.db.get<{ value: string }>('SELECT value FROM market_cache WHERE [key] = ?', [logoKey(symbol)]);
    return row?.value || null;
  }

  /** The stock's logo (an SVG), or null when it has none, the symbol is not a stock's, or TradingView did not answer. */
  logo(raw: string): Promise<string | null> {
    const symbol = stockLogoSymbol(raw);
    if (!symbol) return Promise.resolve(null);
    // One lookup per symbol at a time (two pages asking at once download it once).
    const running = this.inFlight.get(symbol);
    if (running) return running;
    const p = new Promise<string | null>((resolve) => {
      this.queue.push({ symbol, resolve });
      // A full batch leaves at once; otherwise after a moment, with whatever else came (a list's logos together).
      if (this.queue.length >= BATCH_MAX) this.flush();
      else this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
    }).finally(() => this.inFlight.delete(symbol));
    this.inFlight.set(symbol, p);
    return p;
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue.splice(0, BATCH_MAX);
    if (this.queue.length > 0) this.timer = setTimeout(() => this.flush(), BATCH_MS);
    if (batch.length === 0) return;
    void this.resolve(batch.map((w) => w.symbol))
      .catch((err: Error) => {
        this.log.warn(`stock logos: ${err.message}`);
        return new Map<string, string | null>();
      })
      .then((found) => {
        for (const w of batch) w.resolve(found.get(w.symbol) ?? null);
      });
  }

  /**
   * One batch: the base read once for all; a copy still fresh is the answer; the others asked of the screener in one
   * request, then downloaded (an expired copy is still the answer while TradingView cannot be asked).
   */
  private async resolve(symbols: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const rows = await this.db.all<{ key: string; value: string; fetched_at: number }>(
      `SELECT [key] AS [key], value, fetched_at FROM market_cache WHERE [key] IN (${symbols.map(() => '?').join(', ')})`,
      symbols.map(logoKey),
    );
    const kept = new Map(rows.map((r) => [r.key, r]));
    const ask: string[] = [];
    for (const s of symbols) {
      const row = kept.get(logoKey(s));
      if (row && this.now() - row.fetched_at <= (row.value ? LOGO_KEPT_MS : LOGO_MISSING_MS)) out.set(s, row.value || null);
      else if ((this.retryAfter.get(s) ?? 0) > this.now()) out.set(s, row?.value || null);
      else ask.push(s);
    }
    if (ask.length === 0) return out;
    const failed = (s: string, err: Error) => {
      // Not written: asked again after a while.
      this.retryAfter.set(s, this.now() + LOGO_RETRY_MS);
      out.set(s, kept.get(logoKey(s))?.value || null);
      this.log.warn(`stock logo ${s}: ${err.message}`);
    };
    let ids: Map<string, string>;
    try {
      ids = pickLogoIds(await tvScan(ask, TV_LOGO_COLUMNS), ask);
    } catch (err) {
      for (const s of ask) failed(s, err as Error);
      return out;
    }
    await Promise.all(
      ask.map(async (s) => {
        const id = ids.get(s);
        let svg: string | null = null;
        if (id) {
          try {
            svg = await this.download(id);
          } catch (err) {
            failed(s, err as Error);
            return;
          }
        }
        this.retryAfter.delete(s);
        out.set(s, svg);
        await this.put(s, svg ?? '').catch((err: Error) => this.log.warn(`stock logo ${s}: not kept (${err.message})`));
      }),
    );
    return out;
  }

  /** The SVG of a logo id (at most DOWNLOADS_AT_ONCE at a time); null when TradingView has none or it is not a picture. */
  private async download(id: string): Promise<string | null> {
    await this.slot();
    try {
      const res = await httpRequest(`${LOGO_URL}${id}.svg`, { headers: { Accept: 'image/svg+xml' }, timeoutMs: 15_000, maxBytes: LOGO_MAX_BYTES + 1 });
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`logo-ul a răspuns cu eroarea HTTP ${res.status}`);
      return cleanSvg(res.body);
    } finally {
      this.release();
    }
  }

  private async slot(): Promise<void> {
    if (this.downloads < DOWNLOADS_AT_ONCE) {
      this.downloads++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.downloads++;
  }

  private release(): void {
    this.downloads--;
    this.waiting.shift()?.();
  }

  private async put(symbol: string, value: string): Promise<void> {
    await this.db.run(
      'UPDATE market_cache SET value = @v, fetched_at = @t WHERE [key] = @k; IF @@ROWCOUNT = 0 INSERT INTO market_cache([key], value, fetched_at) VALUES (@k, @v, @t)',
      { k: logoKey(symbol), v: value, t: this.now() },
    );
  }
}
