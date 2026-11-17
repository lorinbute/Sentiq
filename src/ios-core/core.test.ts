// Sentiq.iOS TD-V4-S2 §8: the engine the app runs in JavaScriptCore, called as the app calls it (JSON in, JSON out):
// its answers, the TP/SL table's switch (FD-SSTABLE), the premium form's save, the trades' lines and the coin sound's
// watch (FD-TRADESOUND).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { call } from './core.ts';

type Answer<T = unknown> = { ok: boolean; value?: T; error?: string };
const ask = <T = unknown>(name: string, args?: unknown): Answer<T> => JSON.parse(call(name, args === undefined ? '' : JSON.stringify(args))) as Answer<T>;

const raw = JSON.parse(readFileSync(new URL('../shared/indicator/__fixtures__/btc-usdt-1h.json', import.meta.url), 'utf8')) as number[][];
const candles = raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));

function compute(indicator: unknown, bars = candles) {
  const last = bars.at(-1)?.t ?? 0;
  return ask<{ n: number; slingshot: { table: unknown[]; fast: (number | null)[] } | null }>('compute', {
    key: 'crypto|kucoin|BTC/USDT|1h',
    candles: bars,
    htf: null,
    info: { kind: 'crypto', exchange: 'kucoin', symbol: 'BTC/USDT', tf: '1h', precision: 1 },
    chartTfSec: 3600,
    msTfSec: 3600,
    nowMs: last + 30 * 60_000,
    indicator,
    lma: {},
    chartStyle: {},
    studies: [],
    premium: { slingshot: 'shown', lma: 'off' },
    env: { chartLimit: 1500, chartTfs: null, stockTfs: null },
    extra: {},
    visibleRange: null,
    digits: 1,
  });
}

describe('the iOS chart engine', () => {
  it('answers as the app reads it: ok with a value, or the error; an unknown call is an error', () => {
    expect(ask('version')).toEqual({ ok: true, value: { engine: 1 } });
    const nope = ask('nope');
    expect(nope.ok).toBe(false);
    expect(nope.error).toMatch(/unknown call/);
    expect(ask<{ timeframes: unknown[] }>('catalog').value?.timeframes.length).toBeGreaterThan(5);
  });

  it('writes NaN as null and leaves the TP/SL table out when Show TP/SL Table is unticked (FD-SSTABLE)', () => {
    const all = compute({});
    expect(all.ok).toBe(true);
    expect(all.value?.n).toBe(candles.length);
    // The EMAs' warm-up: null, never NaN (JSON has none).
    expect(all.value?.slingshot?.fast[0]).toBeNull();
    // A history that ends inside a trade: ticked (the default), its row; unticked, none.
    let bars = candles;
    let on = all;
    for (let n = candles.length; n > 400 && !on.value?.slingshot?.table.length; n -= 20) {
      bars = candles.slice(0, n);
      on = compute({}, bars);
    }
    expect(on.value?.slingshot?.table.length).toBeGreaterThan(0);
    expect(compute({ showTable: false }, bars).value?.slingshot?.table).toEqual([]);
  });

  it("the premium form: the switch set, saved as the indicator's settings", () => {
    const opened = ask<{ id: number; form: unknown }>('form', { op: 'open', target: 'slingshot', settings: { indicator: {} } });
    const id = opened.value?.id ?? 0;
    expect(id).toBeGreaterThan(0);
    expect(JSON.stringify(opened.value?.form)).toContain('showTable');
    ask('form', { op: 'set', id, key: 'p:showTable', value: false });
    const saved = ask<{ patch?: { indicator?: { showTable?: boolean } } }>('form', { op: 'save', id });
    expect(saved.value?.patch?.indicator?.showTable).toBe(false);
    expect(ask<{ form: unknown }>('form', { op: 'close', id }).value?.form).toBeNull();
  });

  it('„Șterge N indicatori”: all removed, each one remembered; „Anulează” puts them back before any added since', () => {
    type Patch = { studies: { uid: string; id: string }[]; studyMemory?: { id: string }[] };
    const first = ask<Patch>('studies', { op: 'add', id: 'rsi', uid: 'u1', studies: [], studyMemory: [] }).value?.studies ?? [];
    const both = [...first, ...(ask<Patch>('studies', { op: 'add', id: 'macd', uid: 'u2', studies: first, studyMemory: [] }).value?.studies.slice(1) ?? [])];
    expect(both.map((x) => x.uid)).toEqual(['u1', 'u2']);
    const gone = ask<Patch>('studies', { op: 'removeAll', studies: both, studyMemory: [] }).value;
    expect(gone?.studies).toEqual([]);
    expect(gone?.studyMemory?.map((m) => m.id).sort()).toEqual(['macd', 'rsi']);
    const added = ask<Patch>('studies', { op: 'add', id: 'rsi', uid: 'u3', studies: [], studyMemory: gone?.studyMemory }).value?.studies ?? [];
    const back = ask<Patch>('studies', { op: 'restore', before: both, studies: added }).value;
    expect(back?.studies.map((x) => x.uid)).toEqual(['u1', 'u2', 'u3']);
  });

  it("a holding's stop sell: its line can be dragged, its × asks to delete the stop loss", () => {
    const now = Date.now();
    const account = { id: 7, exchange: 'kucoin', label: 'KuCoin', kind: 'crypto', env: 'real', trading: { enabled: true, markets: ['spot', 'futures'] } };
    const portfolio = {
      accountId: 7, exchange: 'kucoin', kind: 'crypto', currency: 'USDT', cash: null, asOf: null, mode: 'classic',
      balances: [{ asset: 'ETH', account: 'trade', total: 0.42, free: 0.42, used: 0, price: 3412.57, value: 1433.28, avgPrice: 3120.5, avgSource: 'fills', pnl: 122.67, pnlPct: 9.36 }],
      positions: [],
      orders: [{ id: 'o2', symbol: 'ETH/USDT', market: 'spot', type: 'stop', side: 'sell', price: null, triggerPrice: 2950, amount: 0.42, filled: 0, timestamp: now, reduceOnly: false, positionSide: null, stop: 'down' }],
      fills: [], totals: {}, errors: {}, stale: {}, fetchedAt: now,
    };
    const base = { symbol: 'ETH/USDT', stock: false, lastPrice: 3412.57, accounts: [account], portfolios: { '7': portfolio }, botLevels: [], drafts: {}, now };
    const lines = ask<{ lines: { id: string; role: string; draggable: boolean }[] }>('trades', { ...base, op: 'lines' }).value?.lines ?? [];
    const sl = lines.find((l) => l.role === 'sl');
    expect(sl?.draggable).toBe(true);
    expect(lines.find((l) => l.role === 'entry')?.draggable).toBe(false);
    const act = ask<{ kind: string; title?: string }>('trades', { ...base, op: 'action', id: sl?.id });
    expect(act.value?.kind).toBe('modify');
    expect(act.value?.title).toMatch(/stop loss/i);
  });

  it('the coin sound: a trade gone between two readings made while watching; nothing across a 50 s gap or before the start', () => {
    const p = (eth: number) => ({ accountId: 3, positions: [], orders: [], errors: {}, stale: {}, balances: [{ asset: 'ETH', total: eth, value: eth * 3400 }] });
    const read = (at: number, eth: number) => ask<{ ended: boolean }>('tradeEnds', { op: 'read', accountId: 3, at, portfolio: p(eth), base: 'ETH' }).value?.ended;
    expect(ask('tradeEnds', { op: 'start', now: 1_000 })).toEqual({ ok: true, value: null });
    expect(read(2_000, 0.42)).toBe(false);
    expect(read(22_000, 0)).toBe(true);
    expect(read(42_000, 0.42)).toBe(false);
    // The app in the background for a minute: what closed meanwhile stays silent.
    expect(read(102_000, 0)).toBe(false);
    // Watching again from a later start: the reading before it is not compared.
    expect(read(110_000, 0.5)).toBe(false);
    ask('tradeEnds', { op: 'start', now: 120_000 });
    expect(read(130_000, 0)).toBe(false);
    // Another coin's holding is not the chart's.
    expect(ask<{ ended: boolean }>('tradeEnds', { op: 'read', accountId: 3, at: 140_000, portfolio: p(0.3), base: 'SOL' }).value?.ended).toBe(false);
  });
});
