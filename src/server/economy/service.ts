// Economic indicators by country (FD-ECON, TD-ECON §2–§5), from the TradingView calendar: the Calendar's own reads
// keep the latest values fresh; this service adds ~400 days of history once and the release schedule daily.
import { explain } from '../calendar/glossary.ts';
import { fetchTradingView, TV_COUNTRIES, type RawEvent } from '../calendar/sources.ts';
import type { Db } from '../db/database.ts';
import { BIN } from '../db/schema.ts';
import { readJobData, writeJobData } from '../jobs/scheduler.ts';
import type { Logger } from '../log.ts';
import { ECON_COUNTRIES, ECON_SOURCE_COUNTRIES, ESSENTIAL, EU_MEMBERS, groupOf, knownName, polarityOf, RO_EXPLAIN, RO_NAMES, type EconGroup, type Polarity } from './names.ts';

export const ECON_JOB = 'econ.history';
/** The source answers at most this many events per request: a full answer may be cut, so the range is split. */
export const TV_CAP = 2000;
const DAY = 86_400_000;
export const HISTORY_DAYS = 400;
/** The schedule is read this far ahead (the source publishes ~5 weeks). */
export const SCHEDULE_DAYS = 60;
export const KEEP_MS = 730 * DAY;
/** FD-CALACTUAL §4: read again once per country, so the rows the source's renames left behind join their indicator. */
export const REKEY_DAYS = 60;
const VIEW_TTL_MS = 60_000;
/** Placeholders of the source, not indicators. */
const NOT_INDICATORS = new Set(['calendar', 'holidays']);

export type EconFetcher = (from: number, to: number, countries: readonly string[]) => Promise<RawEvent[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Events of [from, to] for `countries`; a range whose answer reaches the source's cap is read again in halves. */
export async function fetchEconRange(from: number, to: number, countries: readonly string[], fetcher: EconFetcher = fetchTradingView, pauseMs = 500): Promise<RawEvent[]> {
  const events = await fetcher(from, to, countries);
  if (events.length < TV_CAP || to - from <= DAY) return events;
  const mid = from + Math.floor((to - from) / 2);
  const first = await fetchEconRange(from, mid, countries, fetcher, pauseMs);
  if (pauseMs > 0) await sleep(pauseMs);
  const second = await fetchEconRange(mid, to, countries, fetcher, pauseMs);
  // An event right at the boundary can come back in both halves.
  const seen = new Set<string>();
  return [...first, ...second].filter((e) => (seen.has(e.extId) ? false : (seen.add(e.extId), true)));
}

/**
 * The Calendar's TradingView reader, also feeding the Economy page with the same answer (FD-ECON §3: fresh values
 * without requests of its own). A failure on the Economy side never fails the Calendar.
 */
export function feedingEconomy(economy: EconomyService, log: Logger, fetcher: (from: number, to: number) => Promise<RawEvent[]> = (from, to) => fetchTradingView(from, to)) {
  return async (from: number, to: number): Promise<RawEvent[]> => {
    const events = await fetcher(from, to);
    try {
      await economy.ingest(events, { from, to, countries: TV_COUNTRIES });
    } catch (err) {
      log.warn(`economy: ${(err as Error).message}`);
    }
    return events;
  };
}

/** The indicator an event belongs to: the source's ticker, or "country:name" for the few without one. */
export function indicatorKey(e: RawEvent): string | null {
  const name = e.tv?.indicator;
  if (!e.tv || !name || !e.country || NOT_INDICATORS.has(name.toLowerCase())) return null;
  return e.tv.ticker || `${e.country.toUpperCase()}:${name.toLowerCase()}`;
}

/**
 * FD-CALACTUAL §4: a name the page knows (Romanian name, explanation, "essential") for an indicator whose own name it
 * does not know: in late Oct 2026 the source renamed many indicators ("Core Inflation Rate MoM" became "Core CPI MM,
 * SA"); the event's title often still is the former name. Null when the own name is known, or the title is not either.
 */
export function knownAltName(e: RawEvent): string | null {
  const own = (e.tv?.indicator ?? '').trim().toLowerCase();
  const title = e.title.trim();
  return !knownName(own) && knownName(title.toLowerCase()) ? title : null;
}

export interface EconRelease {
  value: number;
  period: string | null;
  ts: number;
  forecast: number | null;
}

export interface EconIndicator {
  key: string;
  /** Country of the data (a member state inside the euro-area group). */
  country: string;
  countryName: string | null;
  group: EconGroup;
  /** Romanian name when known, else the source's. */
  name: string;
  original: string;
  unit: string | null;
  scale: string | null;
  important: boolean;
  /** 1 = a rise is good for the economy, -1 = bad, 0 = neither (FD-ECONCOLOR). */
  polarity: Polarity;
  latest: EconRelease;
  /** The previous period's value, as revised in the latest release. */
  previous: number | null;
  change: number | null;
  /**
   * `overdue`: its time has passed without a value; `released`: other indicators of the same country and institution
   * have their values from that moment, so it was published and only this value has not come from the source yet.
   */
  next: { ts: number; forecast: number | null; overdue: boolean; released?: boolean } | null;
  /** [period, value], oldest first (tuples: ~650 indicators × 13 periods make a sizeable answer). */
  history: [string | null, number][];
  source: string | null;
  sourceUrl: string | null;
  explanation: string | null;
  /** The source's description exists (in English; read with `description(key)`, kept out of the page's answer). */
  hasDescription: boolean;
}

export interface EconomyView {
  updatedAt: number | null;
  historyReady: boolean;
  countries: { code: string; name: string; indicators: EconIndicator[] }[];
}

interface IndicatorRow {
  key: string;
  country: string;
  name: string;
  category: string | null;
  unit: string | null;
  scale: string | null;
  importance: number;
  source: string | null;
  source_url: string | null;
  /** 1 when the source's description is stored (the text itself is read on demand). */
  has_comment: number;
  /** FD-CALACTUAL §4: the former name the page knows, for an indicator the source renamed. */
  alt_name: string | null;
}

interface ReleaseRow {
  id: string;
  key: string;
  ts: number;
  period: string | null;
  reference_date: number | null;
  actual: number | null;
  previous: number | null;
  forecast: number | null;
  fetched_at: number;
}

interface BackfillState {
  /** Countries whose history has been read (a failed one is retried at the next run). */
  done: string[];
  /** FD-CALACTUAL §4: countries whose last REKEY_DAYS were read again to join what renames left behind (once each). */
  rekeyed?: string[];
}

export class EconomyService {
  private readonly db: Db;
  private readonly log: Logger;
  private cache: { at: number; view: EconomyView } | null = null;

  constructor(db: Db, log: Logger) {
    this.db = db;
    this.log = log;
  }

  /**
   * Stores the indicators and releases of `events`. With a range, unreleased releases of those countries inside it
   * that the answer no longer has (moved or cancelled) are removed, as the Calendar does with its events.
   */
  async ingest(events: RawEvent[], range?: { from: number; to: number; countries: readonly string[] }, now = Date.now()): Promise<number> {
    // The rows of `events` folded per indicator / release, as upserting them one after the other did: the last name and
    // time win, a value the source stops sending is kept (the last one that was sent), the importance only grows.
    const indicators = new Map<string, Record<string, string | number | null>>();
    const releases = new Map<string, Record<string, string | number | null>>();
    const keep = <T,>(next: T | null | undefined, prev: T | null | undefined): T | null => (next ?? prev ?? null) as T | null;
    let stored = 0;
    const ids: string[] = [];
    // FD-CALACTUAL §4: an event that lost its ticker stays with the coded indicator of the same name (the only one of
    // its country), and the keys the source's renames left behind join the event's indicator.
    const coded = new Map<string, string[]>();
    if (events.some((e) => e.tv && !e.tv.ticker)) {
      for (const r of await this.db.all<{ key: string; country: string; name: string }>('SELECT [key], country, name FROM econ_indicators')) {
        if (r.key.startsWith(`${r.country}:`)) continue;
        const k = `${r.country}|${r.name.toLowerCase()}`;
        (coded.get(k) ?? coded.set(k, []).get(k))!.push(r.key);
      }
    }
    const aliasTo = new Map<string, Set<string>>();
    const live = new Set<string>();
    for (const e of events) {
      let key = indicatorKey(e);
      if (!key || !e.tv) continue;
      const tv = e.tv;
      const country = (e.country ?? '').toUpperCase();
      const name = (tv.indicator ?? '').trim();
      if (!tv.ticker) {
        const same = coded.get(`${country}|${name.toLowerCase()}`);
        if (same?.length === 1) key = same[0] as string;
      }
      live.add(key);
      // The keys of the indicator before a rename: its short name without a ticker, or the title (the name it had).
      for (const a of [`${country}:${name.toLowerCase()}`, `${country}:${e.title.trim().toLowerCase()}`]) {
        if (a !== key) (aliasTo.get(a) ?? aliasTo.set(a, new Set()).get(a))!.add(key);
      }
      const old = indicators.get(key);
      indicators.set(key, {
        key,
        country: old ? (old.country as string) : country,
        name,
        category: keep(tv.category, old?.category as string | null),
        unit: keep(e.unit, old?.unit as string | null),
        scale: keep(e.scale, old?.scale as string | null),
        currency: keep(e.currency || null, old?.currency as string | null),
        importance: Math.max(tv.importance ?? -1, (old?.importance as number | undefined) ?? -Infinity),
        source: keep(tv.source, old?.source as string | null),
        source_url: keep(tv.sourceUrl, old?.source_url as string | null),
        comment: keep(tv.comment, old?.comment as string | null),
        alt_name: keep(knownAltName(e), old?.alt_name as string | null),
        updated_at: now,
      });
      const id = String(e.extId);
      const prev = releases.get(id);
      releases.set(id, {
        id,
        key,
        ts: e.ts,
        period: e.period,
        reference_date: tv.referenceDate,
        actual: keep(tv.actual, prev?.actual as number | null),
        previous: keep(tv.previous, prev?.previous as number | null),
        forecast: keep(tv.forecast, prev?.forecast as number | null),
        fetched_at: now,
      });
      ids.push(id);
      stored++;
    }
    // A leftover is a key no event of this answer uses, pointing at a single indicator (anything else is ambiguous).
    const candidates = [...aliasTo]
      .filter(([from, to]) => to.size === 1 && !live.has(from))
      .map(([from, to]) => ({ from, to: [...to][0] as string }));
    let merges: { from: string; to: string }[] = [];
    const ind = JSON.stringify([...indicators.values()]);
    const rel = JSON.stringify([...releases.values()]);
    const IND = `OPENJSON(?) WITH ([key] nvarchar(200), country nvarchar(16), name nvarchar(max), category nvarchar(max), unit nvarchar(max), scale nvarchar(max),
      currency nvarchar(max), importance int, source nvarchar(max), source_url nvarchar(max), comment nvarchar(max), alt_name nvarchar(max), updated_at bigint) j`;
    const REL = `OPENJSON(?) WITH (id nvarchar(100), [key] nvarchar(200), ts bigint, period nvarchar(max), reference_date bigint, actual float, previous float,
      forecast float, fetched_at bigint) j`;
    await this.db.tx(async () => {
      if (indicators.size) {
        await this.db.run(
          `UPDATE i SET name = j.name, category = COALESCE(j.category, i.category), unit = COALESCE(j.unit, i.unit), scale = COALESCE(j.scale, i.scale),
             currency = COALESCE(j.currency, i.currency), importance = CASE WHEN j.importance > i.importance THEN j.importance ELSE i.importance END,
             source = COALESCE(j.source, i.source), source_url = COALESCE(j.source_url, i.source_url), comment = COALESCE(j.comment, i.comment),
             alt_name = COALESCE(j.alt_name, i.alt_name), updated_at = j.updated_at
           FROM econ_indicators i JOIN ${IND} ON i.[key] = j.[key] COLLATE ${BIN}`,
          [ind],
        );
        await this.db.run(
          `INSERT INTO econ_indicators([key], country, name, category, unit, scale, currency, importance, source, source_url, comment, alt_name, updated_at)
           SELECT j.[key], j.country, j.name, j.category, j.unit, j.scale, j.currency, j.importance, j.source, j.source_url, j.comment, j.alt_name, j.updated_at
           FROM ${IND} WHERE NOT EXISTS (SELECT 1 FROM econ_indicators i WHERE i.[key] = j.[key] COLLATE ${BIN})`,
          [ind],
        );
        // A value the source stops sending (a glitch) is kept; a corrected one replaces it.
        await this.db.run(
          `UPDATE r SET [key] = j.[key], ts = j.ts, period = j.period, reference_date = j.reference_date, actual = COALESCE(j.actual, r.actual),
             previous = COALESCE(j.previous, r.previous), forecast = COALESCE(j.forecast, r.forecast), fetched_at = j.fetched_at
           FROM econ_releases r JOIN ${REL} ON r.id = j.id COLLATE ${BIN}`,
          [rel],
        );
        await this.db.run(
          `INSERT INTO econ_releases(id, [key], ts, period, reference_date, actual, previous, forecast, fetched_at)
           SELECT j.id, j.[key], j.ts, j.period, j.reference_date, j.actual, j.previous, j.forecast, j.fetched_at
           FROM ${REL} WHERE NOT EXISTS (SELECT 1 FROM econ_releases r WHERE r.id = j.id COLLATE ${BIN})`,
          [rel],
        );
      }
      const M = `OPENJSON(?) WITH ([from] nvarchar(200), [to] nvarchar(200)) m`;
      if (candidates.length) {
        // Only the leftovers that exist (most candidates are names never stored under a key of their own).
        // (A leftover's name is the title or the short name its key was made of: the title's known name covers it.)
        const existing = new Set(
          (await this.db.all<{ key: string }>(`SELECT i.[key] FROM econ_indicators i JOIN ${M} ON i.[key] = m.[from] COLLATE ${BIN}`, [JSON.stringify(candidates)])).map((r) => r.key),
        );
        merges = candidates.filter((m) => existing.has(m.from));
      }
      if (merges.length) {
        const json = JSON.stringify(merges);
        // A release the leftover shares with its indicator (same moment, the source gave it a new id): one is kept, the
        // one with a value.
        await this.db.run(
          `DELETE a FROM econ_releases a JOIN ${M} ON a.[key] = m.[from] COLLATE ${BIN}
           WHERE EXISTS (SELECT 1 FROM econ_releases b WHERE b.[key] = m.[to] COLLATE ${BIN} AND b.ts = a.ts AND (b.actual IS NOT NULL OR a.actual IS NULL))`,
          [json],
        );
        await this.db.run(`UPDATE a SET [key] = m.[to] FROM econ_releases a JOIN ${M} ON a.[key] = m.[from] COLLATE ${BIN}`, [json]);
        await this.db.run(
          // Several leftovers can join one indicator: theirs folded first (an UPDATE takes one source row of several).
          `UPDATE i SET importance = CASE WHEN o.importance > i.importance THEN o.importance ELSE i.importance END, category = COALESCE(i.category, o.category),
             source = COALESCE(i.source, o.source), source_url = COALESCE(i.source_url, o.source_url), comment = COALESCE(i.comment, o.comment),
             alt_name = COALESCE(i.alt_name, o.alt_name)
           FROM econ_indicators i JOIN (
             SELECT m.[to], MAX(x.importance) AS importance, MAX(x.category) AS category, MAX(x.source) AS source, MAX(x.source_url) AS source_url,
               MAX(x.comment) AS comment, MAX(x.alt_name) AS alt_name
             FROM ${M} JOIN econ_indicators x ON x.[key] = m.[from] COLLATE ${BIN} GROUP BY m.[to]
           ) o ON i.[key] = o.[to] COLLATE ${BIN}`,
          [json],
        );
        await this.db.run(`DELETE i FROM econ_indicators i JOIN ${M} ON i.[key] = m.[from] COLLATE ${BIN}`, [json]);
      }
      // An empty answer is a broken one, not a calendar without events, and an answer at the source's cap may be cut
      // short: nothing is removed from either.
      if (range && events.length > 0 && events.length < TV_CAP) {
        const from = Math.max(range.from, now);
        await this.db.run(
          `DELETE FROM econ_releases WHERE ts >= ? AND ts < ? AND actual IS NULL
             AND [key] IN (SELECT [key] FROM econ_indicators WHERE country IN (SELECT value COLLATE ${BIN} FROM OPENJSON(?)))
             AND id NOT IN (SELECT value COLLATE ${BIN} FROM OPENJSON(?))`,
          [from, range.to, JSON.stringify(range.countries.map((c) => c.toUpperCase())), JSON.stringify(ids)],
        );
      }
    });
    this.cache = null;
    // Rare after the first ones: each says which rows the source's renames had split.
    for (const m of merges) this.log.info(`economy: ${m.from} joined ${m.to}`);
    return stored;
  }

  /** ~400 days of history, once per country (TD-ECON §3); returns the countries read now. */
  async backfill(fetcher: EconFetcher = fetchTradingView, signal?: AbortSignal, now = Date.now(), pauseMs = 1000): Promise<string[]> {
    const state = await readJobData<BackfillState>(this.db, ECON_JOB, { done: [] });
    const done = new Set(state.done);
    const rekeyed = new Set(state.rekeyed ?? []);
    const save = () => writeJobData(this.db, ECON_JOB, { ...state, done: [...done], rekeyed: [...rekeyed] });
    const read: string[] = [];
    for (const c of ECON_SOURCE_COUNTRIES) {
      if (done.has(c) || signal?.aborted) continue;
      try {
        const events = await fetchEconRange(now - HISTORY_DAYS * DAY, now - 7 * DAY, [c], fetcher, pauseMs);
        await this.ingest(events, undefined, now);
        done.add(c);
        // Read with the joining already: nothing left behind.
        rekeyed.add(c);
        read.push(c);
        await save();
      } catch (err) {
        this.log.warn(`economy: history of ${c} not read (${(err as Error).message}); retried at the next run`);
      }
      if (pauseMs > 0) await sleep(pauseMs);
    }
    // FD-CALACTUAL §4: once per country, the last REKEY_DAYS again, so the rows the source's renames left behind join
    // their indicator (the later ones are joined by the Calendar's own reads).
    const joined: string[] = [];
    for (const c of ECON_SOURCE_COUNTRIES) {
      if (rekeyed.has(c) || !done.has(c) || signal?.aborted) continue;
      try {
        const events = await fetchEconRange(now - REKEY_DAYS * DAY, now - 7 * DAY, [c], fetcher, pauseMs);
        await this.ingest(events, undefined, now);
        rekeyed.add(c);
        joined.push(c);
        await save();
      } catch (err) {
        this.log.warn(`economy: ${c} not read again (${(err as Error).message}); retried at the next run`);
      }
      if (pauseMs > 0) await sleep(pauseMs);
    }
    if (joined.length) this.log.info(`economy: last ${REKEY_DAYS} days read again for ${joined.join(', ')}`);
    return read;
  }

  async historyReady(): Promise<boolean> {
    const done = new Set((await readJobData<BackfillState>(this.db, ECON_JOB, { done: [] })).done);
    return ECON_SOURCE_COUNTRIES.every((c) => done.has(c));
  }

  /** The release schedule beyond the Calendar's two weeks (TD-ECON §3). */
  async refreshSchedule(fetcher: EconFetcher = fetchTradingView, now = Date.now()): Promise<number> {
    const from = now + 14 * DAY;
    const to = now + SCHEDULE_DAYS * DAY;
    const events = await fetchEconRange(from, to, ECON_SOURCE_COUNTRIES, fetcher);
    return this.ingest(events, { from, to, countries: ECON_SOURCE_COUNTRIES }, now);
  }

  /** Releases older than two years, and indicators left without any. */
  async prune(now = Date.now()): Promise<number> {
    const removed = (await this.db.run('DELETE FROM econ_releases WHERE ts < ?', [now - KEEP_MS])).changes;
    await this.db.run('DELETE FROM econ_indicators WHERE [key] NOT IN (SELECT DISTINCT [key] FROM econ_releases)');
    if (removed) this.cache = null;
    return removed;
  }

  /** The source's description of an indicator (English), for the row the user opens. */
  async description(key: string): Promise<string | null> {
    return (await this.db.get<{ comment: string | null }>('SELECT comment FROM econ_indicators WHERE [key] = ?', [key]))?.comment ?? null;
  }

  /** What the Economy page shows (TD-ECON §4); kept a minute. */
  async view(now = Date.now()): Promise<EconomyView> {
    if (this.cache && now - this.cache.at < VIEW_TTL_MS) return this.cache.view;
    const indicators = await this.db.all<IndicatorRow>(
      `SELECT [key], country, name, category, unit, scale, importance, source, source_url, CASE WHEN comment IS NOT NULL THEN 1 ELSE 0 END AS has_comment, alt_name
       FROM econ_indicators ORDER BY [key]`,
    );
    // The same moment twice (FD-CALACTUAL §4: the source sent a release again under a new id): the one read last counts.
    const releases = await this.db.all<ReleaseRow>('SELECT id, [key], ts, period, reference_date, actual, previous, forecast, fetched_at FROM econ_releases WHERE ts >= ? ORDER BY ts, fetched_at, id', [
      now - (HISTORY_DAYS + 60) * DAY,
    ]);
    const byKey = new Map<string, ReleaseRow[]>();
    let updatedAt: number | null = null;
    // FD-CALACTUAL §4: the moments each country's institution published values, "country|institution|ts".
    const rowOf = new Map(indicators.map((r) => [r.key, r]));
    const publishedAt = new Set<string>();
    for (const r of releases) {
      (byKey.get(r.key) ?? byKey.set(r.key, []).get(r.key))!.push(r);
      if (updatedAt === null || r.fetched_at > updatedAt) updatedAt = r.fetched_at;
      const ind = rowOf.get(r.key);
      if (r.actual !== null && r.ts <= now && ind?.source) publishedAt.add(`${ind.country}|${ind.source}|${r.ts}`);
    }
    const build = (row: IndicatorRow, countryName: string | null): EconIndicator | null => {
      const list = byKey.get(row.key) ?? [];
      const published = list.filter((r) => r.actual !== null && r.ts <= now);
      const last = published.at(-1);
      if (!last) return null;
      // FD-CALACTUAL §4: the Romanian name, the explanation, the group, the sense and "essential" go by the name the
      // page knows: the own one, else the former one of a renamed indicator.
      const basis = !knownName(row.name.toLowerCase()) && row.alt_name && knownName(row.alt_name.toLowerCase()) ? row.alt_name : row.name;
      const lower = basis.toLowerCase();
      const upcoming = list.find((r) => r.ts > now) ?? null;
      // Its time has passed but no value yet: delayed, or not published yet by the source (FD-ECON §4).
      const overdue = list.find((r) => r.actual === null && r.ts <= now && r.ts > last.ts && now - r.ts <= DAY) ?? null;
      const nextRow = overdue ?? upcoming;
      return {
        key: row.key,
        country: row.country,
        countryName,
        group: groupOf(row.category, basis),
        name: RO_NAMES[lower] ?? row.name,
        original: row.name,
        unit: row.unit,
        scale: row.scale,
        // A member state's indicator inside the euro-area group: essential only when the source says so.
        important: row.importance >= 1 || (countryName === null && ESSENTIAL.has(lower)),
        polarity: polarityOf(row.category, basis),
        latest: { value: last.actual as number, period: last.period, ts: last.ts, forecast: last.forecast },
        previous: last.previous,
        change: last.previous !== null ? (last.actual as number) - last.previous : null,
        next: nextRow
          ? {
              ts: nextRow.ts,
              forecast: nextRow.forecast,
              overdue: nextRow === overdue,
              ...(nextRow === overdue && row.source && publishedAt.has(`${row.country}|${row.source}|${nextRow.ts}`) ? { released: true } : {}),
            }
          : null,
        history: historyOf(published),
        source: row.source,
        sourceUrl: row.source_url,
        explanation: RO_EXPLAIN[lower] ?? explain(basis),
        hasDescription: row.has_comment === 1,
      };
    };
    const byCountry = new Map<string, IndicatorRow[]>();
    for (const row of indicators) (byCountry.get(row.country) ?? byCountry.set(row.country, []).get(row.country))!.push(row);
    const countries = ECON_COUNTRIES.map(({ code, name }) => {
      const own = (byCountry.get(code) ?? []).map((r) => build(r, null)).filter((x): x is EconIndicator => x !== null);
      let list = own;
      if (code === 'EU') {
        // A member state's indicator only where the euro area has none of the same name (FD-ECON §1).
        const euNames = new Set(own.map((i) => i.original.toLowerCase()));
        for (const [member, memberName] of Object.entries(EU_MEMBERS)) {
          for (const r of byCountry.get(member) ?? []) {
            // Low-importance national details (the CPI of each German Land…) stay out: the group is about the EU.
            if (euNames.has(r.name.toLowerCase()) || r.importance < 0) continue;
            const item = build(r, memberName);
            if (item) list.push(item);
          }
        }
        list = list.sort((a, b) => Number(a.countryName !== null) - Number(b.countryName !== null));
      }
      return { code, name, indicators: list };
    });
    const view: EconomyView = { updatedAt, historyReady: await this.historyReady(), countries };
    this.cache = { at: now, view };
    return view;
  }
}

/**
 * The value of each period, as last published (a flash estimate is replaced by the final one), oldest first: 13
 * periods, 26 for weekly series.
 */
function historyOf(published: ReleaseRow[]): [string | null, number][] {
  const byPeriod = new Map<string, ReleaseRow>();
  for (const r of published) byPeriod.set(String(r.reference_date ?? r.period ?? r.ts), r);
  const rows = [...byPeriod.values()].sort((a, b) => (a.reference_date ?? a.ts) - (b.reference_date ?? b.ts));
  const gaps = rows.slice(1).map((r, i) => (r.reference_date ?? r.ts) - (rows[i]!.reference_date ?? rows[i]!.ts));
  const weekly = gaps.length > 2 && gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! < 10 * DAY;
  return rows.slice(-(weekly ? 26 : 13)).map((r) => [r.period, r.actual as number]);
}
