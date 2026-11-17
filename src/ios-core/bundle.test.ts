// Sentiq.iOS TD-V4-S2 §2 / §8: the engine's bundle (the script the app loads into JavaScriptCore) runs with no page: no
// window, no document, no modules; built into a temporary folder (never the repo's dist/).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const out = mkdtempSync(join(tmpdir(), 'sentiq-core-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the iOS engine bundle', () => {
  it('loads in an empty context and answers', { timeout: 180_000 }, async () => {
    await build({ configFile: new URL('../../vite.ios-core.config.ts', import.meta.url).pathname, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
    const source = readFileSync(join(out, 'ChartCore.js'), 'utf8');
    // Only what JavaScriptCore gives a bare context (no window, document, fetch, timers' DOM).
    const ctx = createContext({});
    runInContext(source, ctx);
    const core = runInContext('globalThis.SentiqCore', ctx) as { call: (name: string, json: string) => string };
    expect(JSON.parse(core.call('version', ''))).toEqual({ ok: true, value: { engine: 1 } });
    const catalog = JSON.parse(core.call('catalog', '')) as { ok: boolean; value: { studies: unknown[] } };
    expect(catalog.ok).toBe(true);
    expect(catalog.value.studies.length).toBeGreaterThan(100);
    expect(runInContext('typeof window + typeof document', ctx)).toBe('undefinedundefined');
  });
});
