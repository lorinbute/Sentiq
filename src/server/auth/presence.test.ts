// FD-KEYIDLE: the users' own keys work only while they use Sentiq: a live beat of a tab, of a live session.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../test/db.ts';
import { silentLogger } from '../log.ts';
import { SecretBox } from '../secrets/crypto.ts';
import { SettingsService } from '../settings.ts';
import { AiService } from '../ai/service.ts';
import type { AiClient } from '../ai/types.ts';
import type { NliScorer } from '../sentiment/local.ts';
import { SentimentService } from '../sentiment/service.ts';
import { Scanner } from '../scanner/scanner.ts';
import type { MarketData } from '../market/market.ts';
import type { MarketStatus, StockData } from '../market/stocks.ts';
import type { Timeframe } from '../../shared/time.ts';
import { PRESENCE_TTL_MS } from '../../shared/presence.ts';
import { hashToken, Sessions } from './sessions.ts';
import { Presence } from './presence.ts';

afterEach(() => vi.useRealTimers());

const noModel: NliScorer = { status: () => ({ state: 'failed', progress: null, error: null, model: 'x' }), warmUp: () => {}, score: async () => null, onReady: () => {} };

describe('presence (FD-KEYIDLE)', () => {
  it('a beat counts for 2.5 minutes, each tab on its own; leaving ends it, and the first beat after none says so', async () => {
    const db = await testDb();
    let now = Date.parse('2026-11-01T10:00:00Z');
    const sessions = new Sessions(db, () => now);
    const presence = new Presence(db, () => now);
    const h = hashToken(await sessions.create(1, 'full'));
    expect(await presence.activeUsers()).toEqual(new Set());
    expect(await presence.beat(h, 'tab-aaaa')).toBe(true);
    expect(await presence.activeUsers()).toEqual(new Set([1]));
    expect(await presence.beat(h, 'tab-aaaa')).toBe(false);
    // A second tab of the same browser: hiding the first one does not end the user's presence.
    expect(await presence.beat(h, 'tab-bbbb')).toBe(false);
    await presence.leave(h, 'tab-aaaa');
    expect(await presence.activeUsers()).toEqual(new Set([1]));
    await presence.leave(h, 'tab-bbbb');
    expect(await presence.activeUsers()).toEqual(new Set());
    // A tab gone without a word: until its last beat runs out.
    expect(await presence.beat(h, 'tab-aaaa')).toBe(true);
    now += PRESENCE_TTL_MS - 1;
    expect(await presence.activeUsers()).toEqual(new Set([1]));
    now += 1;
    expect(await presence.activeUsers()).toEqual(new Set());
    expect(await presence.beat(h, 'tab-aaaa')).toBe(true);
    // Two beats of one tab at once (a click and the minute's beat): neither fails, one row.
    await presence.leave(h, 'tab-aaaa');
    await Promise.all([presence.beat(h, 'tab-cccc'), presence.beat(h, 'tab-cccc'), presence.beat(h, 'tab-cccc')]);
    expect((await db.all("SELECT [key] FROM market_cache WHERE [key] LIKE N'presence:%'")).length).toBe(1);
    expect(await presence.activeUsers()).toEqual(new Set([1]));
  });

  it('only a live full session of an enabled account counts: signed out, expired, pending or disabled do not', async () => {
    const db = await testDb();
    const now = Date.parse('2026-11-01T10:00:00Z');
    const sessions = new Sessions(db, () => now);
    const presence = new Presence(db, () => now);
    await db.run("INSERT INTO users(email, name, role, email_verified_at, created_at) VALUES (N'ana@example.com', N'Ana', N'user', 1, 1), (N'bob@example.com', N'Bob', N'user', 1, 1)");
    // Signed out: the session is gone, so is its tab (no row to delete).
    const t1 = await sessions.create(1, 'full');
    await presence.beat(hashToken(t1), 'tab-one1');
    await sessions.destroy(t1);
    // Two-factor still due: a pending session.
    await presence.beat(hashToken(await sessions.create(2, 'pending')), 'tab-two2');
    // An expired session (not yet removed).
    const h2 = hashToken(await sessions.create(2, 'full'));
    await presence.beat(h2, 'tab-two3');
    await db.run('UPDATE sessions SET expires_at = ? WHERE id_hash = ?', [now - 1, h2]);
    // A disabled account (its sessions end at its next request).
    const h3 = hashToken(await sessions.create(3, 'full'));
    await presence.beat(h3, 'tab-three');
    await db.run('UPDATE users SET disabled_at = 1 WHERE id = 3');
    expect(await presence.activeUsers()).toEqual(new Set());
    await db.run('UPDATE users SET disabled_at = NULL WHERE id = 3');
    expect(await presence.activeUsers()).toEqual(new Set([3]));
    // A beat on a session that no longer exists harms nothing.
    expect(await presence.beat(hashToken('gone'), 'tab-gone')).toBe(true);
    expect(await presence.activeUsers()).toEqual(new Set([3]));
  });

  it('purges the beats that ran out, keeps the live ones', async () => {
    const db = await testDb();
    let now = Date.parse('2026-11-01T10:00:00Z');
    const sessions = new Sessions(db, () => now);
    const presence = new Presence(db, () => now);
    const h = hashToken(await sessions.create(1, 'full'));
    await presence.beat(h, 'tab-old1');
    now += PRESENCE_TTL_MS;
    await presence.beat(h, 'tab-new1');
    expect(await presence.purge()).toBe(1);
    expect(await presence.activeUsers()).toEqual(new Set([1]));
    expect((await db.all("SELECT [key] FROM market_cache WHERE [key] LIKE N'presence:%'")).length).toBe(1);
  });
});

describe("the users' own AI scores only while they use Sentiq (FD-KEYIDLE)", () => {
  it('absent: their key is not called; back: it scores what came meanwhile (the last 48 h)', async () => {
    const db = await testDb();
    const settings = new SettingsService(db, new SecretBox(Buffer.alloc(32, 4)));
    await db.run("INSERT INTO users(email, name, role, email_verified_at, created_at) VALUES (N'ana@example.com', N'Ana', N'user', 1, 1)");
    await db.run("INSERT INTO sources(id, name, url, category, builtin) VALUES ('s1', 'Source 1', 'https://s1.example/rss', 'crypto', 0)");
    // Each user's key tells their calls apart.
    const calls: Record<string, number> = {};
    const client = (key: string): AiClient => ({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      generate: async (req) => {
        calls[key] = (calls[key] ?? 0) + 1;
        const n = (req.prompt.match(/^\d+\./gm) ?? []).length;
        return { parsed: { results: Array.from({ length: n }, (_, i) => ({ n: i + 1, score: 0.4, impact: 2 })) } as never, stop: 'done', usage: { input: 10, output: 5 } };
      },
    });
    const ai = new AiService({ db, settings, log: silentLogger, clientFactory: (_p, key) => client(key) });
    const keys = { 1: 'AIzaSyD-test-key-1111111111abcdef', 2: 'AIzaSyD-test-key-2222222222abcdef' } as const;
    for (const u of [1, 2] as const) {
      await settings.setAiKey(u, 'gemini', keys[u]);
      await settings.updateFor(u, u === 1, { ai: { provider: 'gemini', scoring: true } });
    }
    const here = new Set<number>([1]);
    const svc = new SentimentService(db, ai, noModel, silentLogger, async () => new Set(here));
    const now = Date.now();
    const add = (id: string, at: number) =>
      db.run("INSERT INTO news(id, source_id, title, published_at, fetched_at, category, relevance, impact, cluster_id) VALUES (?, 's1', ?, ?, ?, 'crypto', 1, 1, ?)", [id, `Story ${id}`, at, at, id]);
    await add('n1', now - 3 * 3_600_000);
    await add('n2', now - 60_000);
    const scored = async (u: number) => (await db.get<{ n: number }>('SELECT count(*) AS n FROM news_ai_scores WHERE user_id = ?', [u]))?.n ?? 0;
    // User 2 is away: only user 1's AI works.
    expect(await svc.scoreUsers(undefined, now)).toBe(2);
    expect(calls).toEqual({ [keys[1]]: 1 });
    expect(await scored(2)).toBe(0);
    // News keep coming while user 2 is away: still nothing on their key.
    await add('n3', now - 30_000);
    await svc.scoreUsers(undefined, now);
    expect(calls[keys[2]]).toBeUndefined();
    // User 2 comes back (user 1 leaves): their AI catches up with all three, the old ones included.
    here.clear();
    here.add(2);
    expect(await svc.scoreUsers(undefined, now)).toBe(3);
    expect(await scored(2)).toBe(3);
    expect(calls[keys[1]]).toBe(2);
    expect(calls[keys[2]]).toBe(1);
  });
});

describe('when each user’s AI works, in the log (FIX-KEYIDLE2)', () => {
  it('says once when a scoring user comes to Sentiq and once when they leave', async () => {
    const db = await testDb();
    const settings = new SettingsService(db, new SecretBox(Buffer.alloc(32, 4)));
    await db.run("INSERT INTO users(email, name, role, email_verified_at, created_at) VALUES (N'ana@example.com', N'Ana', N'user', 1, 1)");
    const ai = new AiService({ db, settings, log: silentLogger, clientFactory: () => ({ provider: 'gemini', model: 'gemini-3.8-flash', generate: async () => ({ parsed: { results: [] } as never, stop: 'done', usage: { input: 0, output: 0 } }) }) });
    for (const u of [1, 2] as const) {
      await settings.setAiKey(u, 'gemini', 'AIzaSyD-test-key-0123456789abcdef');
      await settings.updateFor(u, u === 1, { ai: { provider: 'gemini', scoring: true } });
    }
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: () => {}, error: () => {} };
    const here = new Set<number>([1]);
    const svc = new SentimentService(db, ai, noModel, log, async () => new Set(here));
    await svc.scoreUsers();
    await svc.scoreUsers();
    expect(lines).toEqual(['ai: user 1 is in Sentiq: their AI scores']);
    here.clear();
    here.add(2);
    await svc.scoreUsers();
    expect(lines.slice(1)).toEqual(['ai: user 2 is in Sentiq: their AI scores', 'ai: user 1 left Sentiq: their AI waits']);
    here.clear();
    await svc.scoreUsers();
    await svc.scoreUsers();
    expect(lines.slice(3)).toEqual(['ai: user 2 left Sentiq: their AI waits']);
    // Still in Sentiq, but the local model chosen: said as such, not as leaving.
    here.add(1);
    await svc.scoreUsers();
    await settings.updateFor(1, true, { ai: { provider: 'gemini', scoring: false } });
    ai.forget(1);
    await svc.scoreUsers();
    expect(lines.slice(4)).toEqual(['ai: user 1 is in Sentiq: their AI scores', 'ai: user 1 no longer scores with their own AI']);
    // Without the presence (tests, the old wiring) nothing is said.
    const quiet: string[] = [];
    await new SentimentService(db, ai, noModel, { info: (m: string) => quiet.push(m), warn: () => {}, error: () => {} }).scoreUsers();
    expect(quiet).toEqual([]);
  });
});

describe('a share read with the user’s Twelve Data key, only while they use Sentiq (FD-KEYIDLE)', () => {
  /** Rising daily candles: enough history for the indicator. */
  const candles = (n: number) => Array.from({ length: n }, (_, i) => ({ t: Date.UTC(2025, 0, 1) + i * 86_400_000, o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i, v: 1000 }));

  async function setup(hasKey: boolean) {
    const db = await testDb();
    const settings = new SettingsService(db, new SecretBox(Buffer.alloc(32, 3)));
    await db.run("INSERT INTO watchlist(coin, quote, position, aliases, added_at, kind) VALUES ('AAPL', 'USD', 0, '[]', 1, 'stock')");
    await settings.updateFor(1, true, { scanner: { tf: hasKey ? '1h' : '1d' } });
    const asked: Timeframe[] = [];
    const stocks = {
      hasKey: async () => hasKey,
      timeframesFor: async () => (hasKey ? ['1h', '1d', '1w'] : ['1d', '1w']),
      confirmedStatus: async (): Promise<MarketStatus> => ({ state: 'open', label: '', opensAt: null, closesAt: null, fetchedAt: Date.now() }),
      candles: async (sym: string, tf: Timeframe, count: number) => {
        asked.push(tf);
        return { exchange: hasKey ? 'twelvedata' : 'nasdaq', symbol: sym, tf, candles: candles(Math.min(count, 400)), pricePrecision: 2, lastClosedIndex: 0, fetchedAt: Date.now() };
      },
    } as unknown as StockData;
    const market = { candles: async () => Promise.reject(new Error('no crypto here')) } as unknown as MarketData;
    const here = new Set<number>();
    return { scanner: new Scanner(db, settings, market, silentLogger, stocks, null, async () => new Set(here)), asked, here };
  }

  it('absent: nothing asked (no row, or the last one, however old); back: read at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 2, 15) });
    const { scanner, asked, here } = await setup(true);
    await scanner.run();
    expect(asked).toEqual([]);
    expect(scanner.result(1)?.rows).toEqual([]);
    here.add(1);
    await scanner.run();
    expect(asked).toEqual(['1h']);
    const row = scanner.result(1)?.rows[0];
    expect(row).toMatchObject({ coin: 'AAPL', tf: '1h', ok: true });
    // Away for an hour of trading: the last row stays, nothing is read with the key.
    here.clear();
    vi.setSystemTime(Date.UTC(2026, 10, 2, 16));
    await scanner.run();
    expect(asked).toEqual(['1h']);
    expect(scanner.result(1)?.rows[0]).toBe(row);
    here.add(1);
    await scanner.run();
    expect(asked).toEqual(['1h', '1h']);
  });

  it('without a key (Nasdaq, free) the share is read whether the user is there or not', async () => {
    const { scanner, asked } = await setup(false);
    await scanner.run();
    expect(asked).toEqual(['1d']);
    expect(scanner.result(1)?.rows[0]).toMatchObject({ coin: 'AAPL', tf: '1d', ok: true });
  });
});
