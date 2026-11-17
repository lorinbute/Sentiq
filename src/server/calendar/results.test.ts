// FD-CALACTUAL §3: the results a company reported (EPS, revenue, against the analysts'), from TradingView, on its
// earnings event in the calendar.
import { afterEach, describe, expect, it } from 'vitest';
import { testDb } from '../test/db.ts';
import { silentLogger } from '../log.ts';
import { setFetchImpl } from '../net/http.ts';
import type { EarningsRow } from '../market/stocks.ts';
import { CalendarService, RESULTS_KEEP_DAYS } from './service.ts';
import { fetchTvResults, parseTvResults, TV_RESULT_COLUMNS, TV_SCAN_URL, type TvResult } from './sources.ts';

const DAY = 86_400_000;
/** A date as TradingView gives it: seconds. */
const sec = (iso: string) => Date.parse(iso) / 1000;
/** One screener row, in the order of TV_RESULT_COLUMNS. */
const row = (
  exchange: string,
  name: string,
  o: { primary?: boolean; day?: string | null; at?: string; eps?: number | null; epsF?: number | null; epsS?: number | null; rev?: number | null; revF?: number | null; revS?: number | null; cur?: unknown } = {},
) => ({
  s: `${exchange}:${name}`,
  d: [
    name,
    o.primary ?? true,
    'stock',
    o.day === null ? null : sec(`${o.day ?? '2026-11-12'}T00:00:00Z`),
    o.at ? sec(o.at) : null,
    o.eps === undefined ? 1.4 : o.eps,
    o.epsF === undefined ? 1.325853 : o.epsF,
    o.epsS === undefined ? 5.592399760757789 : o.epsS,
    o.rev === undefined ? 18_517_000_000 : o.rev,
    o.revF === undefined ? 18_122_843_375 : o.revF,
    o.revS === undefined ? 2.1749160263876086 : o.revS,
    o.cur === undefined ? 'USD' : o.cur,
  ],
});
const answer = (...rows: unknown[]) => JSON.stringify({ totalCount: rows.length, data: rows });

describe("TradingView's reported results (FD-CALACTUAL §3)", () => {
  it('reads the day, the time, EPS and revenue against the forecasts; the row with an EPS, then the primary one', () => {
    const got = parseTvResults(
      answer(
        row('NASDAQ', 'CSCO', { at: '2026-11-12T21:05:00Z' }),
        row('NYSE', 'MUFG', { primary: false, day: '2026-11-13', eps: 0.456285, epsF: 0.429791, epsS: 6.16, rev: null, revF: null, revS: null }),
        row('BMV', 'MUFG', { primary: true, day: '2026-11-13', eps: null }),
        row('NASDAQ', 'NODAY', { day: null }),
        row('NASDAQ', 'ODD', { cur: 7 }),
        { s: 'BROKEN', d: 'x' },
      ),
    );
    expect(got.get('CSCO')).toEqual({
      day: '2026-11-12',
      releasedAt: Date.parse('2026-11-12T21:05:00Z'),
      eps: 1.4,
      epsForecast: 1.325853,
      epsSurprisePct: 5.592399760757789,
      revenue: 18_517_000_000,
      revenueForecast: 18_122_843_375,
      revenueSurprisePct: 2.1749160263876086,
      currency: 'USD',
    } satisfies TvResult);
    // The listing with an EPS wins over the primary one without.
    expect(got.get('MUFG')).toMatchObject({ day: '2026-11-13', eps: 0.456285, revenue: null });
    expect(got.has('NODAY')).toBe(false);
    expect(got.get('ODD')?.currency).toBeNull();
    expect(() => parseTvResults('<html>')).toThrow('TradingView: răspunsul nu e JSON');
  });

  describe('the request', () => {
    afterEach(() => setFetchImpl(null));

    it('one POST for the stocks only; none without any', async () => {
      const sent: RequestInit[] = [];
      setFetchImpl((async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(TV_SCAN_URL);
        sent.push(init ?? {});
        return new Response(answer(row('NASDAQ', 'CSCO')), { status: 200 });
      }) as typeof fetch);
      expect((await fetchTvResults(['CSCO', '^SPX', 'CSCO'])).get('CSCO')?.eps).toBe(1.4);
      expect(JSON.parse(String(sent[0]?.body))).toEqual({ filter: [{ left: 'name', operation: 'in_range', right: ['CSCO'] }], columns: [...TV_RESULT_COLUMNS], range: [0, 3] });
      expect(await fetchTvResults(['^SPX'])).toEqual(new Map());
      expect(sent).toHaveLength(1);
    });
  });
});

describe('the results on the earnings events, on the test schema (FD-CALACTUAL §3)', () => {
  // Thursday 12 Nov 2026: Cisco after the close; Friday 13 Nov: MUFG before the open (TradingView's numbers only).
  const thu = Date.parse('2026-11-12T15:00:00Z');
  const fri = Date.parse('2026-11-13T15:00:00Z');
  const nasdaq = async (day: string): Promise<EarningsRow[]> =>
    day === '2026-11-12'
      ? [{ symbol: 'CSCO', name: 'Cisco Systems, Inc.', time: 'after', quarter: 'Oct/2026', epsForecast: '$1.15', lastYearEps: '$1.00' }]
      : day === '2026-11-13'
        ? [{ symbol: 'MUFG', name: 'Mitsubishi UFJ Financial Group Inc', time: 'pre', quarter: 'Sep/2026', epsForecast: '$0.45', lastYearEps: '$0.44' }]
        : [];
  const csco: TvResult = {
    day: '2026-11-12',
    releasedAt: Date.parse('2026-11-12T21:05:00Z'),
    eps: 1.4,
    epsForecast: 1.325853,
    epsSurprisePct: 5.592399760757789,
    revenue: 18_517_000_000,
    revenueForecast: 18_122_843_375,
    revenueSurprisePct: 2.1749160263876086,
    currency: 'USD',
  };

  async function setup() {
    const db = await testDb();
    for (const [i, [coin, name]] of [
      ['CSCO', 'Cisco Systems, Inc.'],
      ['MUFG', 'Mitsubishi UFJ Financial Group Inc'],
    ].entries()) {
      await db.run("INSERT INTO watchlist(coin, quote, position, aliases, added_at, kind, name) VALUES (?, 'USD', ?, '[]', 1, 'stock', ?)", [coin, i, name]);
    }
    const cal = new CalendarService(db, silentLogger);
    await cal.refreshEarnings(['CSCO', 'MUFG'], nasdaq, thu);
    return { db, cal };
  }

  it('waits for the events of the last days; stores only the results of the event’s own day, with an EPS', async () => {
    const { cal } = await setup();
    expect(await cal.awaitingResults(fri)).toEqual([
      { symbol: 'CSCO', day: '2026-11-12' },
      { symbol: 'MUFG', day: '2026-11-13' },
    ]);
    // MUFG: TradingView still has the quarter before (another day); then the day, but no EPS yet.
    const found = new Map<string, TvResult>([
      ['CSCO', csco],
      ['MUFG', { ...csco, day: '2026-08-04', eps: 0.4 }],
    ]);
    expect(await cal.saveResults(found, await cal.awaitingResults(fri), fri)).toBe(1);
    expect(await cal.saveResults(new Map([['MUFG', { ...csco, day: '2026-11-13', eps: null }]]), await cal.awaitingResults(fri), fri)).toBe(0);
    expect(await cal.awaitingResults(fri)).toEqual([{ symbol: 'MUFG', day: '2026-11-13' }]);
    // More than 7 days later nothing waits any more.
    expect(await cal.awaitingResults(fri + 8 * DAY)).toEqual([]);
  });

  it('the event shows the EPS reported, the forecast it was compared with, the revenue; no year-ago EPS', async () => {
    const { cal } = await setup();
    await cal.saveResults(new Map([['CSCO', csco]]), await cal.awaitingResults(fri), fri);
    const events = await cal.query({ userId: 1, from: thu - DAY, to: fri + DAY });
    const e = events.find((x) => x.currency === 'CSCO');
    expect(e).toMatchObject({ actual: '$1.40', forecast: '$1.33', previous: null, deviation: 0.074147 });
    expect(e?.results).toEqual({
      eps: 1.4,
      epsForecast: 1.325853,
      epsSurprisePct: 5.592399760757789,
      revenue: 18_517_000_000,
      revenueForecast: 18_122_843_375,
      revenueSurprisePct: 2.1749160263876086,
      currency: 'USD',
    });
    // Intl keeps "18,52 mld. $" together with no-break spaces.
    expect(e?.note?.replace(/\u00a0/g, ' ')).toBe(
      'Cisco Systems a raportat: EPS $1.40 față de $1.33 estimat (+5,6%); venituri 18,52 mld. $ față de 18,12 mld. $ estimate (+2,2%). Cifrele sunt de la TradingView. Înainte de rezultate, prognoza afișată era cea de la Nasdaq ($1.15), care calculează EPS-ul altfel.',
    );
    // MUFG has none yet: as before.
    expect(events.find((x) => x.currency === 'MUFG')).toMatchObject({ actual: null, forecast: '$0.45', previous: '$0.44' });
    expect(events.find((x) => x.currency === 'MUFG')?.results).toBeUndefined();
  });

  it('the results stay when the earnings refresh rewrites the day; they go after 90 days', async () => {
    const { db, cal } = await setup();
    await cal.saveResults(new Map([['CSCO', csco]]), await cal.awaitingResults(thu + 7 * 3_600_000), thu + 7 * 3_600_000);
    await cal.refreshEarnings(['CSCO', 'MUFG'], nasdaq, thu + 8 * 3_600_000);
    const [e] = await cal.query({ userId: 1, from: thu - DAY, to: thu + DAY });
    expect(e?.actual).toBe('$1.40');
    await cal.saveResults(new Map(), [], Date.parse('2026-11-12T15:00:00Z') + (RESULTS_KEEP_DAYS + 1) * DAY);
    expect((await db.get<{ n: number }>('SELECT count(*) AS n FROM earn_results'))?.n).toBe(0);
  });

  it('the note without a Nasdaq forecast, a revenue or an EPS forecast; a loss written with its sign', async () => {
    const { cal } = await setup();
    const loss: TvResult = { ...csco, day: '2026-11-13', eps: -0.61, epsForecast: null, epsSurprisePct: null, revenue: null, revenueForecast: null, revenueSurprisePct: null };
    // No EPS forecast and no revenue at TradingView: only what was reported; the Nasdaq forecast shown before is recalled.
    await cal.saveResults(new Map([['MUFG', loss]]), await cal.awaitingResults(fri), fri);
    const events = await cal.query({ userId: 1, from: fri - DAY, to: fri + DAY });
    const e = events.find((x) => x.currency === 'MUFG');
    expect(e).toMatchObject({ actual: '-$0.61', forecast: null, previous: null, deviation: null });
    expect(e?.note).toBe(
      'Mitsubishi UFJ Financial Group a raportat: EPS -$0.61. Cifrele sunt de la TradingView. Înainte de rezultate, prognoza afișată era cea de la Nasdaq ($0.45), care calculează EPS-ul altfel.',
    );
  });
});

describe('the note of a loss Nasdaq expected (FIX-EARNNOTE)', () => {
  it('writes Nasdaq’s bracketed loss with a minus inside the note', async () => {
    const { resultsNote } = await import('./service.ts');
    const r = { symbol: 'CRWV', day: '2026-11-10', eps: -0.947997, eps_forecast: -1.274255, eps_surprise_pct: 25.6, revenue: null, revenue_forecast: null, revenue_surprise_pct: null, currency: 'USD' };
    expect(resultsNote('CoreWeave', r, '($1.45)')).toBe(
      'CoreWeave a raportat: EPS -$0.95 față de -$1.27 estimat (+25,6%). Cifrele sunt de la TradingView. Înainte de rezultate, prognoza afișată era cea de la Nasdaq (-$1.45), care calculează EPS-ul altfel.',
    );
    // A profit stays as Nasdaq writes it.
    expect(resultsNote('CoreWeave', r, '$1.45')).toContain('cea de la Nasdaq ($1.45), care');
  });
});
