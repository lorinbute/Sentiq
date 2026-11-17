import { describe, expect, it } from 'vitest';
import { testDb } from '../test/db.ts';
import { silentLogger } from '../log.ts';
import { parseTradingView, type RawEvent } from '../calendar/sources.ts';
import { readJobData } from '../jobs/scheduler.ts';
import { ECON_SOURCE_COUNTRIES } from './names.ts';
import { ECON_JOB, EconomyService, fetchEconRange, indicatorKey, KEEP_MS, REKEY_DAYS, TV_CAP } from './service.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 12);
let nextId = 1;

interface Ev {
  id?: string;
  country: string;
  indicator: string;
  /** The event's title; the indicator's name when not given (as the source sent them until late Oct 2026). */
  title?: string;
  source?: string;
  ticker?: string | null;
  category?: string | null;
  date: number;
  period?: string;
  ref?: number;
  actual?: number | null;
  previous?: number | null;
  forecast?: number | null;
  importance?: number;
  unit?: string;
  scale?: string;
}

/** TradingView events as the source sends them, through the real parser. */
function tv(events: Ev[]): RawEvent[] {
  return parseTradingView(
    JSON.stringify({
      status: 'ok',
      result: events.map((e) => ({
        id: e.id ?? String(nextId++),
        title: e.title ?? e.indicator,
        country: e.country,
        indicator: e.indicator,
        ticker: e.ticker === undefined ? `ECONOMICS:${e.country}${e.indicator.replace(/\W/g, '').toUpperCase()}` : e.ticker,
        category: e.category === undefined ? 'prce' : e.category,
        period: e.period ?? '',
        referenceDate: e.ref ? new Date(e.ref).toISOString() : undefined,
        source: e.source ?? 'Bureau of Labor Statistics',
        source_url: 'https://www.bls.gov',
        comment: 'Consumer prices.',
        actual: e.actual ?? null,
        previous: e.previous ?? null,
        forecast: e.forecast ?? null,
        importance: e.importance ?? 0,
        unit: e.unit,
        scale: e.scale,
        currency: 'USD',
        date: new Date(e.date).toISOString(),
      })),
    }),
  );
}

const setup = async () => {
  const db = await testDb();
  return { db, econ: new EconomyService(db, silentLogger) };
};

describe('reading the source (TD-ECON §2)', () => {
  it('keeps the fields the Economy page needs, and drops only a malformed extra', () => {
    const [e] = tv([{ country: 'US', indicator: 'Inflation Rate', ticker: 'ECONOMICS:USIRYY', date: NOW, period: 'Sep', ref: Date.UTC(2026, 8, 30), actual: 2.9, previous: 2.7, forecast: 2.8, importance: 1, unit: '%' }]);
    expect(e?.tv).toMatchObject({ ticker: 'ECONOMICS:USIRYY', indicator: 'Inflation Rate', category: 'prce', referenceDate: Date.UTC(2026, 8, 30), source: 'Bureau of Labor Statistics', actual: 2.9, previous: 2.7, forecast: 2.8, importance: 1 });
    expect(e).toMatchObject({ source: 'tv', actual: '2.9', unit: '%' });
    const odd = parseTradingView(JSON.stringify({ result: [{ id: 1, title: 'X', country: 'US', date: new Date(NOW).toISOString(), comment: 5, ticker: { bad: true } }] }));
    expect(odd).toHaveLength(1);
    expect(odd[0]?.tv).toMatchObject({ comment: null, ticker: null });
  });

  it('reads a range again in halves when the answer reaches the cap', async () => {
    const calls: [number, number][] = [];
    const fetcher = async (from: number, to: number) => {
      calls.push([from, to]);
      const n = to - from > 10 * DAY ? TV_CAP : 3;
      // The same event at the boundary comes back in both halves.
      return tv(Array.from({ length: n }, (_, k) => ({ id: k === 0 ? 'edge' : `${from}-${k}`, country: 'US', indicator: 'X', date: from })));
    };
    const events = await fetchEconRange(0, 40 * DAY, ['US'], fetcher, 0);
    expect(calls.map(([a, b]) => (b - a) / DAY)).toEqual([40, 20, 10, 10, 20, 10, 10]);
    expect(events.filter((e) => e.extId === 'edge')).toHaveLength(1);
    expect(events).toHaveLength(1 + 4 * 2);
  });

  it('names an indicator by its ticker, else by country and name; placeholders are not indicators', () => {
    const [a, b, c] = tv([
      { country: 'US', indicator: 'U6 Unemployment Rate', ticker: null, date: NOW },
      { country: 'US', indicator: 'Calendar', ticker: null, date: NOW },
      { country: 'US', indicator: 'Non Farm Payrolls', ticker: 'ECONOMICS:USNFP', date: NOW },
    ]);
    expect(indicatorKey(a as RawEvent)).toBe('US:u6 unemployment rate');
    expect(indicatorKey(b as RawEvent)).toBeNull();
    expect(indicatorKey(c as RawEvent)).toBe('ECONOMICS:USNFP');
  });
});

describe('the Economy page (TD-ECON §4)', () => {
  it('shows the latest value, the revised previous, the next release and the history of each period', async () => {
    const { db, econ } = await setup();
    const cpi = (period: string, month: number, actual: number | null, previous: number | null, date: number, forecast: number | null = null) => ({
      country: 'US',
      indicator: 'Inflation Rate',
      ticker: 'ECONOMICS:USIRYY',
      period,
      ref: Date.UTC(2026, month, 28),
      actual,
      previous,
      forecast,
      date,
      importance: 1,
      unit: '%',
    });
    await econ.ingest(
      tv([
        cpi('Jul', 6, 2.7, 2.6, NOW - 60 * DAY),
        // August: the previous month revised from 2.7 to 2.8.
        cpi('Aug', 7, 2.9, 2.8, NOW - 30 * DAY, 2.8),
        cpi('Sep', 8, null, 2.9, NOW + 2 * DAY, 3),
        // Euro area: a flash estimate and a final one for August.
        { country: 'EU', indicator: 'Inflation Rate', ticker: 'ECONOMICS:EUIRYY', period: 'Aug', ref: Date.UTC(2026, 7, 31), actual: 3.3, previous: 2.9, date: NOW - 45 * DAY, unit: '%' },
        { country: 'EU', indicator: 'Inflation Rate', ticker: 'ECONOMICS:EUIRYY', period: 'Aug', ref: Date.UTC(2026, 7, 31), actual: 3.2, previous: 2.9, date: NOW - 28 * DAY, unit: '%' },
        // Germany: its inflation is not shown (the euro area has one), its Ifo is.
        { country: 'DE', indicator: 'Inflation Rate', period: 'Aug', actual: 3.3, date: NOW - 29 * DAY },
        { country: 'DE', indicator: 'Business Confidence', category: 'bsnss', period: 'Sep', actual: 89.9, previous: 88, date: NOW - 18 * DAY, importance: 1 },
        // A regional detail (low importance) and a member's indicator on the essential list (not essential there).
        { country: 'DE', indicator: 'Bavaria CPI YoY', period: 'Sep', actual: 0.6, date: NOW - 14 * DAY, importance: -1 },
        { country: 'FR', indicator: 'Government Bond 10Y', category: 'mrkt', period: '', actual: 3.4, date: NOW - DAY, importance: 0 },
        // Due two hours ago, no value yet.
        { country: 'US', indicator: 'Initial Jobless Claims', ticker: 'ECONOMICS:USIJC', category: 'lbr', period: 'Oct/03', actual: 197, previous: 205, date: NOW - 6 * DAY, scale: 'K' },
        { country: 'US', indicator: 'Initial Jobless Claims', ticker: 'ECONOMICS:USIJC', category: 'lbr', period: 'Oct/10', date: NOW - 2 * 3_600_000, forecast: 200, scale: 'K' },
        // A quarterly one whose next release is not scheduled yet; a PMI without a category.
        { country: 'US', indicator: 'GDP Growth Rate', category: 'gdp', period: 'Q2', actual: 2.2, previous: 1.4, date: NOW - 40 * DAY, unit: '%' },
        { country: 'US', indicator: 'Manufacturing PMI', category: null, period: 'Sep', actual: 52.1, date: NOW - 12 * DAY },
        // Only a future release: nothing to show yet.
        { country: 'US', indicator: 'Housing Starts', category: 'hse', period: 'Sep', date: NOW + 7 * DAY },
      ]),
      undefined,
      NOW,
    );
    const view = await econ.view(NOW);
    const us = view.countries.find((c) => c.code === 'US')!;
    const inflation = us.indicators.find((i) => i.key === 'ECONOMICS:USIRYY')!;
    expect(inflation).toMatchObject({
      name: 'Inflația (anuală)',
      original: 'Inflation Rate',
      group: 'prce',
      important: true,
      polarity: -1,
      latest: { value: 2.9, period: 'Aug', forecast: 2.8 },
      previous: 2.8,
      next: { ts: NOW + 2 * DAY, forecast: 3, overdue: false },
      history: [
        ['Jul', 2.7],
        ['Aug', 2.9],
      ],
      source: 'Bureau of Labor Statistics',
      hasDescription: true,
    });
    expect(await econ.description('ECONOMICS:USIRYY')).toBe('Consumer prices.');
    expect(await econ.description('nope')).toBeNull();
    expect(inflation.change).toBeCloseTo(0.1, 10);
    expect(inflation.explanation).toMatch(/Inflația/);
    expect(us.indicators.find((i) => i.key === 'ECONOMICS:USIJC')).toMatchObject({ name: 'Cereri inițiale de șomaj', latest: { value: 197 }, next: { overdue: true, forecast: 200 }, scale: 'K' });
    expect(us.indicators.find((i) => i.original === 'GDP Growth Rate')).toMatchObject({ group: 'gdp', next: null, important: true });
    expect(us.indicators.find((i) => i.original === 'Manufacturing PMI')).toMatchObject({ group: 'bsnss', important: true });
    expect(us.indicators.some((i) => i.original === 'Housing Starts')).toBe(false);
    const eu = view.countries.find((c) => c.code === 'EU')!;
    expect(eu.name).toBe('Zona euro (UE)');
    expect(eu.indicators.find((i) => i.key === 'ECONOMICS:EUIRYY')).toMatchObject({ latest: { value: 3.2 }, history: [['Aug', 3.2]] });
    expect(eu.indicators.map((i) => [i.original, i.countryName, i.important])).toEqual([
      ['Inflation Rate', null, true],
      ['Business Confidence', 'Germania', true],
      ['Government Bond 10Y', 'Franța', false],
    ]);
    expect(view.countries.map((c) => c.code)).toEqual(['US', 'EU', 'GB', 'JP', 'CN', 'CA', 'CH', 'AU', 'NZ']);
    expect(view.updatedAt).toBe(NOW);
  });

  it('keeps 26 weeks of a weekly series and 13 periods of a monthly one', async () => {
    const { db, econ } = await setup();
    await econ.ingest(
      tv([
        ...Array.from({ length: 40 }, (_, k) => ({ country: 'US', indicator: 'Initial Jobless Claims', ticker: 'W', category: 'lbr', period: `w${k}`, ref: NOW - (41 - k) * 7 * DAY, actual: 200 + k, date: NOW - (40 - k) * 7 * DAY })),
        ...Array.from({ length: 20 }, (_, k) => ({ country: 'US', indicator: 'Retail Sales MoM', ticker: 'M', category: 'cnsm', period: `m${k}`, ref: NOW - (21 - k) * 30 * DAY, actual: k, date: NOW - (20 - k) * 30 * DAY })),
      ]),
      undefined,
      NOW,
    );
    const us = (await econ.view(NOW)).countries[0]!;
    expect(us.indicators.find((i) => i.key === 'W')?.history).toHaveLength(26);
    expect(us.indicators.find((i) => i.key === 'M')?.history).toHaveLength(13);
    expect(us.indicators.find((i) => i.key === 'M')?.history.at(-1)?.[1]).toBe(19);
  });

  it('drops a scheduled release the source no longer lists, never a published one, never on an empty answer', async () => {
    const { db, econ } = await setup();
    const range = { from: NOW - 7 * DAY, to: NOW + 14 * DAY, countries: ['US'] };
    await econ.ingest(
      tv([
        { id: 'past', country: 'US', indicator: 'Retail Sales MoM', ticker: 'R', category: 'cnsm', actual: 0.4, date: NOW - DAY },
        { id: 'moved', country: 'US', indicator: 'Retail Sales MoM', ticker: 'R', category: 'cnsm', date: NOW + 3 * DAY },
      ]),
      range,
      NOW,
    );
    await econ.ingest([], range, NOW);
    expect((await db.get<{ n: number }>('SELECT count(*) AS n FROM econ_releases'))?.n).toBe(2);
    await econ.ingest(tv([{ id: 'new-date', country: 'US', indicator: 'Retail Sales MoM', ticker: 'R', category: 'cnsm', date: NOW + 5 * DAY }]), range, NOW);
    expect((await db.all<{ id: string }>('SELECT id FROM econ_releases ORDER BY id')).map((r) => r.id)).toEqual(['new-date', 'past']);
    // A value the source stops sending stays; a corrected one replaces it.
    await econ.ingest(tv([{ id: 'past', country: 'US', indicator: 'Retail Sales MoM', ticker: 'R', category: 'cnsm', actual: null, date: NOW - DAY }]), undefined, NOW);
    expect(await db.get('SELECT actual FROM econ_releases WHERE id = ?', ['past'])).toEqual({ actual: 0.4 });
    await econ.ingest(tv([{ id: 'past', country: 'US', indicator: 'Retail Sales MoM', ticker: 'R', category: 'cnsm', actual: 0.5, date: NOW - DAY }]), undefined, NOW);
    expect(await db.get('SELECT actual FROM econ_releases WHERE id = ?', ['past'])).toEqual({ actual: 0.5 });
    // Two years later the release and its indicator go.
    expect(await econ.prune(NOW + KEEP_MS + 10 * DAY)).toBe(2);
    expect(await db.get('SELECT 1 AS x FROM econ_indicators')).toBeUndefined();
  });
});

describe('history and schedule (TD-ECON §3)', () => {
  it('reads each country once, retries a failed one, then reads the schedule ahead', async () => {
    const { db, econ } = await setup();
    const asked: string[] = [];
    let failGB = true;
    const fetcher = async (from: number, to: number, countries: readonly string[]) => {
      asked.push(`${countries.join(',')}:${Math.round((to - from) / DAY)}`);
      if (countries[0] === 'GB' && countries.length === 1 && failGB) throw new Error('HTTP 503');
      return tv([{ country: countries[0] as string, indicator: 'Inflation Rate', actual: 2, date: from + DAY }]);
    };
    expect(await econ.backfill(fetcher, undefined, NOW, 0)).toHaveLength(ECON_SOURCE_COUNTRIES.length - 1);
    expect(await econ.historyReady()).toBe(false);
    failGB = false;
    asked.length = 0;
    expect(await econ.backfill(fetcher, undefined, NOW, 0)).toEqual(['GB']);
    expect(asked).toEqual(['GB:393']);
    expect(await econ.historyReady()).toBe(true);
    expect((await readJobData<{ done: string[] }>(db, ECON_JOB, { done: [] })).done).toHaveLength(ECON_SOURCE_COUNTRIES.length);
    expect(await econ.backfill(fetcher, undefined, NOW, 0)).toEqual([]);
    asked.length = 0;
    await econ.refreshSchedule(fetcher, NOW);
    expect(asked).toEqual([`${ECON_SOURCE_COUNTRIES.join(',')}:46`]);
  });
});

describe('the Calendar feeding the Economy page (FD-ECON §3)', () => {
  it('passes the same answer on, never failing the Calendar, never trusting a cut answer', async () => {
    const { db, econ } = await setup();
    const answer = tv([{ id: 'r1', country: 'US', indicator: 'Retail Sales MoM', ticker: 'R', category: 'cnsm', actual: 0.4, date: NOW - DAY }]);
    const feed = (await import('./service.ts')).feedingEconomy(econ, silentLogger, async () => answer);
    expect(await feed(NOW - 7 * DAY, NOW + 14 * DAY)).toBe(answer);
    expect((await db.get<{ n: number }>('SELECT count(*) AS n FROM econ_releases'))?.n).toBe(1);
    // The Economy side failing: the Calendar still gets its events.
    const broken = { ingest: () => { throw new Error('disk full'); } } as unknown as EconomyService;
    expect(await (await import('./service.ts')).feedingEconomy(broken, silentLogger, async () => answer)(0, 1)).toBe(answer);
    // An answer at the cap may be cut: a scheduled release missing from it stays.
    await econ.ingest(tv([{ id: 'later', country: 'US', indicator: 'Retail Sales MoM', ticker: 'R', category: 'cnsm', date: Date.now() + 10 * DAY }]));
    const full = tv(Array.from({ length: TV_CAP }, (_, k) => ({ id: `f${k}`, country: 'US', indicator: 'Other', date: NOW - DAY })));
    await econ.ingest(full, { from: NOW - 7 * DAY, to: Date.now() + 14 * DAY, countries: ['US'] });
    expect(await db.get('SELECT id FROM econ_releases WHERE id = ?', ['later'])).toEqual({ id: 'later' });
  });
});

describe('the sense of each indicator (FD-ECONCOLOR, research §11)', () => {
  it('knows when a rise is good, bad or neither', async () => {
    const { polarityOf } = await import('./names.ts');
    const good = [
      ['gdp', 'GDP Growth Rate'],
      ['lbr', 'Non Farm Payrolls'],
      ['lbr', 'Job Offers'],
      ['bsnss', 'Ifo Expectations'],
      [null, 'Manufacturing PMI'],
      ['cnsm', 'Retail Sales MoM'],
      ['hse', 'Housing Starts'],
      ['trd', 'Balance of Trade'],
      ['gov', 'Government Budget Value'],
      ['mny', 'New Bank Loans'],
    ] as const;
    const bad = [
      ['prce', 'Inflation Rate'],
      ['prce', 'Core PCE Price Index MoM'],
      ['prce', 'Bavaria CPI YoY'],
      ['bsnss', 'ISM Manufacturing Prices'],
      ['bsnss', 'Philly Fed Prices Paid'],
      ['cnsm', 'Used Car Prices YoY'],
      ['lbr', 'Unemployment Rate'],
      ['lbr', 'Initial Jobless Claims'],
      ['lbr', 'Challenger Job Cuts'],
      ['mny', 'Interest Rate'],
      ['hse', '30 Year Mortgage Rate'],
      ['mrkt', 'Government Bond 10Y'],
      ['bnd', '2 Year Note Yield'],
      ['gov', 'Government Debt to GDP'],
    ] as const;
    const neither = [
      ['lbr', 'Average Hourly Earnings'],
      ['bsnss', 'Business Inventories'],
      ['enrg', 'Crude Oil Stocks Change'],
      ['hse', 'Case Shiller Home Price Index YoY'],
      ['trd', 'Imports'],
      ['mny', 'Money Supply M2'],
      ['prce', 'Export Prices YoY'],
    ] as const;
    for (const [c, n] of good) expect(polarityOf(c, n), n).toBe(1);
    for (const [c, n] of bad) expect(polarityOf(c, n), n).toBe(-1);
    for (const [c, n] of neither) expect(polarityOf(c, n), n).toBe(0);
    // A name the list does not know follows its group.
    expect(polarityOf('prce', 'Brand New Price Gauge')).toBe(-1);
    expect(polarityOf('cnsm', 'Brand New Spending Gauge')).toBe(1);
    expect(polarityOf('enrg', 'Brand New Energy Gauge')).toBe(0);
  });
});

describe('the source renaming its indicators (FD-CALACTUAL §4)', () => {
  /** A row stored by the version before: a ticker-less indicator under "country:name", with one release. */
  const leftover = async (db: Awaited<ReturnType<typeof testDb>>, key: string, name: string, id: string, ts: number, actual: number | null, importance = -1) => {
    await db.run('INSERT INTO econ_indicators([key], country, name, category, importance, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [key, key.slice(0, 2), name, 'prce', importance, 'Bureau of Labor Statistics', 1]);
    await db.run('INSERT INTO econ_releases(id, [key], ts, period, actual, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', [id, key, ts, id, actual, 1]);
  };
  const keys = async (db: Awaited<ReturnType<typeof testDb>>) => (await db.all<{ key: string }>('SELECT [key] FROM econ_indicators ORDER BY [key]')).map((r) => r.key);

  it('a renamed indicator keeps its Romanian name and sense through its former name (the title); an unrelated title changes nothing', async () => {
    const { econ } = await setup();
    await econ.ingest(
      tv([
        { country: 'US', title: 'Core Inflation Rate MoM', indicator: 'Core CPI MM, SA', ticker: 'ECONOMICS:USCIRMM', actual: 0.3, previous: 0.2, date: NOW - DAY, importance: 1 },
        // The source puts the German rate's ticker on a speech: the known name stays the indicator's own.
        { country: 'DE', title: 'Bundesbank Speech', indicator: 'Interest Rate', ticker: 'ECONOMICS:DEINTR', category: 'mny', actual: 2, date: NOW - DAY },
      ]),
      undefined,
      NOW,
    );
    const view = await econ.view(NOW);
    expect(view.countries[0]!.indicators[0]).toMatchObject({ key: 'ECONOMICS:USCIRMM', name: 'Inflația de bază (lunară)', original: 'Core CPI MM, SA', polarity: -1, group: 'prce' });
    expect(view.countries[0]!.indicators[0]?.explanation).toMatch(/Inflația/);
    const de = view.countries.find((c) => c.code === 'EU')!.indicators.find((i) => i.key === 'ECONOMICS:DEINTR');
    expect(de).toMatchObject({ original: 'Interest Rate', countryName: 'Germania' });
    expect(de?.name).not.toBe('Bundesbank Speech');
  });

  it('a ticker added and a short name: the rows left behind join it, a release sent twice is kept once, with its value', async () => {
    const { db, econ } = await setup();
    const title = 'PPI Ex Food Energy and Trade Services MoM';
    // Stored before: under the title (until late Oct), then under the short name, the October release with its value.
    await leftover(db, 'US:ppi ex food energy and trade services mom', title, 'aug', NOW - 60 * DAY, 0.3, 1);
    await db.run('INSERT INTO econ_releases(id, [key], ts, period, actual, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', ['sep', 'US:ppi ex food energy and trade services mom', NOW - 30 * DAY, 'Sep', 0.5, 1]);
    await leftover(db, 'US:ppi ex food/energy/tr mm', 'PPI ex Food/Energy/Tr MM', 'oct-old', NOW - DAY, 0.4);
    // Now: a ticker, the short name, the same October release under a new id (no value yet), and November ahead.
    await econ.ingest(
      tv([
        { id: 'oct-new', country: 'US', title, indicator: 'PPI ex Food/Energy/Tr MM', ticker: 'ECONOMICS:USPPIEFETSMM', actual: null, date: NOW - DAY },
        { id: 'nov', country: 'US', title, indicator: 'PPI ex Food/Energy/Tr MM', ticker: 'ECONOMICS:USPPIEFETSMM', date: NOW + 30 * DAY },
      ]),
      undefined,
      NOW,
    );
    expect(await keys(db)).toEqual(['ECONOMICS:USPPIEFETSMM']);
    // October twice: the one with a value counts (the new id, without one yet, stays for when its value comes).
    expect((await db.all<{ id: string }>('SELECT id FROM econ_releases ORDER BY ts, id')).map((r) => r.id)).toEqual(['aug', 'sep', 'oct-new', 'oct-old', 'nov']);
    const [i] = (await econ.view(NOW)).countries[0]!.indicators;
    expect(i).toMatchObject({ key: 'ECONOMICS:USPPIEFETSMM', original: 'PPI ex Food/Energy/Tr MM', latest: { value: 0.4 }, next: { ts: NOW + 30 * DAY, overdue: false }, important: true });
    expect(i?.history.map((h) => h[1])).toEqual([0.3, 0.5, 0.4]);
    // Sent again with its value: the new id's value wins over nothing; the old one, a duplicate now, goes.
    await leftover(db, 'US:ppi ex food/energy/tr mm', 'PPI ex Food/Energy/Tr MM', 'oct-dup', NOW - DAY, null);
    await econ.ingest(tv([{ id: 'oct-new', country: 'US', title, indicator: 'PPI ex Food/Energy/Tr MM', ticker: 'ECONOMICS:USPPIEFETSMM', actual: 0.5, date: NOW - DAY }]), undefined, NOW);
    expect(await keys(db)).toEqual(['ECONOMICS:USPPIEFETSMM']);
    expect((await db.all<{ id: string }>("SELECT id FROM econ_releases WHERE id LIKE 'oct%' ORDER BY id")).map((r) => r.id)).toEqual(['oct-new', 'oct-old']);
    // Both with a value: the one read last.
    expect((await econ.view(NOW + 61_000)).countries[0]!.indicators[0]?.latest.value).toBe(0.5);
  });

  it('a ticker lost: the event stays with the coded indicator of the same name, unless two have it', async () => {
    const { db, econ } = await setup();
    await econ.ingest(tv([{ id: 'r1', country: 'FR', indicator: 'Current Account', ticker: 'ECONOMICS:FRCA', category: 'trd', actual: -1.2, date: NOW - 30 * DAY }]), undefined, NOW);
    await econ.ingest(tv([{ id: 'r2', country: 'FR', indicator: 'Current Account', ticker: null, category: 'trd', date: NOW + 25 * DAY }]), undefined, NOW);
    expect(await keys(db)).toEqual(['ECONOMICS:FRCA']);
    expect(await db.get('SELECT [key] FROM econ_releases WHERE id = ?', ['r2'])).toEqual({ key: 'ECONOMICS:FRCA' });
    // Two coded indicators of that name in Japan: which one is unknown, so the event keeps its own key.
    await econ.ingest(
      tv([
        { country: 'JP', indicator: 'Machinery Orders', ticker: 'ECONOMICS:JPMO1', actual: 1, date: NOW - 30 * DAY },
        { country: 'JP', indicator: 'Machinery Orders', ticker: 'ECONOMICS:JPMO2', actual: 2, date: NOW - 30 * DAY },
      ]),
      undefined,
      NOW,
    );
    await econ.ingest(tv([{ country: 'JP', indicator: 'Machinery Orders', ticker: null, date: NOW + DAY }]), undefined, NOW);
    expect(await keys(db)).toContain('JP:machinery orders');
  });

  it('leaves alone a key still used by an event of the same answer, and one that would join two indicators', async () => {
    const { db, econ } = await setup();
    await leftover(db, 'GB:retail price index mom', 'Retail Price Index MoM', 'old', NOW - 30 * DAY, 0.2);
    await econ.ingest(
      tv([
        // Two coded indicators claim the same title: ambiguous.
        { country: 'GB', title: 'Retail Price Index MoM', indicator: 'RPI MM*', ticker: 'ECONOMICS:GBRPIMM', actual: 0.3, date: NOW - DAY },
        { country: 'GB', title: 'Retail Price Index MoM', indicator: 'RPI MM (2)*', ticker: 'ECONOMICS:GBRPIMM2', actual: 0.3, date: NOW - DAY },
        // Its short name is the title of an indicator in the same answer: that one is live.
        { country: 'GB', title: 'House Price Index', indicator: 'House Price Index', ticker: null, actual: 1, date: NOW - DAY },
        { country: 'GB', title: 'Halifax House Price Index', indicator: 'House Price Index', ticker: 'ECONOMICS:GBHPI', actual: 1, date: NOW - DAY },
      ]),
      undefined,
      NOW,
    );
    expect(await keys(db)).toEqual(['ECONOMICS:GBHPI', 'ECONOMICS:GBRPIMM', 'ECONOMICS:GBRPIMM2', 'GB:house price index', 'GB:retail price index mom']);
  });

  it('published without its value: the same institution’s other values of that moment came', async () => {
    const { econ } = await setup();
    const at = NOW - 3_600_000;
    await econ.ingest(
      tv([
        { country: 'US', indicator: 'Producer Price Index', ticker: 'ECONOMICS:USPPI', actual: 159.78, date: NOW - 30 * DAY },
        { country: 'US', indicator: 'Producer Price Index', ticker: 'ECONOMICS:USPPI', actual: null, date: at },
        { country: 'US', indicator: 'PPI MoM', ticker: 'ECONOMICS:USPPIMM', actual: 0.3, date: at },
        // USDA at the same moment, its own release without a value: another institution's values say nothing.
        { country: 'US', indicator: 'Corn Export Sales', ticker: 'ECONOMICS:USCORN', source: 'USDA', actual: 10, date: NOW - 7 * DAY },
        { country: 'US', indicator: 'Corn Export Sales', ticker: 'ECONOMICS:USCORN', source: 'USDA', actual: null, date: NOW - 2 * 3_600_000 },
      ]),
      undefined,
      NOW,
    );
    const us = (await econ.view(NOW)).countries[0]!.indicators;
    expect(us.find((i) => i.key === 'ECONOMICS:USPPI')?.next).toEqual({ ts: at, forecast: null, overdue: true, released: true });
    expect(us.find((i) => i.key === 'ECONOMICS:USCORN')?.next).toEqual({ ts: NOW - 2 * 3_600_000, forecast: null, overdue: true });
  });

  it('reads the last 60 days of each country again once, after its history, retrying a failed one', async () => {
    const { db, econ } = await setup();
    const { writeJobData } = await import('../jobs/scheduler.ts');
    // A server that read every history before the renames were handled.
    await writeJobData(db, ECON_JOB, { done: [...ECON_SOURCE_COUNTRIES] });
    const asked: string[] = [];
    let failJP = true;
    const fetcher = async (from: number, to: number, countries: readonly string[]) => {
      asked.push(`${countries.join(',')}:${Math.round((to - from) / DAY)}`);
      if (countries[0] === 'JP' && failJP) throw new Error('HTTP 503');
      return tv([{ country: countries[0] as string, indicator: 'Inflation Rate', actual: 2, date: from + DAY }]);
    };
    expect(await econ.backfill(fetcher, undefined, NOW, 0)).toEqual([]);
    expect(asked).toEqual(ECON_SOURCE_COUNTRIES.map((c) => `${c}:${REKEY_DAYS - 7}`));
    failJP = false;
    asked.length = 0;
    await econ.backfill(fetcher, undefined, NOW, 0);
    expect(asked).toEqual([`JP:${REKEY_DAYS - 7}`]);
    asked.length = 0;
    await econ.backfill(fetcher, undefined, NOW, 0);
    expect(asked).toEqual([]);
    expect((await readJobData<{ rekeyed: string[] }>(db, ECON_JOB, { rekeyed: [] })).rekeyed).toHaveLength(ECON_SOURCE_COUNTRIES.length);
  });
});

describe('a renamed indicator joined with its Romanian name (FD-CALACTUAL §4)', () => {
  it('a ticker and a new short name: the former row joins it, and the title (its former name) keeps the Romanian name', async () => {
    const { db, econ } = await setup();
    // Stored before the rename, under its former name (known to the page), with a release.
    await db.run('INSERT INTO econ_indicators([key], country, name, category, importance, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['US:u6 unemployment rate', 'US', 'U6 Unemployment Rate', 'lbr', 0, 1]);
    await db.run('INSERT INTO econ_releases(id, [key], ts, period, actual, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', ['sep', 'US:u6 unemployment rate', NOW - 35 * DAY, 'Sep', 7.6, 1]);
    // Now: a ticker and a short name the page does not know; the title is still the former name.
    await econ.ingest(tv([{ id: 'oct', country: 'US', title: 'U6 Unemployment Rate', indicator: 'U6 Underemployment', ticker: 'ECONOMICS:USU6UR', category: 'lbr', actual: 7.9, date: NOW - 5 * DAY }]), undefined, NOW);
    const [i] = (await econ.view(NOW)).countries[0]!.indicators;
    expect(i).toMatchObject({ key: 'ECONOMICS:USU6UR', name: 'Rata șomajului U6 (extinsă)', original: 'U6 Underemployment', polarity: -1 });
    expect(i?.history.map((h) => h[1])).toEqual([7.6, 7.9]);
  });
});
