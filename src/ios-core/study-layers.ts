// Sentiq.iOS TD-V4-S2 §3: what the site's IndicatorRenderer draws for one indicator result, as data the app draws itself.
// The same decisions as `IndicatorRenderer.render` (vendor/render/renderer.ts): which plots show and how, their colours
// with the user's palette, the hlines and the fills, the markers and where they go, the drawings with their times turned
// into bar positions (BarGrid: a time after the last bar is its slot after it). Pure: no chart, no DOM.
import type { Bar, FillConfig, FillData, HLineConfig, IndicatorResult, PlotConfig } from 'oakscriptjs';
import type { BarColorData, BgColorData, BoxData, LabelData, LineDrawingData, LinefillData, MarkerData, PlotBarData, PlotCandleData, PolylineData, TableData } from '../web/indicators/vendor/types';
import { gradientAt, markerSizeMult, scriptTimes, BUILTIN_MARKER_SHAPES, DEFAULT_PLOT_FILL_COLOR, type FillGradientData } from '../web/indicators/vendor/render/primitives';
import { isTransparent, withOpacity, type GradientPart } from '../web/indicators/vendor/render/color';
import type { PlotOverride, RenderableIndicator, RenderOptions } from '../web/indicators/vendor/render/index';
import { colorKey } from '../web/indicators/color-links.ts';
import { barInterval } from 'oakscriptjs';

/** 'price': the candles' pane; 'own': the indicator's own pane (an overlay indicator has none). */
export type LayerPane = 'price' | 'own';
export type LineStyleName = 'solid' | 'dashed' | 'dotted';

/** Points of a series: bar positions (logical indexes, slots after the last bar included), values, colours. */
export interface Points {
  xs: number[];
  /** null: no value (na) on that bar. */
  vs: (number | null)[];
  /** The colour of each point (null: the layer's); absent when every point has the layer's colour. */
  cs?: (string | null)[];
}

interface Base {
  pane: LayerPane;
  /** Whether it takes part in its pane's autoscale (`autoscaleInfoProvider` not cut off). */
  scale: boolean;
}

/** A plot (plot()): its kind as the renderer draws it. */
export interface PlotLayer extends Base, Points {
  k: 'plot';
  id: string;
  title: string;
  /**
   * line: a line series (segment colours already moved: each point has the colour of the segment that starts at it);
   * step: a line with steps; circles: point markers only; cross: crosses (size `width * 3`); linebr / steplinebr: a
   * line that breaks at na; hist: the thin histogram (width = the plot line width) from `base`; columns: the bar slot
   * width from `base`; area: a line plus the area from each value to `base` in that point's colour.
   */
  kind: 'line' | 'step' | 'circles' | 'cross' | 'linebr' | 'steplinebr' | 'hist' | 'columns' | 'area';
  color: string;
  width: number;
  style: LineStyleName;
  base?: number;
  /** area: the fill colour of each point at full opacity (null: none on that bar). */
  areaColors?: (string | null)[];
}

/** A horizontal line from the first to the last bar (hline()). */
export interface HLineLayer extends Base {
  k: 'hline';
  price: number;
  color: string;
  width: number;
  style: LineStyleName;
  x0: number;
  x1: number;
}

/** A fill between two prices or two plots, bar by bar (PlotFillPrimitive), or a plain band between two hlines. */
export interface FillLayer extends Base {
  k: 'fill';
  xs: number[];
  v1: number[];
  v2: number[];
  /** Each bar's colour (null: nothing on that bar). */
  colors?: (string | null)[];
  /** Each bar's gradient (null: nothing on that bar). */
  gradients?: (GradientPart | null)[];
}

export interface BandLayer extends Base {
  k: 'band';
  top: number;
  bottom: number;
  color: string;
  x0: number;
  x1: number;
}

/** plotshape / plotchar markers: `native` ones as the library's markers plugin draws them, the rest as the renderer's own. */
export interface MarkersLayer extends Base {
  k: 'markers';
  /** On the price pane they sit by the candles (aboveBar / belowBar / inBar read the candle). */
  onCandles: boolean;
  native: Array<MarkerData & { x: number; sizeMult: number }>;
  extended: Array<MarkerData & { x: number }>;
}

export interface ArrowsLayer extends Base {
  k: 'arrows';
  series: Array<{ minheight: number; maxheight: number; onBars: boolean; arrows: Array<{ x: number; value: number; color: string }> }>;
}

export interface BgLayer extends Base {
  k: 'bg';
  xs: number[];
  colors: string[];
}

export interface CandlesLayer extends Base {
  k: 'candles' | 'bars';
  items: Array<{ x: number; o: number; h: number; l: number; c: number; color?: string; borderColor?: string; wickColor?: string }>;
}

/** The drawings (label / line / box / linefill / polyline), their times turned into bar positions. */
export interface DrawingsLayer extends Base {
  k: 'drawings';
  z: 'bottom' | 'normal' | 'top';
  labels?: Array<LabelData & { x: number }>;
  lines?: Array<LineDrawingData & { x1: number; x2: number }>;
  boxes?: Array<BoxData & { x1: number; x2: number }>;
  linefills?: Array<{ color?: string; line1: LineDrawingData & { x1: number; x2: number }; line2: LineDrawingData & { x1: number; x2: number } }>;
  polylines?: Array<PolylineData & { xs: number[] }>;
  /** The anchor's points (autoscale): bar positions and prices. */
  anchor: { xs: number[]; vs: number[] };
}

export type StudyLayer = PlotLayer | HLineLayer | FillLayer | BandLayer | MarkersLayer | ArrowsLayer | BgLayer | CandlesLayer | DrawingsLayer;

export interface StudyDrawing {
  layers: StudyLayer[];
  /** barcolor(): the candles' body colours by bar (repainted over the main series). */
  barColors: Array<{ x: number; color: string }>;
  tables: Array<TableData & { pane: LayerPane }>;
  /** The last bar position any output reaches (the time scale is lengthened up to it: Ichimoku's clouds). */
  ahead: number;
}

type PlotPoint = { time: number; value: number; color?: string };

const STYLE: Record<string, LineStyleName> = { solid: 'solid', dashed: 'dashed', dotted: 'dotted' };

/** Bar positions of the chart's bars and of the slots after the last one (BarGrid without a chart). */
export class BarIndex {
  readonly last: number;
  readonly lastTime: number;
  readonly interval: number;
  private readonly byTime: Map<number, number>;
  private readonly times: number[];

  constructor(bars: readonly Bar[]) {
    this.times = bars.map((b) => b.time);
    this.byTime = new Map(this.times.map((t, i) => [t, i]));
    this.last = bars.length - 1;
    this.lastTime = bars.length ? (this.times[this.last] as number) : NaN;
    this.interval = barInterval(bars as Bar[]);
  }

  /** Slots after the last bar that hold `time` (BarGrid.slotsAfter, calendar time). */
  slotsAfter(time: number): number {
    if (!(time > this.lastTime)) return 0;
    return this.interval > 0 ? Math.floor((time - this.lastTime) / this.interval + 1e-9) : 0;
  }

  /**
   * The bar position of a time: its bar; after the last bar, its slot; a time between bars (not one of theirs) the bar
   * before it (the library would add a slot of its own; outputs on bar times never do this). null: before the first bar.
   */
  x(time: number): number | null {
    if (time == null || !Number.isFinite(time)) return null;
    const i = this.byTime.get(time);
    if (i !== undefined) return i;
    if (time > this.lastTime) return this.last + this.slotsAfter(time);
    let lo = 0;
    let hi = this.last;
    if (!(time >= (this.times[0] as number))) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.times[mid] as number) <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** plotConfig visibility (the renderer's `plotVisible`). */
function plotVisible(def: PlotConfig, override: PlotOverride, r: Record<string, unknown>, inputs: Record<string, unknown>): boolean {
  if (override.visible !== undefined) return override.visible;
  if (def.display === 'none' || def.display === 'data_window' || def.display === 'status_line') return false;
  if (def.visible === undefined || typeof def.visible === 'boolean') return def.visible ?? true;
  if (inputs[def.visible] !== undefined) return Boolean(inputs[def.visible]);
  const vis = r.visibility as Record<string, unknown> | undefined;
  if (vis?.[def.visible] !== undefined) return Boolean(vis[def.visible]);
  const pts = ((r.plots as Record<string, PlotPoint[]> | undefined)?.[def.id] ?? []) as PlotPoint[];
  return pts.some((p) => p.value != null && !Number.isNaN(p.value));
}

/** Per-point colours of a simple line: each point gets the colour of the next (the renderer's `segmentColors`). */
function segmentColors(cs: (string | null)[]): (string | null)[] {
  return cs.map((c, i) => (i + 1 < cs.length ? (cs[i + 1] ?? null) : c));
}

/**
 * One indicator result as layers (IndicatorRenderer.render). `bars`: the chart's bars; `entry` / `result` / `options`:
 * as `styledEntry` gives them.
 */
export function studyLayers(entry: RenderableIndicator, result: IndicatorResult, bars: readonly Bar[], options: RenderOptions = {}): StudyDrawing {
  const out: StudyDrawing = { layers: [], barColors: [], tables: [], ahead: 0 };
  if (!bars.length) return out;
  const grid = new BarIndex(bars);
  const r = result as IndicatorResult & Record<string, unknown>;
  const own: LayerPane = entry.overlay ? 'price' : 'own';
  const inputs = options.inputs ?? {};
  const xOf = (t: number) => grid.x(t);
  const see = (x: number | null) => {
    if (x !== null && x > out.ahead) out.ahead = x;
  };

  // ── Plots (drawPlots)
  for (const def of entry.plotConfig) {
    const override = options.plots?.[def.id] ?? {};
    const raw = (r.plots?.[def.id] ?? []) as PlotPoint[];
    if (!raw.length || !plotVisible(def, override, r, inputs)) continue;
    const palette = override.palette;
    const data = palette ? raw.map((p) => (p.color && palette[colorKey(p.color)] ? { ...p, color: palette[colorKey(p.color)] } : p)) : raw;
    const color = override.color ?? def.color ?? '#2962FF';
    const lineWidth = override.lineWidth ?? def.lineWidth;
    const pane: LayerPane = def.forceOverlay ? 'price' : own;
    const style = override.style ?? def.style ?? 'line';
    const lineStyle = STYLE[def.linestyle ?? 'solid'] ?? 'solid';
    const title = def.title ?? def.id;
    const valid = (d: PlotPoint) => d.value != null && !Number.isNaN(d.value);
    const pts = (list: PlotPoint[]): Points => {
      const xs: number[] = [];
      const vs: (number | null)[] = [];
      const cs: (string | null)[] = [];
      let colored = false;
      for (const d of list) {
        const x = xOf(d.time);
        if (x === null) continue;
        xs.push(x);
        vs.push(valid(d) ? d.value : null);
        cs.push(d.color ?? null);
        if (d.color) colored = true;
      }
      return colored ? { xs, vs, cs } : { xs, vs };
    };
    const lineW = lineWidth && lineWidth >= 1 ? lineWidth : 2;
    const layer = (kind: PlotLayer['kind'], p: Points, extra: Partial<PlotLayer> = {}): PlotLayer => ({ k: 'plot', pane, scale: true, id: def.id, title, kind, color, width: lineW, style: lineStyle, ...p, ...extra });
    let pl: PlotLayer;
    switch (style) {
      case 'histogram':
        pl = layer('hist', pts(data), { width: Math.max(1, lineWidth ?? 1), base: def.histbase ?? 0 });
        break;
      case 'columns':
        pl = layer('columns', pts(data.filter(valid)), { base: def.histbase ?? 0 });
        break;
      case 'circles':
        pl = layer('circles', pts(data.filter(valid)));
        break;
      case 'cross':
        pl = layer('cross', pts(data), { width: (lineWidth ?? 2) * 3 });
        break;
      case 'stepline':
      case 'stepline_diamond':
        pl = layer('step', pts(data.filter(valid)));
        break;
      case 'steplinebr':
        pl = layer('steplinebr', pts(data), { width: lineWidth ?? 2 });
        break;
      case 'linebr':
        pl = layer('linebr', pts(data), { width: lineWidth ?? 2 });
        break;
      case 'area':
      case 'areabr': {
        const p = pts(data.filter(valid));
        const line = p.cs ? { ...p, cs: segmentColors(p.cs) } : p;
        const areaColors = data.filter(valid).map((d) => {
          const c = d.color ?? color;
          return isTransparent(c) ? null : withOpacity(c, 1);
        });
        pl = layer('area', line, { base: def.histbase ?? 0, areaColors });
        break;
      }
      default: {
        const p = pts(data.filter(valid));
        pl = layer('line', p.cs ? { ...p, cs: segmentColors(p.cs) } : p);
      }
    }
    out.layers.push(pl);
    for (let i = pl.xs.length - 1; i >= 0; i--) {
      if (pl.vs[i] !== null) {
        see(pl.xs[i] as number);
        break;
      }
    }
  }

  // ── hlines and the fills between them (drawHLines)
  const hlines: HLineConfig[] = entry.hlineConfig?.length
    ? entry.hlineConfig
    : ((r.hlines ?? []) as Array<{ value: number; options?: { title?: string; color?: string; linestyle?: string; linewidth?: number } }>).map((h, i) => ({
        id: `hline${i}`,
        price: h.value,
        title: h.options?.title,
        color: h.options?.color,
        linestyle: h.options?.linestyle,
        linewidth: h.options?.linewidth,
      })) as HLineConfig[];
  const x0 = 0;
  const x1 = grid.last;
  for (const h of hlines) {
    if (h.display === 'none') continue;
    out.layers.push({ k: 'hline', pane: own, scale: true, price: h.price, color: h.color ?? '#787B86', width: h.linewidth ?? 1, style: STYLE[h.linestyle ?? 'solid'] ?? 'solid', x0, x1 });
  }
  if (entry.hlineConfig?.length) {
    const ids = new Set(entry.hlineConfig.map((h) => h.id));
    const fromResult: FillConfig[] = ((r.fills ?? []) as Array<FillData & { color?: string; title?: string }>)
      .filter((f) => ids.has(String(f.plot1)) && ids.has(String(f.plot2)))
      .map((f, k) => ({ id: `hlineFill${k}`, plot1: f.plot1, plot2: f.plot2, color: f.options?.color ?? f.color, colors: f.colors, gradient: f.gradient, title: f.options?.title }) as unknown as FillConfig);
    const fills = fromResult.length ? fromResult : (entry.fillConfig ?? []);
    const prices = new Map(entry.hlineConfig.map((h) => [h.id, h.price]));
    for (const fill of fills as Array<FillConfig & { colors?: string[]; gradient?: FillGradientData; color?: string }>) {
      const p1 = prices.get(String(fill.plot1));
      const p2 = prices.get(String(fill.plot2));
      if (p1 == null || p2 == null) continue;
      if (fill.gradient || fill.colors) {
        const xs = bars.map((_, i) => i);
        out.layers.push({
          k: 'fill', pane: own, scale: true, xs, v1: xs.map(() => p1), v2: xs.map(() => p2),
          ...(fill.colors ? { colors: xs.map((i) => (fill.colors && !isTransparent(fill.colors[i]) ? (fill.colors[i] as string) : null)) } : {}),
          ...(fill.gradient ? { gradients: xs.map((i) => gradientAt(fill.gradient as FillGradientData, i)) } : {}),
        }); // prettier-ignore
        continue;
      }
      out.layers.push({ k: 'band', pane: own, scale: true, top: Math.max(p1, p2), bottom: Math.min(p1, p2), color: fill.color ?? 'rgba(41,98,255,0.1)', x0, x1 });
    }
  }

  // ── Fills between plots (drawPlotFills)
  if (Array.isArray(r.fills) && r.fills.length) {
    const overlayPlots = new Set(entry.plotConfig.filter((p) => p.forceOverlay).map((p) => p.id));
    const plotData = (r.plots ?? {}) as Record<string, PlotPoint[]>;
    const barIndex = new Map(bars.map((b, i) => [b.time, i]));
    for (const fill of r.fills as Array<FillData & { colors?: (string | null)[] }>) {
      const p1 = plotData[String(fill.plot1)];
      const p2 = plotData[String(fill.plot2)];
      if (!p1?.length || !p2?.length) continue;
      const transp = (fill.options as { transp?: number } | undefined)?.transp;
      const opacity = transp != null ? 1 - transp / 100 : 1;
      const staticColor = fill.options?.color ?? DEFAULT_PLOT_FILL_COLOR;
      const p2Map = new Map(p2.map((d) => [d.time, d.value]));
      const gradient = fill.gradient as FillGradientData | undefined;
      const xs: number[] = [];
      const v1: number[] = [];
      const v2: number[] = [];
      const colors: (string | null)[] = [];
      const gradients: (GradientPart | null)[] = [];
      p1.forEach((d1, i) => {
        const x = xOf(d1.time);
        if (x === null) return;
        xs.push(x);
        v1.push(d1.value ?? NaN);
        v2.push(p2Map.get(d1.time) ?? NaN);
        if (gradient) {
          const bi = barIndex.get(d1.time);
          gradients.push(bi === undefined ? null : gradientAt(gradient, bi));
        } else {
          const rawColor = fill.colors && i < fill.colors.length ? fill.colors[i] : staticColor;
          colors.push(rawColor == null ? null : withOpacity(rawColor, opacity));
        }
      });
      if (!v1.some((v, i) => Number.isFinite(v) && Number.isFinite(v2[i] as number))) continue;
      const both = overlayPlots.has(String(fill.plot1)) && overlayPlots.has(String(fill.plot2));
      out.layers.push({ k: 'fill', pane: both ? 'price' : own, scale: true, xs, v1, v2, ...(gradient ? { gradients } : { colors }) });
    }
  }

  // ── Markers (drawMarkers)
  if (Array.isArray(r.markers) && r.markers.length) {
    const markers = r.markers as MarkerData[];
    const isPrice = (m: MarkerData) => m.position.startsWith('atPrice');
    const isEdge = (m: MarkerData) => m.position === 'top' || m.position === 'bottom';
    const inPane = (m: MarkerData) => (isPrice(m) || isEdge(m)) && !entry.overlay && !m.forceOverlay && own !== 'price';
    const split = (list: MarkerData[], nativeAllowed: boolean) => {
      const native: MarkersLayer['native'] = [];
      const extended: MarkersLayer['extended'] = [];
      for (const m of list) {
        if (isPrice(m) && (m.price == null || Number.isNaN(m.price))) continue;
        const x = xOf(m.time);
        if (x === null) continue;
        see(x);
        const nativeOk =
          nativeAllowed && !isEdge(m) && !m.char && BUILTIN_MARKER_SHAPES.has(m.shape) && (m.textColor == null || m.textColor === m.color) && !isTransparent(m.color) && !(m.text ?? '').includes('\n');
        if (nativeOk) native.push({ ...m, x, sizeMult: markerSizeMult(m.size) });
        else extended.push({ ...m, x });
      }
      native.sort((a, b) => a.x - b.x);
      return { native, extended };
    };
    // On the price pane the markers sit by the main series (the candles): `onCandles`.
    const onPrice = split(markers.filter((m) => !inPane(m)), true);
    if (onPrice.native.length || onPrice.extended.length) out.layers.push({ k: 'markers', pane: 'price', scale: false, onCandles: true, ...onPrice });
    const paneMarkers = markers.filter(inPane);
    if (paneMarkers.length) out.layers.push({ k: 'markers', pane: own, scale: true, onCandles: false, ...split(paneMarkers, true) });
  }

  // ── Arrows (drawArrows)
  if (Array.isArray(r.arrows) && r.arrows.length) {
    const configs = (entry.arrowConfig ?? []) as Array<{ id: string; display?: string; forceOverlay?: boolean; minheight?: number; maxheight?: number }>;
    const byId = new Map<string, Array<{ time: number; value: number; color: string }>>();
    for (const a of r.arrows as Array<{ id: string; time: number; value: number; color: string }>) {
      if (!byId.has(a.id)) byId.set(a.id, []);
      byId.get(a.id)?.push(a);
    }
    const groups = new Map<LayerPane, ArrowsLayer['series']>();
    for (const [id, list] of byId) {
      const cfg = configs.find((c) => c.id === id);
      if (cfg?.display === 'none') continue;
      const forceOverlay = !!cfg?.forceOverlay;
      const pane: LayerPane = forceOverlay ? 'price' : own;
      const arrows = list.flatMap((a) => {
        const x = xOf(a.time);
        if (x === null) return [];
        see(x);
        return [{ x, value: a.value, color: a.color }];
      });
      if (!groups.has(pane)) groups.set(pane, []);
      groups.get(pane)?.push({ minheight: cfg?.minheight ?? 5, maxheight: cfg?.maxheight ?? 100, onBars: entry.overlay || forceOverlay || own === 'price', arrows });
    }
    for (const [pane, series] of groups) out.layers.push({ k: 'arrows', pane, scale: false, series });
  }

  // ── Bar colours (drawBarColors) and backgrounds (drawBgColors)
  for (const c of (r.barColors ?? []) as BarColorData[]) {
    const x = xOf(c.time);
    if (x !== null && !isTransparent(c.color)) out.barColors.push({ x, color: c.color });
  }
  if (Array.isArray(r.bgColors) && r.bgColors.length) {
    const byPane = new Map<LayerPane, BgLayer>();
    for (const bg of r.bgColors as BgColorData[]) {
      const pane: LayerPane = bg.forceOverlay ? 'price' : own;
      const x = xOf(bg.time);
      if (x === null) continue;
      let l = byPane.get(pane);
      if (!l) {
        l = { k: 'bg', pane, scale: false, xs: [], colors: [] };
        byPane.set(pane, l);
      }
      l.xs.push(x);
      l.colors.push(bg.color);
    }
    out.layers.push(...byPane.values());
  }

  // ── plotcandle / plotbar (drawCandles, drawBars)
  for (const data of Object.values((r.plotCandles ?? {}) as Record<string, PlotCandleData[]>)) {
    if (!Array.isArray(data) || !data.length) continue;
    const pane: LayerPane = data.some((d) => d.forceOverlay) ? 'price' : own;
    const items = data.flatMap((d) => {
      const x = xOf(d.time);
      if (x === null || ![d.open, d.high, d.low, d.close].every(finite)) return [];
      return [{ x, o: d.open, h: d.high, l: d.low, c: d.close, ...(d.color ? { color: d.color, borderColor: d.borderColor ?? d.color, wickColor: d.wickColor ?? d.color } : {}) }];
    });
    out.layers.push({ k: 'candles', pane, scale: true, items });
  }
  for (const data of Object.values((r.plotBars ?? {}) as Record<string, PlotBarData[]>)) {
    if (!Array.isArray(data) || !data.length) continue;
    const pane: LayerPane = data.some((d) => d.forceOverlay) ? 'price' : own;
    const items = data.flatMap((d) => {
      const x = xOf(d.time);
      if (x === null || ![d.open, d.high, d.low, d.close].every(finite)) return [];
      return [{ x, o: d.open, h: d.high, l: d.low, c: d.close, ...(d.color ? { color: d.color } : {}) }];
    });
    out.layers.push({ k: 'bars', pane, scale: true, items });
  }

  // ── Drawings (drawLabels, drawLines, drawBoxes, drawLinefills, drawPolylines): one layer per pane and kind.
  const at = (t: number, script: boolean) => {
    const x = script ? scriptX(grid, t) : xOf(t);
    see(x);
    return x;
  };
  const drawings = (kind: 'labels' | 'lines' | 'boxes' | 'linefills' | 'polylines', z: DrawingsLayer['z'], items: unknown[], pick: (it: never) => { pane: LayerPane; item: unknown; anchor: Array<[number | null, number]> } | null) => {
    const byPane = new Map<LayerPane, DrawingsLayer>();
    for (const it of items) {
      const p = pick(it as never);
      if (!p) continue;
      let l = byPane.get(p.pane);
      if (!l) {
        l = { k: 'drawings', pane: p.pane, scale: true, z, anchor: { xs: [], vs: [] } };
        byPane.set(p.pane, l);
      }
      ((l[kind] ??= []) as unknown[]).push(p.item);
      for (const [x, v] of p.anchor) {
        if (x !== null && finite(v)) {
          l.anchor.xs.push(x);
          l.anchor.vs.push(v);
        }
      }
    }
    out.layers.push(...byPane.values());
  };
  const paneOf = (forceOverlay?: boolean): LayerPane => (forceOverlay ? 'price' : own);
  const lineAt = (l: LineDrawingData) => {
    const s = scriptTimes(l);
    return { ...l, x1: at(l.time1, s) ?? NaN, x2: at(l.time2, s) ?? NaN };
  };
  if (Array.isArray(r.labels) && r.labels.length) {
    drawings('labels', 'top', r.labels, (l: LabelData) => {
      const x = at(l.time, scriptTimes(l));
      return x === null ? null : { pane: paneOf(l.forceOverlay), item: { ...l, x }, anchor: [[x, l.price]] };
    });
  }
  if (Array.isArray(r.lines) && r.lines.length) {
    drawings('lines', 'normal', r.lines, (l: LineDrawingData) => {
      const d = lineAt(l);
      return { pane: paneOf(l.forceOverlay), item: d, anchor: [[finite(d.x1) ? d.x1 : null, l.price1], [finite(d.x2) ? d.x2 : null, l.price2]] };
    });
  }
  if (Array.isArray(r.boxes) && r.boxes.length) {
    drawings('boxes', 'bottom', r.boxes, (b: BoxData) => {
      const s = scriptTimes(b);
      const bx1 = at(b.time1, s);
      const bx2 = at(b.time2, s);
      return { pane: paneOf(b.forceOverlay), item: { ...b, x1: bx1 ?? NaN, x2: bx2 ?? NaN }, anchor: [[bx1, b.price1], [bx2, b.price2]] };
    });
  }
  if (Array.isArray(r.linefills) && r.linefills.length) {
    drawings('linefills', 'bottom', r.linefills, (f: LinefillData) => {
      const a = lineAt(f.line1);
      const b = lineAt(f.line2);
      const anchor: Array<[number | null, number]> = [a, b].flatMap((l): Array<[number | null, number]> => [[finite(l.x1) ? l.x1 : null, l.price1], [finite(l.x2) ? l.x2 : null, l.price2]]);
      return { pane: paneOf(f.line1.forceOverlay), item: { ...(f.color ? { color: f.color } : {}), line1: a, line2: b }, anchor };
    });
  }
  if (Array.isArray(r.polylines) && r.polylines.length) {
    drawings('polylines', 'normal', r.polylines, (p: PolylineData) => {
      const s = scriptTimes(p);
      const xs = p.points.map((pt) => at(pt.time, s) ?? NaN);
      return { pane: paneOf(p.forceOverlay), item: { ...p, xs }, anchor: p.points.map((pt, i): [number | null, number] => [finite(xs[i]) ? (xs[i] as number) : null, pt.price]) };
    });
  }

  // ── Tables (drawTables)
  for (const t of (r.tables ?? []) as TableData[]) out.tables.push({ ...t, pane: t.forceOverlay ? 'price' : own });
  return out;
}

/** A script time (xloc.bar_time) as a bar position: its bar, or its slot after the last bar on calendar time. */
function scriptX(grid: BarIndex, t: number): number | null {
  return grid.x(t);
}
