// The Slingshot and LMA settings forms (FD-STYLEUNIFY, FD-SLINGSHOT34, FD-SSTABLE): their groups, fields, rules and
// their description for the iOS app's native sheet. Pure: shared by the chart page's drawer and the app's chart engine
// (Sentiq.iOS TD-V4-S2).
import type { ZodType } from 'zod';
import { SIGNAL_SIZE_NAMES, type SlingshotParams } from '../../shared/indicator/params.ts';
import { effectiveLmaParams, LMA_MA_TYPES, LMA_PRESET_VALUES, LMA_PRESETS, LMA_TOOLTIPS, type LmaParams } from '../../shared/indicator/lma-params.ts';
import { TIMEFRAMES } from '../../shared/time.ts';
import type { ChartLineStyle } from '../../shared/chart-style.ts';
import type { HostValue } from '../embed.ts';
import { hostNumber, hostString, hostStyle, type HostField } from '../host-form-model.ts';
import { lmaHlines, lmaScriptLineColors } from './lma-lines.ts';

export type FieldDef<P> = {
  key: keyof P & string;
  label: string;
  /** The Pine tooltip, shown behind an (i). */
  tip?: string;
  /** Consecutive fields with the same value share a row (Pine `inline`). */
  inline?: string;
} & (
  | { kind: 'int' | 'float'; step?: number; min?: number; max?: number }
  /** `lockedWhen`: why the box cannot change now (it is then disabled), e.g. the last side left on. */
  | { kind: 'bool'; lockedWhen?: (draft: P) => string | null }
  | { kind: 'color' }
  | { kind: 'text' }
  | { kind: 'select'; options: { value: string; label: string }[] }
  /**
   * FD-STYLEUNIFY: an element's look on one row, the same everywhere: a box to tick (`toggle`), the line box (its `color`,
   * else `swatch`, a colour that comes from elsewhere, explained by `note`; `scriptColor` when the saved colour is null:
   * the script's own), its `width` and `style`, its `size`, and a level shown after it (`value`).
   */
  | {
      kind: 'look';
      toggle?: keyof P & string;
      color?: keyof P & string;
      scriptColor?: (draft: P) => string;
      swatch?: (draft: P) => string;
      note?: string;
      width?: keyof P & string;
      style?: keyof P & string;
      size?: keyof P & string;
      value?: (draft: P) => number;
    }
);

/** The keys a field edits (an error on any of them names the field). */
export const fieldKeys = <P,>(f: FieldDef<P>): string[] => (f.kind === 'look' ? [f.key, f.toggle, f.color, f.width, f.style, f.size].filter((k): k is keyof P & string => Boolean(k)) : [f.key]);
/** Pine's line style names <-> the line box's. */
export const PINE_STYLE: Record<ChartLineStyle, string> = { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted' };
export const boxStyle = (v: unknown): ChartLineStyle => (v === 'Dashed' ? 'dashed' : v === 'Dotted' ? 'dotted' : 'solid');
export interface GroupDef<P> {
  title: string;
  fields: FieldDef<P>[];
}

export const ONE_SIDE_TIP = 'Cel puțin unul dintre Long Signals și Short Signals rămâne bifat.';
/** FD-STYLEUNIFY: each state of a side's labels, with the Pine input's title and tooltip. */
export const signalLooks = (side: 'long' | 'short'): FieldDef<SlingshotParams>[] => {
  const S = side === 'long' ? 'Long' : 'Short';
  const row = (state: string, label: string, tip?: string): FieldDef<SlingshotParams> => ({
    key: `${side}${state}Color` as keyof SlingshotParams & string,
    label,
    kind: 'look',
    color: `${side}${state}Color` as keyof SlingshotParams & string,
    size: `${side}${state}Size` as keyof SlingshotParams & string,
    ...(tip ? { tip } : {}),
  });
  return [
    row('Forming', `${S} Forming Signal`, `A ${S.toUpperCase()} still forming (before its confirmation).`),
    row('', `${S} Signal`, `A valid ${S.toUpperCase()}: active, or ended with its take profit.`),
    row('Failed', `${S} Failed Signal`, `A ${S.toUpperCase()} that hit its stop loss.`),
    row('Invalid', `${S} Invalidated Signal`, `A ${S.toUpperCase()} replaced by a newer one (an X while the newer one is forming, for good once it is confirmed) or ended by a trend flip.`),
    row('Tp', `${S} Take Profit`, `The TAKE PROFIT label of a ${S.toUpperCase()}.`),
    row('Sl', `${S} Stop Loss`, `The STOP LOSS label on the bar where a ${S.toUpperCase()} failed.`),
  ];
};
/** FD-STYLEUNIFY: a side's take profit / stop loss level: its line and its label's size. */
export const atrLook = (side: 'long' | 'short', level: 'Tp' | 'Sl'): FieldDef<SlingshotParams> => {
  const color = `${side}${level === 'Tp' ? 'TP' : 'SL'}Color` as keyof SlingshotParams & string;
  return {
    key: color,
    label: `${side === 'long' ? 'Long' : 'Short'} ATR ${level === 'Tp' ? 'Take Profit' : 'Stop Loss'}`,
    kind: 'look',
    color,
    width: `${side}${level}LineWidth` as keyof SlingshotParams & string,
    style: `${side}${level}LineStyle` as keyof SlingshotParams & string,
    size: `${side}${level}LabelSize` as keyof SlingshotParams & string,
  };
};
export const CLOUD_NOTE = 'Culoarea vine din Cloud Uptrend Color / Cloud Downtrend Color, după trend.';
export const cloudSwatch = (d: SlingshotParams) => `linear-gradient(135deg, ${d.cloudUpColor} 50%, ${d.cloudDownColor} 50%)`;
export const SLINGSHOT_GROUPS: GroupDef<SlingshotParams>[] = [
  {
    // FD-SLINGSHOT34: the sides; the last one ticked cannot be unticked. FD-STYLEUNIFY: each state, each side.
    title: 'Signals',
    fields: [
      { key: 'showLong', label: 'Long Signals', kind: 'bool', tip: ONE_SIDE_TIP, lockedWhen: (d) => (d.showShort ? null : ONE_SIDE_TIP) },
      { key: 'showShort', label: 'Short Signals', kind: 'bool', tip: ONE_SIDE_TIP, lockedWhen: (d) => (d.showLong ? null : ONE_SIDE_TIP) },
      ...signalLooks('long'),
      ...signalLooks('short'),
    ],
  },
  {
    title: 'Indicator Settings',
    fields: [
      { key: 'lenFastEma', label: 'Fast EMA Period', kind: 'int' },
      { key: 'lenSlowEma', label: 'Slow EMA Period', kind: 'int' },
      { key: 'lenRsi', label: 'RSI Period for Stoch', kind: 'int' },
      { key: 'lenStoch', label: 'Stochastic (K) Period', kind: 'int' },
      { key: 'smoothK', label: 'K Line Smoothing', kind: 'int' },
      { key: 'stochOversold', label: 'Stoch Oversold Level', kind: 'int' },
      { key: 'stochOverbought', label: 'Stoch Overbought Level', kind: 'int' },
      { key: 'touchTolPct', label: 'Cloud touch tolerance (%)', kind: 'float', step: 0.05 },
      { key: 'kTol', label: 'K tolerance at 20/80', kind: 'float', step: 0.1 },
    ],
  },
  {
    title: 'ATR Settings',
    fields: [
      { key: 'atrLength', label: 'ATR Length', kind: 'int' },
      { key: 'takeProfitMultiplier', label: 'Take Profit ATR Multiplier', kind: 'float', step: 0.1 },
      { key: 'stopLossMultiplier', label: 'Stop Loss ATR Multiplier', kind: 'float', step: 0.1 },
      { key: 'lookback', label: 'Lookback Period', kind: 'int' },
      { key: 'atrLineLengthTP', label: 'ATR TP Line Length', kind: 'int' },
      { key: 'atrLineLengthSL', label: 'ATR SL Line Length', kind: 'int' },
      { key: 'showLabels', label: 'Show ATR Labels', kind: 'bool' },
      { key: 'showLines', label: 'Show ATR Levels', kind: 'bool' },
      // FD-SSTABLE: the table can be hidden on its own; the levels and labels on the chart stay.
      { key: 'showTable', label: 'Show TP/SL Table', kind: 'bool', tip: 'The TAKE PROFIT / STOP LOSS table in the bottom-right corner of the chart. Hiding it leaves the levels and their labels on the chart.' },
      { key: 'hideAtrOnTP', label: 'Hide ATR Levels and Labels on Take Profit Hit', kind: 'bool' },
      { key: 'hideAtrOnStop', label: 'Hide ATR Levels and Labels on Stop Loss Hit', kind: 'bool' },
      atrLook('long', 'Tp'),
      atrLook('long', 'Sl'),
      atrLook('short', 'Tp'),
      atrLook('short', 'Sl'),
    ],
  },
  {
    // FD-SS34LIVE: the EMAs in the trend's colour, the cloud at half its opacity; FD-STYLEUNIFY: the EMAs' width and style
    // (TradingView's Style tab).
    title: 'Cloud',
    fields: [
      { key: 'cloudUpColor', label: 'Cloud Uptrend Color', kind: 'color', tip: 'The EMAs in an uptrend; the cloud gets it at half its opacity.' },
      { key: 'cloudDownColor', label: 'Cloud Downtrend Color', kind: 'color', tip: 'The EMAs in a downtrend; the cloud gets it at half its opacity.' },
      { key: 'slowEmaWidth', label: 'Slow EMA', kind: 'look', swatch: cloudSwatch, note: CLOUD_NOTE, width: 'slowEmaWidth', style: 'slowEmaStyle' },
      { key: 'fastEmaWidth', label: 'Fast EMA', kind: 'look', swatch: cloudSwatch, note: CLOUD_NOTE, width: 'fastEmaWidth', style: 'fastEmaStyle' },
    ],
  },
  {
    title: 'Market Structure',
    fields: [
      { key: 'showMS', label: 'Show Market Structure Levels', kind: 'bool' },
      { key: 'msTf', label: 'Market Structure Timeframe', kind: 'select', options: [{ value: '', label: 'Chart' }, ...TIMEFRAMES.map((t) => ({ value: t, label: t }))] },
      { key: 'msSwing', label: 'Swing Strength (bars left/right)', kind: 'int' },
      { key: 'msLineLength', label: 'MS Line Min Length (bars)', kind: 'int' },
      { key: 'msRightExtend', label: 'MS Line Right Extension (bars)', kind: 'int' },
      { key: 'msBreakOnClose', label: 'Confirm Break With Candle Close', kind: 'bool' },
      { key: 'msBullText', label: 'Bullish Line Text', kind: 'text' },
      { key: 'msBearText', label: 'Bearish Line Text', kind: 'text' },
      // FD-STYLEUNIFY: each line its colour, width, style and text size
      { key: 'msBullColor', label: 'Bullish MS Line', kind: 'look', color: 'msBullColor', width: 'msBullLineWidth', style: 'msBullLineStyle', size: 'msBullTextSize' },
      { key: 'msBearColor', label: 'Bearish MS Line', kind: 'look', color: 'msBearColor', width: 'msBearLineWidth', style: 'msBearLineStyle', size: 'msBearTextSize' },
    ],
  },
];

// Names, groups, limits and tooltips from logarithmic-moving-average.pine; "Style" mirrors TradingView's Style tab.
/** FD-STYLEUNIFY: a threshold line: its colour (the script's until one is chosen), width, style and level. */
export const lmaLine = (key: 'long' | 'short' | 'neutral', label: string): FieldDef<LmaParams> => ({
  key: `${key}LineColor`,
  label,
  kind: 'look',
  toggle: `show${key === 'long' ? 'Long' : key === 'short' ? 'Short' : 'Neutral'}Line`,
  color: `${key}LineColor`,
  scriptColor: (d) => lmaScriptLineColors(effectiveLmaParams(d))[key],
  width: `${key}LineWidth`,
  style: `${key}LineStyle`,
  value: (d) => (lmaHlines(effectiveLmaParams(d)).find((x) => x.key === key) as ReturnType<typeof lmaHlines>[number]).price,
});
export const lmaSwatch = (d: LmaParams) => `linear-gradient(135deg, ${d.bullishColor} 33%, ${d.neutralColor} 33% 66%, ${d.bearishColor} 66%)`;
export const LMA_GROUPS: GroupDef<LmaParams>[] = [
  {
    title: 'Strategy Presets',
    fields: [{ key: 'preset', label: 'Strategy Preset', kind: 'select', options: LMA_PRESETS.map((v) => ({ value: v, label: v })), tip: LMA_TOOLTIPS.preset }],
  },
  {
    title: 'LMA Core Settings',
    fields: [
      { key: 'period', label: 'LMA Period', kind: 'int', min: 50, max: 200, tip: LMA_TOOLTIPS.period },
      { key: 'steepness', label: 'Log Steepness', kind: 'float', step: 0.1, min: 1.5, max: 5, tip: LMA_TOOLTIPS.steepness },
      { key: 'maType', label: 'Smoothing MA Type', kind: 'select', options: LMA_MA_TYPES.map((v) => ({ value: v, label: v })), tip: LMA_TOOLTIPS.maType },
      { key: 'smooth', label: 'Signal Smoothing', kind: 'int', min: 3, max: 25, tip: LMA_TOOLTIPS.smooth },
      { key: 'momentumWeight', label: 'Momentum Confirmation Weight', kind: 'float', step: 0.1, min: 1, max: 2, tip: LMA_TOOLTIPS.momentumWeight },
    ],
  },
  {
    title: 'Trading Thresholds',
    fields: [
      { key: 'longThreshold', label: 'Long Entry Threshold', kind: 'float', step: 0.1, min: 0.1, max: 2, tip: LMA_TOOLTIPS.longThreshold },
      { key: 'shortThreshold', label: 'Short Entry Threshold', kind: 'float', step: 0.1, min: -2, max: -0.1, tip: LMA_TOOLTIPS.shortThreshold },
    ],
  },
  {
    title: 'Visual Settings',
    fields: [
      { key: 'bullishColor', label: 'Bullish Color', kind: 'color', inline: 'colors' },
      { key: 'bearishColor', label: 'Bearish Color', kind: 'color', inline: 'colors' },
      { key: 'neutralColor', label: 'Neutral Color', kind: 'color', inline: 'colors' },
      { key: 'colorBars', label: 'Color Price Bars', kind: 'bool', tip: LMA_TOOLTIPS.colorBars },
    ],
  },
  {
    title: 'Style',
    fields: [
      {
        key: 'signalWidth',
        label: 'LMA Signal',
        kind: 'look',
        toggle: 'showSignal',
        swatch: lmaSwatch,
        note: 'Culoarea vine din Bullish / Neutral / Bearish Color, după starea semnalului.',
        width: 'signalWidth',
        style: 'signalStyle',
      },
      { key: 'showFill', label: 'LMA Signal Fill', kind: 'bool' },
      { key: 'showBarColors', label: 'LMA Signal Bar Colors', kind: 'bool' },
      lmaLine('long', 'Long Threshold'),
      lmaLine('short', 'Short Threshold'),
      lmaLine('neutral', 'Neutral Line'),
    ],
  },
];

/** The fields a named LMA preset forces (shown locked, with the preset's values). */
export const lmaLocked = (d: LmaParams): Partial<LmaParams> | null => LMA_PRESET_VALUES[d.preset] ?? null;

/** Groups consecutive fields that share an `inline` key into one row. */
export function rowsOf<F extends { inline?: string }>(fields: F[]): F[][] {
  const rows: F[][] = [];
  for (const f of fields) {
    const last = rows.at(-1);
    if (f.inline && last && last[0]?.inline === f.inline) last.push(f);
    else rows.push([f]);
  }
  return rows;
}

/**
 * Sentiq.iOS FD-V3-S19 / TD-V4-S2: one field described for the app's native sheet, the same values and rules as the
 * drawer's. `add(key, fn)` registers what an edit of `key` does to the draft and gives the field's key back.
 */
export function premiumHostField<P extends Record<string, unknown>>(f: FieldDef<P>, draft: P, forced: Partial<P> | null, add: (key: keyof P & string, fn: (d: P, v: HostValue) => P) => string): HostField {
  const set = (k: keyof P & string, value: unknown) => (d: P): P => ({ ...d, [k]: value });
  const isForced = forced !== null && f.key in forced;
  const v = isForced ? (forced as Record<string, unknown>)[f.key] : draft[f.key];
  const tip = f.tip ? { tip: f.tip } : {};
  if (f.kind === 'bool') {
    const why = f.lockedWhen?.(draft) ?? null;
    return { k: 'bool', key: add(f.key, (d, x) => set(f.key, x === true)(d)), label: f.label, value: Boolean(v), off: why !== null, ...(why ? { why } : {}), ...tip };
  }
  if (f.kind === 'look') {
    const colorKey = f.color;
    const saved = colorKey ? draft[colorKey] : null;
    const color = colorKey ? String(saved ?? f.scriptColor?.(draft) ?? '#000000') : (f.swatch?.(draft) ?? '#000000');
    const level = f.value?.(draft);
    const look: Extract<HostField, { k: 'look' }> = { k: 'look', label: f.label, colors: [{ ...(colorKey ? { key: add(colorKey, (d, x) => set(colorKey, hostString(x))(d)) } : {}), label: f.label, value: color }], ...tip };
    if (f.note) look.note = f.note;
    if (f.toggle) {
      const t = f.toggle;
      look.toggle = { key: add(t, (d, x) => set(t, x === true)(d)), value: Boolean(draft[t]) };
    }
    if (f.width) {
      const w = f.width;
      look.width = { key: add(w, (d, x) => set(w, Math.min(4, Math.max(1, Math.round(hostNumber(x)) || 1)))(d)), value: Number(draft[w]) };
    }
    if (f.style) {
      const st = f.style;
      look.style = { key: add(st, (d, x) => set(st, PINE_STYLE[hostStyle(x)])(d)), value: boxStyle(draft[st]) };
    }
    if (f.size) {
      const sz = f.size;
      look.size = { key: add(sz, (d, x) => set(sz, hostString(x))(d)), value: String(draft[sz]), options: [...SIGNAL_SIZE_NAMES] };
    }
    if (level !== undefined) look.level = { value: Number.isFinite(level) ? level : null };
    return look;
  }
  const forcedFlag = isForced ? { forced: true } : {};
  if (f.kind === 'color') return { k: 'color', key: add(f.key, (d, x) => set(f.key, hostString(x))(d)), label: f.label, value: String(v), ...tip };
  if (f.kind === 'select') return { k: 'select', key: add(f.key, (d, x) => set(f.key, hostString(x))(d)), label: f.label, value: String(v), options: f.options, ...forcedFlag, ...tip };
  if (f.kind === 'text') return { k: 'text', key: add(f.key, (d, x) => set(f.key, hostString(x).slice(0, 200))(d)), label: f.label, value: String(v), ...forcedFlag, ...tip };
  return {
    k: 'number', key: add(f.key, (d, x) => set(f.key, hostNumber(x))(d)), label: f.label, value: Number.isFinite(v as number) ? (v as number) : null, int: f.kind === 'int',
    step: f.step ?? (f.kind === 'int' ? 1 : 0.1), ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}), off: isForced, ...forcedFlag, ...tip,
  }; // prettier-ignore
}

/** „Salvează”: the draft checked by the settings' schema; what is wrong in the drawer's words, or the values to save. */
export function premiumCheck<P>(schema: ZodType<P>, draft: P, groups: GroupDef<P>[]): { ok: true; data: P } | { ok: false; invalid: string } {
  const r = schema.safeParse(draft);
  if (r.success) return { ok: true, data: r.data };
  // A rule across fields (e.g. one of Long / Short) says what is wrong in its own words.
  const rule = r.error.issues.find((i) => i.code === 'custom');
  if (rule) return { ok: false, invalid: rule.message };
  const allFields = groups.flatMap((g) => g.fields);
  const bad = [...new Set(r.error.issues.map((i) => String(i.path[0])))].map((k) => {
    const f = allFields.find((x) => fieldKeys(x).includes(k));
    const range = f && (f.kind === 'int' || f.kind === 'float') && f.min !== undefined && f.max !== undefined ? ` (${f.min} – ${f.max})` : '';
    return `${f?.label ?? k}${range}`;
  });
  return { ok: false, invalid: `Valori invalide: ${bad.join(', ')}.` };
}
