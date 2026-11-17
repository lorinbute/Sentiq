// Sentiq.iOS TD-V4-S2 §2: the chart's model from its candles and settings, as the chart page and CandleChart compute it:
// Slingshot (always calculated: the signals' table reads it; drawn only when shown), LMA (when drawn), the candles'
// colours, every indicator with its layers and its legend, the extra bars the indicators still need.
import type { Bar } from 'oakscriptjs';
import type { Candle, SlingshotResult, SlingshotSignal } from '../shared/indicator/slingshot.ts';
import { runSlingshot } from '../shared/indicator/slingshot.ts';
import { slingshotParamsSchema, SLINGSHOT_VERSION, type SlingshotParams } from '../shared/indicator/params.ts';
import { brightness, colorNew, PINE_BLACK, PINE_WHITE, rgbaCss, runLma, type LmaResult } from '../shared/indicator/lma.ts';
import { effectiveLmaParams, lmaParamsSchema, type LmaParams } from '../shared/indicator/lma-params.ts';
import { chartStyleSchema, type ChartStyle } from '../shared/chart-style.ts';
import type { Study, StudyId } from '../shared/studies.ts';
import type { Timeframe } from '../shared/time.ts';
import { buildSegments, slingshotShapes } from '../web/chart/slingshot-draw.ts';
import { candleColors } from '../web/chart/candle-colors.ts';
import { lmaHlines } from '../web/chart/lma-lines.ts';
import { ALERT_RO, collapseAlerts, OUTCOME_RO, reasonRo } from '../web/chart/signal-text.ts';
import { STUDY_MODULES } from '../web/indicators/catalog.ts';
import { STUDY_META } from '../web/indicators/catalog-meta.ts';
import { chartContext, fmtStudyValue, legendParams, plotShown, runStudy, sanitizeInputs, toBars, type ChartInfo } from '../web/indicators/compute.ts';
import { planRun, resolveRequest, monthlyBars, type ExtraLoad, type LoadState, type Resolved } from '../web/indicators/extra-bars.ts';
import { legendNumbers, plotHasData, plotValueAt, pointColor, styledEntry } from '../web/indicators/style.ts';
import { linkStyle } from '../web/indicators/color-links.ts';
import { studyLayers, type StudyDrawing } from './study-layers.ts';

export interface ComputeRequest {
  /** What is shown (kind|exchange|symbol|tf): the answer carries it back, an answer for another chart is dropped. */
  key: string;
  candles: Candle[];
  /** The market structure timeframe's candles, when it is higher than the chart's. */
  htf: Candle[] | null;
  info: ChartInfo;
  chartTfSec: number;
  msTfSec: number;
  nowMs: number;
  /** The settings as saved (or previewed): each part read leniently (a missing one: its defaults). */
  indicator: unknown;
  lma: unknown;
  chartStyle: unknown;
  studies: Study[];
  /** FD-PREMIUMHIDE: Slingshot / LMA 'shown' | 'hidden' | 'off'. */
  premium: { slingshot: 'shown' | 'hidden' | 'off'; lma: 'shown' | 'hidden' | 'off' };
  /** The chart's candle limit and the timeframes of its source / of stocks (null: unknown). */
  env: { chartLimit: number; chartTfs: Timeframe[] | null; stockTfs: Timeframe[] | null };
  /** The extra bars loaded so far, by load key: candles, or 'loading' / 'failed'. */
  extra: Record<string, Candle[] | 'loading' | 'failed'>;
  /** Times (ms) of the first and last visible bar, for the indicators that read them. */
  visibleRange: { from: number; to: number } | null;
  /** The decimals the labels show (the settings' precision, else the pair's). */
  digits: number;
}

export interface LegendSeries {
  id: string;
  title: string;
  /** One value per bar (null: none). */
  values: (number | null)[];
  /** The colour of each bar's value, or one for all. */
  colors: string[] | string;
}

export interface StudyModel {
  uid: string;
  id: StudyId;
  name: string;
  shortName: string;
  params: string;
  number: number | null;
  overlay: boolean;
  visible: boolean;
  /** Pane height ratio to the price pane (a pane of its own). */
  height: number | null;
  error: string | null;
  missing: string[] | null;
  waiting: boolean;
  approximated: boolean;
  drawing: StudyDrawing | null;
  legend: LegendSeries[];
  /** Overlay indicators' values in the chart's decimals, others with a few digits (fmtStudyValue). */
  overlayDigits: boolean;
}

/** The chart's model (what CandleChart draws, and what the app's lists show). */
export interface ChartModel {
  key: string;
  n: number;
  /** The candles' own colours where the series' options do not give them (by the previous close, LMA, barcolor). */
  candleColors: Array<{ color?: string; borderColor?: string; wickColor?: string } | null>;
  slingshot: {
    drawn: boolean;
    upColor: string;
    downColor: string;
    fast: (number | null)[];
    slow: (number | null)[];
    uptrend: boolean[];
    fastWidth: number;
    fastStyle: string;
    slowWidth: number;
    slowStyle: string;
    shapes: ReturnType<typeof slingshotShapes>;
    segments: ReturnType<typeof buildSegments>;
    /** The TP/SL table's rows (empty: no table: off, nothing to show, or Show TP/SL Table unticked). */
    table: Array<{ side: 'long' | 'short'; tp: number; sl: number; tpColor: string; slColor: string }>;
    warnings: SlingshotResult['warnings'];
  } | null;
  lma: {
    signal: (number | null)[];
    colors: string[];
    showSignal: boolean;
    signalWidth: number;
    signalStyle: string;
    fill: boolean;
    hlines: ReturnType<typeof lmaHlines>;
    /** The state's label at the last bar (BULLISH / BEARISH / NEUTRAL). */
    label: { x: number; value: number; text: string; background: string; color: string } | null;
    /** The legend's text: preset, period, steepness, type, smoothing. */
    text: string;
    state: string;
  } | null;
  studies: StudyModel[];
  /** The extra bars the indicators still need (loads not yet given). */
  loads: ExtraLoad[];
  /** The signals' table and the alerts' list (as the chart page reports them to the app). */
  signals: {
    title: string;
    count: number;
    counts: Record<string, number>;
    rows: Array<{ id: string; side: 'long' | 'short'; at: number; time: number; provisional: boolean; entry: number; sl: number; tp: number; outcome: string; outcomeText: string; note: string; closed: number | null }>;
    alerts: Array<{ id: string; type: string; label: string; count: number; provisional: boolean; time: number }>;
  };
}

/** A setting read whole, else its defaults (an older or newer server's shape). */
function lenient<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, v: unknown): T {
  const r = schema.safeParse(v ?? {});
  if (r.success) return r.data;
  const d = schema.safeParse({});
  if (!d.success) throw new Error('defaults do not parse');
  return d.data;
}

const STUDY_NAMES = new Map(STUDY_META.map((m) => [m.id, m]));

/** The cache of indicator results between calls (the same inputs, bars and loads: the same result). */
const studyCache = new Map<string, { key: string; model: StudyModel }>();
/** Each indicator's last result (its settings form lists the fills it draws now, FD-FILLS). */
export const lastResults = new Map<string, import('oakscriptjs').IndicatorResult>();

const barsSig = (bars: readonly Bar[]) => (bars.length ? `${bars.length}|${bars[0]?.time}|${bars.at(-1)?.time}|${bars.at(-1)?.close}` : '0');

export function computeChart(req: ComputeRequest): ChartModel {
  const candles = req.candles;
  const n = candles.length;
  const p: SlingshotParams = lenient(slingshotParamsSchema, req.indicator);
  const lmaParams: LmaParams = lenient(lmaParamsSchema, req.lma);
  const look: ChartStyle = lenient(chartStyleSchema, req.chartStyle);

  // ── Slingshot (the page always runs it: the table and the app's lists read it)
  const result = n ? runSlingshot({ candles, htfCandles: req.htf, chartTfSec: req.chartTfSec, msTfSec: req.msTfSec, params: p, nowMs: req.nowMs }) : null;
  const slingshotDrawn = req.premium.slingshot === 'shown';
  let slingshot: ChartModel['slingshot'] = null;
  if (result) {
    const num = (vals: number[]) => vals.map((v) => (Number.isFinite(v) ? v : null));
    const rows = slingshotDrawn && p.showTable ? [result.atr, result.atrShort].filter((a) => a !== null) : [];
    slingshot = {
      drawn: slingshotDrawn,
      upColor: p.cloudUpColor,
      downColor: p.cloudDownColor,
      fast: num(result.emaFast),
      slow: num(result.emaSlow),
      uptrend: result.uptrend,
      fastWidth: p.fastEmaWidth,
      fastStyle: p.fastEmaStyle,
      slowWidth: p.slowEmaWidth,
      slowStyle: p.slowEmaStyle,
      shapes: slingshotDrawn ? slingshotShapes(result.markers, candles, p) : [],
      segments: slingshotDrawn ? buildSegments(result, p, req.digits) : [],
      table: rows.map((a) => ({ side: a.side, tp: a.tp, sl: a.sl, tpColor: a.side === 'short' ? p.shortTPColor : p.longTPColor, slColor: a.side === 'short' ? p.shortSLColor : p.longSLColor })),
      warnings: result.warnings,
    };
  }

  // ── LMA (drawn only)
  let lma: ChartModel['lma'] = null;
  let lmaResult: LmaResult | null = null;
  if (req.premium.lma === 'shown' && n) {
    lmaResult = runLma(candles, lmaParams);
    const e = lmaResult.effective;
    const lastValue = lmaResult.signal[n - 1] as number;
    const lastColor = lmaResult.color[n - 1];
    lma = {
      signal: lmaResult.signal.map((v) => (Number.isFinite(v) ? v : null)),
      colors: lmaResult.color.map(rgbaCss),
      showSignal: e.showSignal,
      signalWidth: e.signalWidth,
      signalStyle: e.signalStyle,
      fill: e.showFill,
      hlines: lmaHlines(e),
      label: lastColor && Number.isFinite(lastValue) ? { x: n - 1 + 2, value: lastValue, text: lmaResult.state[n - 1] as string, background: rgbaCss(colorNew(lastColor, 10)), color: brightness(lastColor) > 150 ? PINE_BLACK : PINE_WHITE } : null,
      text: lmaText(effectiveLmaParams(lmaParams)),
      state: (lmaResult.state[n - 1] as string | undefined) ?? '',
    };
  }

  // ── The candles' colours (CandleChart: by the previous close, LMA's "Color Price Bars")
  const lmaBarColors = lmaResult && lmaResult.effective.colorBars && lmaResult.effective.showBarColors ? lmaResult.color.map(rgbaCss) : null;
  const colors = candles.map((_, i) => {
    const c = candleColors(look.candles, candles, i, lmaBarColors?.[i]);
    return c.color === undefined && c.borderColor === undefined && c.wickColor === undefined ? null : c;
  });

  // ── The indicators (useStudies + styledEntry + the renderer)
  const bars = toBars(candles);
  const studies: StudyModel[] = [];
  const loads = new Map<string, ExtraLoad>();
  const ctx = n ? chartContext(req.info) : null;
  const spanSec = bars.length > 1 ? (bars.at(-1)?.time ?? 0) - (bars[0]?.time ?? 0) : 0;
  const loadStates = new Map<string, LoadState>();
  for (const [key, v] of Object.entries(req.extra)) loadStates.set(key, Array.isArray(v) ? { bars: toBars(v) } : v);
  const linked = req.studies.map(linkStyle);
  const numbers = legendNumbers(
    linked.map((st) => {
      const mod = STUDY_MODULES[st.id];
      return { uid: st.uid, id: st.id, params: mod ? legendParams(mod, sanitizeInputs(mod, st.inputs)) : '' };
    }),
  );
  const keep = new Set<string>();
  for (const st of linked) {
    const mod = STUDY_MODULES[st.id];
    const meta = STUDY_NAMES.get(st.id);
    if (!mod || !meta) continue;
    keep.add(st.uid);
    const inputs = sanitizeInputs(mod, st.inputs);
    const base: StudyModel = {
      uid: st.uid,
      id: st.id,
      name: meta.name,
      shortName: meta.shortName,
      params: legendParams(mod, inputs),
      number: numbers.get(st.uid) ?? null,
      overlay: mod.overlay,
      visible: st.visible,
      height: st.height ?? null,
      error: null,
      missing: null,
      waiting: false,
      approximated: false,
      drawing: null,
      legend: [],
      overlayDigits: mod.overlay,
    };
    if (!st.visible || !ctx || !n) {
      studies.push(base);
      continue;
    }
    // Its extra bars (another timeframe or symbol).
    let resolved: Resolved[] | null = null;
    if (mod.requiredSymbols) {
      let requests: { symbol: string; timeframe: string }[] = [];
      try {
        requests = mod.requiredSymbols(inputs, ctx);
      } catch {
        requests = [];
      }
      resolved = requests.map((r) => resolveRequest(r, { info: req.info, spanSec, chartLimit: req.env.chartLimit, chartTfs: req.env.chartTfs, stockTfs: req.env.stockTfs }));
      for (const r of resolved) {
        if (!r.load) continue;
        if (!loadStates.has(r.load.key)) loads.set(r.load.key, r.load);
        // A month built from daily bars.
        const st2 = loadStates.get(r.load.key);
        if (r.load.monthly && st2 && typeof st2 === 'object') loadStates.set(r.load.key, { bars: monthlyBars(st2.bars, r.load.timezone ?? 'Etc/UTC') });
      }
    }
    const loadSig = (resolved ?? []).map((r) => {
      const s = r.load ? loadStates.get(r.load.key) : 'none';
      return typeof s === 'object' ? `${r.load?.key}:${barsSig(s.bars)}` : `${r.load?.key ?? '-'}:${s ?? 'loading'}`;
    });
    const visKey = mod.usesVisibleRange && req.visibleRange ? `${req.visibleRange.from}|${req.visibleRange.to}` : '';
    const key = JSON.stringify([st.id, inputs, barsSig(bars), loadSig, visKey, st.plots, st.hlines, st.fills, numbers.get(st.uid) ?? null, req.info.precision]);
    const hit = studyCache.get(st.uid);
    if (hit && hit.key === key) {
      studies.push({ ...hit.model, visible: st.visible, height: st.height ?? null });
      continue;
    }
    const c = { ...ctx } as typeof ctx & Record<string, unknown>;
    if (mod.usesVisibleRange && req.visibleRange) {
      c.leftVisibleBarTime = req.visibleRange.from;
      c.rightVisibleBarTime = req.visibleRange.to;
    }
    const plan = resolved ? planRun(resolved, loadStates) : null;
    let model: StudyModel;
    if (plan?.mode === 'wait') model = { ...base, waiting: true };
    else {
      if (plan?.mode === 'bars') c.bars = plan.bars;
      const run = runStudy(mod, st.id, bars, inputs, c, plan?.mode === 'approximate');
      model = { ...base, error: run.error, missing: run.missing, approximated: run.approximated };
      if (run.result) {
        lastResults.set(st.uid, run.result);
        const styled = styledEntry(mod, st, inputs, run.result);
        model.drawing = studyLayers(styled.entry, styled.result, bars, styled.options);
        const res = run.result;
        model.legend = mod.plotConfig
          .filter((def) => def.display !== 'pane' && def.color !== 'transparent' && plotShown(def, st.plots?.[def.id], inputs, res) && plotHasData(res, def.id))
          .slice(0, 8)
          .map((def) => {
            const o = st.plots?.[def.id];
            const values: (number | null)[] = [];
            const cs: string[] = [];
            for (const b of bars) {
              const pt = plotValueAt(res, def.id, b.time);
              values.push(pt && pt.value !== null && pt.value !== undefined && Number.isFinite(pt.value) ? pt.value : null);
              cs.push(pointColor(def, o, pt?.color));
            }
            const one = cs.every((x) => x === cs[0]);
            return { id: def.id, title: def.title ?? def.id, values, colors: one ? (cs[0] ?? pointColor(def, o, undefined)) : cs };
          });
      }
    }
    studyCache.set(st.uid, { key, model });
    studies.push(model);
  }
  for (const uid of [...studyCache.keys()]) if (!keep.has(uid)) studyCache.delete(uid);
  for (const uid of [...lastResults.keys()]) if (!keep.has(uid)) lastResults.delete(uid);

  // ── The signals' table and the alerts (as the page reports them)
  const forming = { long: result?.last?.liveSignal ?? false, short: result?.last?.liveShortSignal ?? false };
  const shownOutcome = (x: SlingshotSignal) => (x.outcome === 'active' && forming[x.side] ? 'invalidated' : x.outcome);
  const sigs = result?.signals ?? [];
  const alerts = result ? collapseAlerts(result.alerts).reverse().slice(0, 40) : [];
  return {
    key: req.key,
    n,
    candleColors: colors,
    slingshot,
    lma,
    studies,
    loads: [...loads.values()],
    signals: {
      title: `Semnale Slingshot ${SLINGSHOT_VERSION} pe ${req.info.tf}`,
      count: sigs.length,
      counts: sigs.reduce<Record<string, number>>((acc, x) => ((acc[shownOutcome(x)] = (acc[shownOutcome(x)] ?? 0) + 1), acc), {}),
      rows: [...sigs]
        .reverse()
        .slice(0, 100)
        .map((x) => ({
          id: `${x.side}-${x.bar}`,
          side: x.side,
          at: x.time,
          time: x.time,
          provisional: x.provisional ?? false,
          entry: x.entry,
          sl: x.sl,
          tp: x.tp,
          outcome: shownOutcome(x),
          outcomeText: OUTCOME_RO[shownOutcome(x)] ?? shownOutcome(x),
          note: (x.outcomeReason ? reasonRo(x) : shownOutcome(x) !== x.outcome ? 'semnal nou în formare' : '') ?? '',
          closed: x.closedTime ?? null,
        })),
      alerts: alerts.map((a) => ({ id: `${a.bar}-${a.type}`, type: a.type, label: ALERT_RO[a.type] ?? a.type, count: a.count, provisional: a.provisional ?? false, time: a.time })),
    },
  };
}

/** The LMA legend's parameters (the chart page's `lmaText`). */
export function lmaText(e: LmaParams): string {
  return `${e.preset !== 'Default' && e.preset !== 'Custom' ? `${e.preset} ` : ''}${e.period} ${e.steepness} ${e.maType} ${e.smooth}`;
}

export { fmtStudyValue };
