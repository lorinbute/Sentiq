// FD-AIONE: „Trimite la analiză”: the user's AI scores one news item at their asking, whatever its relevance or day.
import { describe, expect, it } from 'vitest';
import { testDb } from '../test/db.ts';
import { silentLogger } from '../log.ts';
import { SecretBox } from '../secrets/crypto.ts';
import { SettingsService } from '../settings.ts';
import { AiService } from '../ai/service.ts';
import { AiError, type AiClient } from '../ai/types.ts';
import type { NliScorer } from './local.ts';
import { SentimentService } from './service.ts';

const noModel: NliScorer = { status: () => ({ state: 'failed', progress: null, error: null, model: 'x' }), warmUp: () => {}, score: async () => null, onReady: () => {} };
const DAY = 86_400_000;

async function setup(reply: (prompt: string) => Promise<Awaited<ReturnType<AiClient['generate']>>>) {
  const db = await testDb();
  const settings = new SettingsService(db, new SecretBox(Buffer.alloc(32, 5)));
  await db.run("INSERT INTO users(email, name, role, created_at) VALUES (N'ana@example.com', N'Ana', N'user', 1)");
  await db.run("INSERT INTO sources(id, name, url, category, builtin) VALUES ('s1', 'Source 1', 'https://s1.example/rss', 'macro', 0)");
  await settings.setAiKey(1, 'gemini', 'AIzaSyD-test-key-1-0123456789abcdef');
  await settings.updateFor(1, true, { ai: { provider: 'gemini', scoring: true } });
  const now = Date.now();
  // Out of the index (relevance 0) and a week old: the rounds never give it to the AI.
  await db.run(
    `INSERT INTO news(id, source_id, title, published_at, fetched_at, category, relevance, impact, cluster_id, sentiment, sentiment_label, sentiment_engine, sentiment_impact, flags)
     VALUES ('n1', 's1', 'Plug Power rises after six straight sessions of losses', ?, ?, 'other', 0, 1, 'n1', 0.1, 'neutral', 'local', NULL, '["lowRelevance"]')`,
    [now - 7 * DAY, now - 7 * DAY],
  );
  const prompts: string[] = [];
  const ai = new AiService({
    db,
    settings,
    log: silentLogger,
    clientFactory: (provider, _key, model) => ({
      provider,
      model,
      generate: async (req) => {
        prompts.push(req.prompt);
        return reply(req.prompt) as never;
      },
    }),
  });
  return { db, settings, ai, svc: new SentimentService(db, ai, noModel, silentLogger), prompts };
}

const scored = { parsed: { results: [{ n: 1, score: 0.6, impact: 2, reason: 'Acțiunea crește după șase zile de scăderi.' }] } as never, stop: 'done' as const, usage: { input: 1, output: 1 } };
const row = async (db: Awaited<ReturnType<typeof testDb>>) => db.get<{ score: number | null; engine: string; impact: number | null; reason: string | null }>("SELECT score, engine, impact, reason FROM news_ai_scores WHERE user_id = 1 AND news_id = 'n1'");

describe('one news item to the AI, at the user’s asking (FD-AIONE)', () => {
  it('scores an item out of the index and days old, alone in its call; once', async () => {
    const { db, svc, prompts } = await setup(async () => scored);
    expect(await svc.scoreOne(1, 'n1')).toEqual({ ok: true, already: false });
    expect(prompts).toEqual(['Headlines:\n1. Plug Power rises after six straight sessions of losses']);
    expect(await row(db)).toEqual({ score: 0.6, engine: 'gemini:gemini-3.8-flash', impact: 2, reason: 'Acțiunea crește după șase zile de scăderi.' });
    // Asked again: already scored, not sent again.
    expect(await svc.scoreOne(1, 'n1')).toEqual({ ok: true, already: true });
    expect(prompts).toHaveLength(1);
  });

  it('an earlier call that gave no score is tried again; an answer without a score keeps nothing', async () => {
    let give = false;
    const { db, svc } = await setup(async () => (give ? scored : { parsed: { results: [] } as never, stop: 'done' as const, usage: { input: 1, output: 1 } }));
    await db.run("INSERT INTO news_ai_scores(user_id, news_id, score, label, engine, impact, scored_at) VALUES (1, 'n1', NULL, NULL, 'gemini:gemini-3.8-flash', NULL, 1)");
    expect(await svc.scoreOne(1, 'n1')).toEqual({ ok: false, reason: 'noScore' });
    expect((await row(db))?.score).toBeNull();
    give = true;
    expect(await svc.scoreOne(1, 'n1')).toEqual({ ok: true, already: false });
    expect((await row(db))?.score).toBe(0.6);
  });

  it('a failed call says why; the paused AI is not called again', async () => {
    const { db, svc, prompts } = await setup(async () => Promise.reject(new AiError('gemini', 'timeout', 0, '', 'gemini-3.8-flash', { said: 'Google nu a răspuns în 3 minute' })));
    const failed = await svc.scoreOne(1, 'n1');
    expect(failed).toMatchObject({ ok: false, reason: 'failed', message: expect.stringContaining('Google nu a răspuns în 3 minute') });
    const paused = await svc.scoreOne(1, 'n1');
    expect(paused).toMatchObject({ ok: false, reason: 'paused', message: expect.stringContaining('Google nu a răspuns în 3 minute') });
    expect(prompts).toHaveLength(1);
    expect(await row(db)).toBeUndefined();
  });

  it('no AI of their own, or an item gone: said, nothing called', async () => {
    const { settings, ai, svc, prompts } = await setup(async () => scored);
    expect(await svc.scoreOne(1, 'nope')).toEqual({ ok: false, reason: 'missing' });
    await settings.updateFor(1, true, { ai: { scoring: false } });
    // As the settings route does when the choice is saved.
    ai.forgetChoice(1);
    expect(await svc.scoreOne(1, 'n1')).toEqual({ ok: false, reason: 'noAi' });
    expect(prompts).toHaveLength(0);
  });
});
