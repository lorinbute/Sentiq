import { describe, expect, it } from 'vitest';
import { bandOf, defaultSpacing, keepShift, loadBand, loadRoom, loadZoom, MAX_BAND_MARGINS, MAX_ROOM, roomMoved, roomOf, saveBand, saveRoom, saveZoom, zoomOf } from './view-store.ts';

class MemoryStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('chart view store', () => {
  it('FD-CHARTOPEN: keeps one zoom for every chart, ignores invalid or corrupt data and works without storage', () => {
    const st = new MemoryStorage() as unknown as Storage;
    expect(loadZoom(st)).toBeNull();
    saveZoom(8.5, st);
    expect(loadZoom(st)).toBe(8.5);
    for (const bad of [0, 0.1, -3, NaN, Infinity, 501]) saveZoom(bad, st);
    expect(loadZoom(st)).toBe(8.5);
    for (const raw of ['x', '0.05', '-5', '600', 'Infinity']) {
      st.setItem('sentiq.chartZoom', raw);
      expect(loadZoom(st)).toBeNull();
    }
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage; // prettier-ignore
    expect(loadZoom(throwing)).toBeNull();
    expect(() => saveZoom(10, throwing)).not.toThrow();
    expect(loadZoom(null)).toBeNull();
    expect(() => saveZoom(10, null)).not.toThrow();
  });

  it('FD-CHARTOPEN: without a zoom yet, takes the one of the view used last before it (read only)', () => {
    const st = new MemoryStorage() as unknown as Storage;
    const views = { 'kucoin|BTC/USDT|1h': { barSpacing: 6, scroll: 24, at: 5 }, 'kucoin|SOL/USDT|2h': { barSpacing: 11.25, scroll: 30, at: 9 }, bad: { barSpacing: 'x', scroll: 0, at: 99 }, worse: { barSpacing: 900, scroll: 0, at: 98 } };
    st.setItem('sentiq.chartViews', JSON.stringify(views));
    expect(loadZoom(st)).toBe(11.25);
    expect(st.getItem('sentiq.chartZoom')).toBeNull(); // nothing written: the first move saves the zoom
    expect(JSON.parse(st.getItem('sentiq.chartViews') as string)).toEqual(views); // an older build still finds its views
    saveZoom(7, st);
    expect(loadZoom(st)).toBe(7); // its own zoom first
    const old = new MemoryStorage() as unknown as Storage;
    old.setItem('kryptoniq.chartViews', JSON.stringify({ a: { barSpacing: 4, scroll: 0, at: 1 } }));
    expect(loadZoom(old)).toBe(4); // from before the rename
    for (const raw of ['{not json', '[1,2]', '"x"', '{}']) {
      st.removeItem('sentiq.chartZoom');
      st.setItem('sentiq.chartViews', raw);
      expect(loadZoom(st)).toBeNull();
    }
  });

  it('FD-CHARTOPEN: the zoom of a view, unless the library cut it at its maximum (half the plot a bar)', () => {
    expect(zoomOf(8, 1000)).toBe(8);
    expect(zoomOf(0.5, 1000)).toBe(0.5); // zoomed out to the library's minimum: chosen
    expect(zoomOf(499.9, 1000)).toBe(499.9);
    expect(zoomOf(500, 1000)).toBeNull(); // cut by a narrow window
    expect(zoomOf(150, 300)).toBeNull();
    for (const [b, w] of [[NaN, 1000], [8, 0], [8, NaN], [0, 1000], [0.05, 1000], [Infinity, 1000]]) expect(zoomOf(b as number, w as number)).toBeNull();
  });

  it('FD-CHARTOPEN: keeps one band for every chart, forgets it with null, ignores invalid or corrupt data', () => {
    const st = new MemoryStorage() as unknown as Storage;
    expect(loadBand(st)).toBeNull();
    saveBand({ top: 0.05, bottom: 0.4 }, st);
    expect(loadBand(st)).toEqual({ top: 0.05, bottom: 0.4 });
    for (const bad of [{ top: -0.1, bottom: 0.2 }, { top: 0.5, bottom: 0.5 }, { top: NaN, bottom: 0 }, { top: 0.2, bottom: Infinity }]) saveBand(bad, st);
    expect(loadBand(st)).toEqual({ top: 0.05, bottom: 0.4 });
    saveBand({ top: 0, bottom: MAX_BAND_MARGINS }, st);
    expect(loadBand(st)).toEqual({ top: 0, bottom: MAX_BAND_MARGINS });
    saveBand(null, st);
    expect(loadBand(st)).toBeNull();
    expect(st.getItem('sentiq.chartBand')).toBeNull();
    for (const raw of ['{not json', '[0.1,0.2]', '{"top":0.6,"bottom":0.6}', '{"top":"0.1","bottom":0.2}', '{"top":-1,"bottom":0}', 'null']) {
      st.setItem('sentiq.chartBand', raw);
      expect(loadBand(st)).toBeNull();
    }
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } } as unknown as Storage; // prettier-ignore
    expect(loadBand(throwing)).toBeNull();
    expect(() => saveBand({ top: 0.1, bottom: 0.1 }, throwing)).not.toThrow();
    expect(() => saveBand(null, throwing)).not.toThrow();
    expect(loadBand(null)).toBeNull();
    expect(() => saveBand(null, null)).not.toThrow();
  });

  it('FD-CHARTOPEN: the band of the candles on screen, as the library maps a range into its margins', () => {
    // A 501 px pane: the range's top at y = top × 501, its bottom at y = 500 − bottom × 501.
    expect(bandOf({ high: 100.2, low: 400.8, height: 501 })).toEqual({ top: 100.2 / 501, bottom: (500 - 400.8) / 501 });
    const b = bandOf({ high: 50.1, low: 300.6, height: 501 }) as { top: number; bottom: number };
    expect(b.top * 501).toBeCloseTo(50.1);
    expect(500 - b.bottom * 501).toBeCloseTo(300.6);
    // Off the pane above (dragged up) or below: 0 there.
    expect(bandOf({ high: -80, low: 200, height: 500 })).toEqual({ top: 0, bottom: 299 / 500 });
    expect(bandOf({ high: -80, low: 700, height: 500 })).toEqual({ top: 0, bottom: 0 }); // zoomed in past both edges
    // Squashed into 2% of the pane: 5% kept, in the same proportion above and below.
    const sq = bandOf({ high: 300, low: 309, height: 500 }) as { top: number; bottom: number };
    expect(sq.top + sq.bottom).toBeCloseTo(MAX_BAND_MARGINS);
    expect(sq.top / sq.bottom).toBeCloseTo(300 / 190);
    // One price for all the candles on screen, or values that are not valid.
    for (const bad of [{ high: 200, low: 200.5, height: 500 }, { high: 210, low: 200, height: 500 }, { high: NaN, low: 300, height: 500 }, { high: 10, low: 300, height: 0 }, { high: 10, low: Infinity, height: 500 }]) expect(bandOf(bad)).toBeNull();
  });

  it('FD-CHARTROOM: keeps one room for every chart, ignores invalid or corrupt data and works without storage', () => {
    const st = new MemoryStorage() as unknown as Storage;
    expect(loadRoom(st)).toBeNull();
    saveRoom(312.5, st);
    expect(loadRoom(st)).toBe(312.5);
    saveRoom(0, st);
    expect(loadRoom(st)).toBe(0);
    for (const bad of [-1, NaN, Infinity, MAX_ROOM + 1]) saveRoom(bad, st);
    expect(loadRoom(st)).toBe(0);
    for (const raw of ['', 'x', '-5', String(MAX_ROOM + 1), 'Infinity']) {
      st.setItem('sentiq.chartRoom', raw);
      expect(loadRoom(st)).toBeNull();
    }
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage; // prettier-ignore
    expect(loadRoom(throwing)).toBeNull();
    expect(() => saveRoom(10, throwing)).not.toThrow();
    expect(loadRoom(null)).toBeNull();
    expect(() => saveRoom(10, null)).not.toThrow();
  });

  it('FD-CHARTROOM: the room of a view, unless the last candle is off screen or the view is at the library limit', () => {
    // 1000 px at 5 px a bar: 200 bars across, the library stops at 198 bars after the last point.
    const at = (fromCandle: number, offset = fromCandle) => roomOf({ fromCandle, barSpacing: 5, offset, width: 1000 });
    expect(at(40)).toBe(200);
    expect(at(0)).toBe(0);
    expect(at(-0.5)).toBeNull(); // looking back in history
    expect(at(197.9)).toBeCloseTo(989.5);
    expect(at(198)).toBeNull(); // cut by the window (or dragged to the end)
    // Ichimoku's 26 points ahead: the limit is the library's (offset), the room is from the candle.
    expect(at(60, 34)).toBe(300);
    expect(at(199, 173)).toBe(995); // the last candle at the left edge, the cloud after it
    expect(at(199.5, 173.5)).toBeNull(); // the last candle left of the view: only the cloud shows
    expect(at(230, 204)).toBeNull();
    for (const bad of [
      { fromCandle: NaN, barSpacing: 5, offset: 0, width: 1000 },
      { fromCandle: 10, barSpacing: 0, offset: 10, width: 1000 },
      { fromCandle: 10, barSpacing: 5, offset: Infinity, width: 1000 },
      { fromCandle: 10, barSpacing: 5, offset: 10, width: 0 },
    ])
      expect(roomOf(bad)).toBeNull();
  });

  it('FD-CHARTROOM: only a view that moved gives a room (not a window resized, new candles or an indicator ahead)', () => {
    const k = 'kucoin|SOL/USDT|1h';
    expect(roomMoved(null, { key: k, px: 300 })).toBe(true); // the first view of a chart
    expect(roomMoved({ key: k, px: 300 }, { key: 'kucoin|BTC/USDT|1h', px: 300 })).toBe(true); // another chart
    expect(roomMoved({ key: k, px: 300 }, { key: k, px: 360 })).toBe(true); // dragged
    expect(roomMoved({ key: k, px: -900 }, { key: k, px: 300 })).toBe(true); // back from history
    expect(roomMoved({ key: k, px: 496 }, { key: k, px: 496 })).toBe(false); // the cut view, the window widened again
    expect(roomMoved({ key: k, px: 496 }, { key: k, px: 496 + 1e-9 })).toBe(false); // a new candle, the view glued to it
  });

  it('FD-CHARTROOM: the default view keeps its zoom (180 candles and 20 bars after them)', () => {
    expect(defaultSpacing(1005, 500)).toBe(5);
    expect(defaultSpacing(1005, 180)).toBe(5);
    expect(defaultSpacing(710, 50)).toBe(10); // from 0 to 70: 71 bars
    expect(defaultSpacing(210, 0)).toBe(10);
  });
});

describe('FD-CHARTKEEP: the last candle kept where it was when new bars come', () => {
  it('scrolls by the bars it moved; nothing for half a pixel or less, or a value that cannot be used', () => {
    // One new 1m bar at 5.36 px a bar: the last candle drawn one bar further right.
    expect(keepShift(667, 672.36, 5.36)).toBeCloseTo(1, 6);
    // Three bars at once (a tab hidden for a while).
    expect(keepShift(667, 683.08, 5.36)).toBeCloseTo(3, 6);
    // An older last candle (a cache answering behind): back left, to the same place.
    expect(keepShift(667, 661.64, 5.36)).toBeCloseTo(-1, 6);
    expect(keepShift(667, 667.4, 5.36)).toBeNull();
    expect(keepShift(null, 672, 5.36)).toBeNull();
    expect(keepShift(667, null, 5.36)).toBeNull();
    expect(keepShift(667, Number.NaN, 5.36)).toBeNull();
    expect(keepShift(667, 672, 0)).toBeNull();
  });
});
