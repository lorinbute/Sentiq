// FD-STOCKLOGOS: the companies' logos from TradingView, downloaded once, kept for everyone, cleaned before they are served.
import { afterEach, describe, expect, it } from 'vitest';
import { testDb } from '../test/db.ts';
import { silentLogger } from '../log.ts';
import { setFetchImpl } from '../net/http.ts';
import { backupUrl, cleanSvg, LOGO_BACKUP_MS, LOGO_KEPT_MS, LOGO_MISSING_MS, LOGO_RETRY_MS, logoPicture, pickLogoIds, pictureValue, stockLogoSymbol, StockLogos } from './stock-logos.ts';

/** TradingView's own shape: a comment first, a square background, a gradient by id, no viewBox. */
const APPLE =
  '<!-- by TradingView --><svg width="18" height="18" xmlns="http://www.w3.org/2000/svg"><path fill="url(#paint0_linear)" d="M0 0h18v18H0z"/>' +
  '<path d="M13 10.6a4.8 4.8 0 01-.7 1.3" fill="#fff"/><defs><linearGradient id="paint0_linear" x1="3.4" y1="3.2" x2="21.9" y2="24.4">' +
  '<stop stop-color="#1A1E21"/><stop offset="1" stop-color="#06060A"/></linearGradient></defs></svg>';
const MSFT = '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path fill="#F0F3FA" d="M0 0h18v18H0z"/></svg>';
const scan = (...rows: [string, boolean, string | null][]) => JSON.stringify({ totalCount: rows.length, data: rows.map((d) => ({ s: `NASDAQ:${d[0]}`, d })) });

describe('a logo as served (FD-STOCKLOGOS)', () => {
  it("TradingView's SVG: the comment before it goes, the picture stays", () => {
    expect(cleanSvg(APPLE)).toBe(APPLE.replace('<!-- by TradingView -->', ''));
    expect(cleanSvg(`<?xml version="1.0"?>\n${MSFT}`)).toBe(MSFT);
  });

  it('anything but a plain picture: refused', () => {
    expect(cleanSvg('<html><body>busy</body></html>')).toBeNull();
    expect(cleanSvg(MSFT.replace('</svg>', '<script>alert(1)</script></svg>'))).toBeNull();
    expect(cleanSvg(MSFT.replace('<path', '<path onload="x()"'))).toBeNull();
    expect(cleanSvg(MSFT.replace('</svg>', '<image href="https://x.test/a.png"/></svg>'))).toBeNull();
    expect(cleanSvg(MSFT.replace('</svg>', '<foreignObject></foreignObject></svg>'))).toBeNull();
    expect(cleanSvg(MSFT.replace('fill="#F0F3FA"', 'fill="url(https://x.test/p)"'))).toBeNull();
    expect(cleanSvg(MSFT.replace('<path', '<a xlink:href="javascript:x()"><path'))).toBeNull();
    expect(cleanSvg(`<svg>${'x'.repeat(70_000)}</svg>`)).toBeNull();
  });

  it("a stock's symbol by TradingView's rule; a pair, an index or a word with spaces is none", () => {
    expect(stockLogoSymbol('aapl')).toBe('AAPL');
    expect(stockLogoSymbol('BRK.B')).toBe('BRK.B');
    expect(stockLogoSymbol('BTC/USDT')).toBeNull();
    expect(stockLogoSymbol('^SPX')).toBeNull();
    expect(stockLogoSymbol('A B')).toBeNull();
  });

  it("the screener's answer: each name's primary listing's logo id; an odd id or another name is left out", () => {
    const ids = pickLogoIds(scan(['BRK.B', false, 'berkshire-hathaway'], ['AAPL', false, 'apple-old'], ['AAPL', true, 'apple'], ['X', true, '../etc'], ['ZZZ', true, 'zzz']), ['AAPL', 'BRK.B', 'X']);
    expect(Object.fromEntries(ids)).toEqual({ AAPL: 'apple', 'BRK.B': 'berkshire-hathaway' });
    expect(() => pickLogoIds('<html>', ['AAPL'])).toThrow('TradingView: răspunsul nu e JSON');
  });
});

describe('the logos, on the test schema', () => {
  afterEach(() => setFetchImpl(null));

  it('the requests of one moment: one screener request; then kept for everyone, asked again after 30 days', async () => {
    const db = await testDb();
    let now = 1_800_000_000_000;
    const asked: string[] = [];
    setFetchImpl((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push(url.includes('scanner') ? `scan ${String(init?.body)}` : url);
      if (url.includes('scanner')) return new Response(scan(['AAPL', true, 'apple'], ['MSFT', true, 'microsoft']), { status: 200 });
      if (url.endsWith('/apple.svg')) return new Response(APPLE, { status: 200 });
      return new Response(MSFT, { status: 200 });
    }) as typeof fetch);
    const logos = new StockLogos(db, silentLogger, () => now);
    const [a, m, a2] = await Promise.all([logos.logo('AAPL'), logos.logo('msft'), logos.logo('AAPL')]);
    expect(a).toContain('<svg');
    expect(m).toBe(MSFT);
    expect(a2).toBe(a);
    expect(asked.filter((x) => x.startsWith('scan'))).toHaveLength(1);
    expect(asked.find((x) => x.startsWith('scan'))).toContain('"right":["AAPL","MSFT"]');
    expect(asked.filter((x) => x.endsWith('.svg')).sort()).toEqual(['https://s3-symbol-logo.tradingview.com/apple.svg', 'https://s3-symbol-logo.tradingview.com/microsoft.svg']);
    // Another instance (another user, after a restart): from the base, asking nobody.
    const n = asked.length;
    expect(await new StockLogos(db, silentLogger, () => now).logo('AAPL')).toBe(a);
    expect(asked).toHaveLength(n);
    now += LOGO_KEPT_MS + 1;
    await logos.logo('AAPL');
    expect(asked.length).toBeGreaterThan(n);
  });

  it('a stock without a logo: none, kept an hour (FIX-LOGOBACKUP: a new listing gets its logo later); TradingView down: none, not kept, asked again after 10 minutes', async () => {
    expect(LOGO_MISSING_MS).toBe(3_600_000);
    const db = await testDb();
    let now = 1_800_000_000_000;
    let calls = 0;
    let down = true;
    setFetchImpl((async (input: string | URL | Request) => {
      calls++;
      if (down) return new Response('busy', { status: 503 });
      return String(input).includes('scanner') ? new Response(scan(['NOLG', true, null]), { status: 200 }) : new Response('', { status: 404 });
    }) as typeof fetch);
    const logos = new StockLogos(db, silentLogger, () => now);
    expect(await logos.logo('NOLG')).toBeNull();
    expect(await db.get('SELECT value FROM market_cache WHERE [key] = ?', ['logo:v1:stock:NOLG'])).toBeFalsy();
    const failed = calls;
    expect(await logos.logo('NOLG')).toBeNull();
    expect(calls).toBe(failed);
    now += LOGO_RETRY_MS + 1;
    down = false;
    expect(await logos.logo('NOLG')).toBeNull();
    expect(calls).toBeGreaterThan(failed);
    const missing = calls;
    expect(await logos.logo('NOLG')).toBeNull();
    expect(calls).toBe(missing);
    now += LOGO_MISSING_MS + 1;
    await logos.logo('NOLG');
    expect(calls).toBeGreaterThan(missing);
  });

  it('an expired logo is still shown while TradingView does not answer; a symbol that is not a stock asks nobody', async () => {
    const db = await testDb();
    let now = 1_800_000_000_000;
    let calls = 0;
    let down = false;
    setFetchImpl((async (input: string | URL | Request) => {
      calls++;
      if (down) throw new Error('offline');
      return String(input).includes('scanner') ? new Response(scan(['MSFT', true, 'microsoft']), { status: 200 }) : new Response(MSFT, { status: 200 });
    }) as typeof fetch);
    const logos = new StockLogos(db, silentLogger, () => now);
    expect(await logos.logo('MSFT')).toBe(MSFT);
    now += LOGO_KEPT_MS + 1;
    down = true;
    expect(await logos.logo('MSFT')).toBe(MSFT);
    const n = calls;
    expect(await logos.logo('BTC/USDT')).toBeNull();
    expect(await logos.logo('^SPX')).toBeNull();
    expect(calls).toBe(n);
  });

  it('FIX-LOGOBACKUP: none at TradingView: Twelve Data\'s picture with the asking user\'s key, kept and served as itself; asked once a day', async () => {
    const db = await testDb();
    let now = 1_800_000_000_000;
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    let picture: Uint8Array | string = JPEG;
    setFetchImpl((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('scanner')) return new Response(scan(['ANT', true, null], ['NEWCO', true, null]), { status: 200 });
      if (url.startsWith('https://api.twelvedata.com/logo/')) return new Response(picture as unknown as BodyInit, { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch);
    const asked: [string, number][] = [];
    let address: string | null = 'https://api.twelvedata.com/logo/anthropic.com';
    const logos = new StockLogos(db, silentLogger, () => now, async (s, u) => (asked.push([s, u]), address));
    // Without a user (the notifications' extension, an anonymous caller): nobody's credits, no picture.
    expect(await logos.logo('NEWCO')).toBeNull();
    expect(asked).toEqual([]);
    const v = await logos.logo('ANT', 7);
    expect(v).toMatch(/^data:image\/jpeg;base64,/);
    expect(asked).toEqual([['ANT', 7]]);
    expect([...(logoPicture(v as string)?.bytes ?? [])]).toEqual([...JPEG]);
    expect(logoPicture(v as string)?.type).toBe('image/jpeg');
    // Kept for everyone (another instance, without a user), asking nobody.
    expect(await new StockLogos(db, silentLogger, () => now).kept('ANT')).toBe(v);
    // Twelve Data has none either: none, and Twelve Data not asked again for a day (TradingView every hour, for free).
    address = null;
    expect(await logos.logo('NEWCO', 7)).toBeNull();
    now += LOGO_MISSING_MS + 1;
    expect(await logos.logo('NEWCO', 7)).toBeNull();
    expect(asked.filter(([s]) => s === 'NEWCO')).toHaveLength(1);
    now += LOGO_BACKUP_MS;
    address = 'https://api.twelvedata.com/logo/newco.com';
    picture = '<html>not a picture</html>';
    expect(await logos.logo('NEWCO', 7)).toBeNull();
    expect(asked.filter(([s]) => s === 'NEWCO')).toHaveLength(2);
  });

  it('FIX-LOGOBACKUP: only Twelve Data\'s own https addresses; only a JPEG or a PNG of a logo\'s size', () => {
    expect(backupUrl('https://api.twelvedata.com/logo/apple.com')).toBe('https://api.twelvedata.com/logo/apple.com');
    expect([backupUrl('http://api.twelvedata.com/logo/a.com'), backupUrl('https://evil.test/twelvedata.com'), backupUrl('https://twelvedata.com.evil.test/x'), backupUrl('nonsense'), backupUrl(null)]).toEqual([null, null, null, null, null]);
    expect(pictureValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toMatch(/^data:image\/png;base64,/);
    expect(pictureValue(new TextEncoder().encode('<svg></svg>'))).toBeNull();
    expect(pictureValue(new Uint8Array(70_000).fill(0xff))).toBeNull();
    expect(logoPicture('<svg/>')).toBeNull();
  });
});
