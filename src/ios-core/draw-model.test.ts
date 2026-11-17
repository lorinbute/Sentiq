// Sentiq.iOS TD-V4-S2 §8: the draw model of representative indicators, as the app's canvas reads it (the layers the
// site's IndicatorRenderer turns into series: their kind, their pane), from the engine's `compute`, on a real history.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { call } from './core.ts';

type Layer = { k: string; kind?: string; pane: string; values?: (number | null)[] };
type Study = { id: string; overlay: boolean; error: string | null; legend: { values: (number | null)[] }[]; drawing: { layers: Layer[]; tables: unknown[] } | null };

const ask = (name: string, args: unknown) => JSON.parse(call(name, JSON.stringify(args))) as { ok: boolean; value: never; error?: string };
const raw = JSON.parse(readFileSync(new URL('../shared/indicator/__fixtures__/btc-usdt-1h.json', import.meta.url), 'utf8')) as number[][];
const candles = raw.slice(-800).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const IDS = ['rsi', 'bb', 'macd', 'volume', 'ichimoku', 'supertrend', 'pivot-points-standard', 'zigzag', 'technicals'];

function model(): Map<string, Study> {
  let list: unknown[] = [];
  for (const [i, id] of IDS.entries()) list = (ask('studies', { op: 'add', id, uid: `u${i}`, studies: list, studyMemory: [] }).value as { studies: unknown[] }).studies;
  const last = candles.at(-1)?.t ?? 0;
  const r = ask('compute', {
    key: 'k', candles, htf: null, info: { kind: 'crypto', exchange: 'kucoin', symbol: 'BTC/USDT', tf: '1h', precision: 1 },
    chartTfSec: 3600, msTfSec: 3600, nowMs: last + 1_800_000, indicator: {}, lma: {}, chartStyle: {}, studies: list,
    premium: { slingshot: 'off', lma: 'off' }, env: { chartLimit: 1500, chartTfs: null, stockTfs: null }, extra: {},
    visibleRange: { from: candles[600]?.t ?? 0, to: last }, digits: 1,
  });
  expect(r.ok, r.error).toBe(true);
  return new Map((r.value as { studies: Study[] }).studies.map((s) => [s.id, s]));
}

const kinds = (s: Study | undefined) => (s?.drawing?.layers ?? []).map((l) => `${l.k}${l.kind ? `:${l.kind}` : ''}@${l.pane}`);

describe('the draw model of the chart indicators (iOS)', () => {
  const m = model();

  it('every one computed, in its pane, without an error', () => {
    for (const id of IDS) {
      const s = m.get(id);
      expect(s?.error ?? null, id).toBeNull();
      expect(s?.drawing?.layers.length, id).toBeGreaterThan(0);
      // An overlay's layers are on the price pane, the others in a pane of their own (the markers aside).
      const panes = new Set(s?.drawing?.layers.map((l) => l.pane));
      expect([...panes], id).toEqual([s?.overlay ? 'price' : 'own']);
    }
  });

  it("RSI: its lines, the 70 / 50 / 30 levels, the band between them and the zones' fills", () => {
    const k = kinds(m.get('rsi'));
    expect(k.filter((x) => x === 'hline@own')).toHaveLength(3);
    expect(k).toContain('band@own');
    expect(k).toContain('plot:line@own');
    expect(k.filter((x) => x === 'fill@own').length).toBeGreaterThan(0);
  });

  it('MACD: the histogram as columns and its two lines, around 0; Volume as columns', () => {
    const k = kinds(m.get('macd'));
    expect(k.filter((x) => x === 'plot:columns@own')).toHaveLength(1);
    expect(k.filter((x) => x === 'plot:line@own')).toHaveLength(2);
    expect(k).toContain('hline@own');
    expect(kinds(m.get('volume'))).toEqual(['plot:columns@own']);
  });

  it('Bollinger and Ichimoku: their lines with the fill between; Supertrend: broken lines (one per trend)', () => {
    expect(kinds(m.get('bb')).filter((x) => x === 'plot:line@price')).toHaveLength(3);
    expect(kinds(m.get('bb'))).toContain('fill@price');
    expect(kinds(m.get('ichimoku')).filter((x) => x === 'plot:line@price')).toHaveLength(5);
    expect(kinds(m.get('ichimoku'))).toContain('fill@price');
    expect(kinds(m.get('supertrend')).filter((x) => x === 'plot:linebr@price')).toHaveLength(2);
  });

  it("Pivot Points and ZigZag draw with Pine's drawings; Technical Ratings has its table", () => {
    expect(kinds(m.get('pivot-points-standard'))).toEqual(['drawings@price', 'drawings@price']);
    expect(kinds(m.get('zigzag')).every((x) => x === 'drawings@price')).toBe(true);
    expect(m.get('technicals')?.drawing?.tables.length).toBe(1);
  });

  it("the legend's values per bar: one per candle, the last bar's a number", () => {
    for (const id of ['rsi', 'macd', 'bb', 'volume']) {
      const values = m.get(id)?.legend[0]?.values ?? [];
      expect(values, id).toHaveLength(candles.length);
      expect(typeof values.at(-1), id).toBe('number');
    }
  });
});
