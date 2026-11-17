// The settings of one standard indicator (FD-INDICATORS §3) as data: its draft, its rules on „Salvează” and its
// description for the iOS app's native sheet (FD-V3-S19), the same fields, values and setters as the drawer's. Pure (no
// React): shared by StudySettings and the app's chart engine (Sentiq.iOS TD-V4-S2).
import type { IndicatorResult, InputConfig, PlotConfig } from 'oakscriptjs';
import type { LineStyleId, Study } from '../../shared/studies.ts';
import { TIMEFRAMES } from '../../shared/time.ts';
import type { HostValue } from '../embed.ts';
import { hostNumber, hostString, hostStyle, type HostField, type HostForm, type HostGroup } from '../host-form-model.ts';
import { changedInputs, inputProblem, pineTf, sanitizeInputs, SOURCES } from './compute.ts';
import type { StudyModule } from './catalog.ts';
import { hlineDefault, hlineShown, lineKind, plotWidth, styleFills, styleHlines, stylePlots } from './style.ts';
import { colorKey, INPUT_COLORED, INPUT_LINES, lineInput, linkStyle } from './color-links.ts';

/** FD-STYLEUNIFY: a line's style as the script declares it (TradingView's names), solid when it declares none. */
export const styleId = (v: unknown): LineStyleId => (v === 'dashed' || v === 'dotted' ? v : 'solid');

type PlotStyle = NonNullable<Study['plots']>[string];
type HlineStyle = NonNullable<Study['hlines']>[string];
type FillStyle = NonNullable<Study['fills']>[string];

/** The form's draft: the inputs and the Style tab's choices. */
export interface StudyDraft {
  inputs: Record<string, unknown>;
  plots: Record<string, PlotStyle>;
  hlines: Record<string, HlineStyle>;
  fills: Record<string, FillStyle>;
}

/** What an edit of a field does to the draft. */
export type DraftSetter = (d: StudyDraft, v: HostValue) => StudyDraft;

/** The timeframes an input can take: the chart's, Sentiq's, the month (from daily bars). */
export const TF_OPTIONS: { value: string; label: string }[] = [{ value: '', label: 'Grafic' }, ...TIMEFRAMES.map((t) => ({ value: pineTf(t), label: t })), { value: '1M', label: '1M' }];

/** Consecutive inputs of one group (Pine `group`), and in it the rows of inputs that share `inline`. */
export function groupsOf(inputs: readonly InputConfig[]): { title: string | null; rows: InputConfig[][] }[] {
  const out: { title: string | null; rows: InputConfig[][] }[] = [];
  for (const cfg of inputs) {
    const title = cfg.group ?? null;
    let g = out.at(-1);
    if (!g || g.title !== title) {
      g = { title, rows: [] };
      out.push(g);
    }
    const row = g.rows.at(-1);
    if (cfg.inline && row && row[0]?.inline === cfg.inline) row.push(cfg);
    else g.rows.push([cfg]);
  }
  return out;
}

/** The draft a form opens with (FD-COLORUNIFY: in the linked form). */
export function studyDraftOf(mod: StudyModule, study: Study): StudyDraft {
  const st = linkStyle(study);
  return { inputs: sanitizeInputs(mod, st.inputs), plots: { ...(st.plots ?? {}) }, hlines: { ...(st.hlines ?? {}) }, fills: { ...(st.fills ?? {}) } };
}

/** „Valorile implicite”: TradingView's inputs, no style chosen. */
export const studyDefaults = (mod: StudyModule): StudyDraft => ({ inputs: { ...mod.defaultInputs }, plots: {}, hlines: {}, fills: {} });

export const setInput = (id: string, v: unknown) => (d: StudyDraft): StudyDraft => ({ ...d, inputs: { ...d.inputs, [id]: v } });
export const setPlot = (id: string, patch: Partial<PlotStyle>) => (d: StudyDraft): StudyDraft => ({ ...d, plots: { ...d.plots, [id]: { ...d.plots[id], ...patch } } });
export const setHline = (id: string, patch: Partial<HlineStyle>) => (d: StudyDraft): StudyDraft => ({ ...d, hlines: { ...d.hlines, [id]: { ...d.hlines[id], ...patch } } });
export const setFill = (key: string, patch: Partial<FillStyle>) => (d: StudyDraft): StudyDraft => ({ ...d, fills: { ...d.fills, [key]: { ...d.fills[key], ...patch } } });
/** FD-COLORUNIFY: a line's width or style written to every plot in `ids` (a colour input that colours several lines). */
export const setPlots = (ids: readonly string[], patch: Partial<PlotStyle>) => (d: StudyDraft): StudyDraft => ({ ...d, plots: { ...d.plots, ...Object.fromEntries(ids.map((pid) => [pid, { ...d.plots[pid], ...patch }])) } });

/** Whether an input applies now (an input that depends on another is greyed out while it does not). */
export type InputActive = (cfg: InputConfig, inputs: Record<string, unknown>, all: InputConfig[]) => boolean;
export const activeIn = (isInputActive: InputActive, mod: StudyModule, draft: StudyDraft) => (cfg: InputConfig): boolean => {
  try {
    return isInputActive(cfg, draft.inputs, mod.inputConfig);
  } catch {
    return true;
  }
};

/** FD-COLORUNIFY: a line's width and style in its box, as they show now (the first plot's of `ids`). */
export function lineBoxOf(def: PlotConfig, draft: StudyDraft): { lineWidth?: number; lineStyle?: LineStyleId } {
  const o = draft.plots[def.id] ?? {};
  return {
    ...(lineKind(def) ? { lineWidth: o.width ?? plotWidth(def) } : {}),
    ...(lineKind(def) === 'line' ? { lineStyle: o.style ?? styleId(def.linestyle) } : {}),
  };
}

/** „Salvează”'s checks: an invalid input (only those that apply), then an invalid level. Null when the draft is fine. */
export function checkStudyDraft(mod: StudyModule, draft: StudyDraft, active: (cfg: InputConfig) => boolean): { invalid: string; tab: 'inputs' | 'style' } | null {
  const bad = mod.inputConfig
    .filter((cfg) => active(cfg) && inputProblem(cfg, draft.inputs[cfg.id]) !== null)
    .map((cfg) => {
      const range = (cfg.type === 'int' || cfg.type === 'float') && (cfg.min !== undefined || cfg.max !== undefined) ? ` (${cfg.min ?? '…'} – ${cfg.max ?? '…'})` : '';
      return `${cfg.title ?? cfg.id}${range}`;
    });
  if (bad.length) return { invalid: `Valori invalide: ${bad.join(', ')}.`, tab: 'inputs' };
  // FD-HLINELEVELS: a level left empty (or not a number) is refused with the line's name.
  const badLevels = styleHlines(mod).filter((h) => {
    const v = draft.hlines[h.id]?.price;
    return v !== undefined && (!Number.isFinite(v) || Math.abs(v) > 1e12);
  });
  if (badLevels.length) return { invalid: `Nivel invalid: ${badLevels.map((h) => h.title ?? h.id).join(', ')}.`, tab: 'style' };
  return null;
}

/** The indicator as saved from the draft: the inputs that differ from TradingView's, the style chosen. */
export function studyToSave(study: Study, mod: StudyModule, draft: StudyDraft): Study {
  const clean = <T extends Record<string, unknown>>(r: Record<string, T>) => {
    const out: Record<string, T> = {};
    for (const [k, o] of Object.entries(r)) {
      const kept = Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;
      if (Object.keys(kept).length) out[k] = kept;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const next: Study = { uid: study.uid, id: study.id, visible: study.visible, inputs: changedInputs(mod, draft.inputs) };
  const plots = clean(draft.plots);
  const hlines = clean(draft.hlines);
  const fills = clean(draft.fills);
  if (plots) next.plots = plots;
  if (hlines) next.hlines = hlines;
  if (fills) next.fills = fills;
  if (study.height !== undefined) next.height = study.height;
  return next;
}

/** A plot shown in the Style tab's box: its override, else as the script declares it. */
export const plotShownInForm = (def: PlotConfig, o: PlotStyle, inputs: Record<string, unknown>) =>
  o.visible ?? !(def.display === 'none' || (typeof def.visible === 'boolean' && !def.visible) || (typeof def.visible === 'string' && inputs[def.visible] === false));

/** The colour box of a plot's colour (or of one colour of its palette) as it shows now. */
export function plotBoxColor(def: PlotConfig, o: PlotStyle, c: string | null): string {
  return c ? (o.palette?.[c] ?? (o.color && def.color && colorKey(def.color) === colorKey(c) ? o.color : c)) : (o.color ?? def.color ?? '#2962FF');
}

/**
 * Sentiq.iOS FD-V3-S19: the form for the app's sheet: the Intrări groups, the Stil fields and the fills, with a setter for
 * every key. The same fields, values and rules as the drawer's.
 */
export function describeStudy(args: { mod: StudyModule; study: Study; draft: StudyDraft; result: IndicatorResult | null; active: (cfg: InputConfig) => boolean }): {
  inputGroups: HostGroup[];
  styleFields: HostField[];
  fillFields: HostField[];
  setters: Map<string, DraftSetter>;
} {
  const { mod, study, draft, result, active } = args;
  const setters = new Map<string, DraftSetter>();
  const add = (key: string, fn: DraftSetter) => {
    setters.set(key, fn);
    return key;
  };
  const width = (v: HostValue) => Math.min(4, Math.max(1, Math.round(hostNumber(v)) || 1));
  const withLineBox = (look: Extract<HostField, { k: 'look' }>, def: PlotConfig, ids: readonly string[], prefix: string) => {
    const lb = lineBoxOf(def, draft);
    if (lb.lineWidth !== undefined) look.width = { key: add(`${prefix}:w`, (d, v) => setPlots(ids, { width: width(v) })(d)), value: lb.lineWidth };
    if (lb.lineStyle !== undefined) look.style = { key: add(`${prefix}:s`, (d, v) => setPlots(ids, { style: hostStyle(v) })(d)), value: lb.lineStyle };
    return look;
  };
  const hostInput = (cfg: InputConfig): HostField => {
    const v = draft.inputs[cfg.id];
    const off = !active(cfg);
    const label = cfg.title ?? cfg.id;
    const tip = cfg.tooltip;
    const key = `in:${cfg.id}`;
    if (cfg.type === 'bool') return { k: 'bool', key: add(key, (d, x) => setInput(cfg.id, x === true)(d)), label, value: Boolean(v), off, ...(tip ? { tip } : {}) };
    if (cfg.type === 'color') {
      const ids = INPUT_LINES[study.id]?.[cfg.id] ?? [];
      const line = ids.length ? mod.plotConfig.find((p) => p.id === ids[0]) : undefined;
      const boxName = label.trim() || line?.title || cfg.inline || cfg.id;
      const look: Extract<HostField, { k: 'look' }> = { k: 'look', label: line ? `${boxName}: linie` : boxName, colors: [{ key: add(key, (d, x) => setInput(cfg.id, hostString(x))(d)), label: boxName, value: String(v ?? '#000000') }], ...(tip ? { tip } : {}) };
      return line ? withLineBox(look, line, ids, key) : look;
    }
    const options = cfg.options?.length ? cfg.options.map((o) => ({ value: o, label: o })) : cfg.type === 'source' ? SOURCES.map((x) => ({ value: x, label: x })) : cfg.type === 'timeframe' ? TF_OPTIONS : null;
    if (options) {
      const value = String(v ?? '');
      // A saved value no longer in the list stays visible until changed.
      const all = options.some((o) => o.value === value) ? options : [{ value, label: value }, ...options];
      return { k: 'select', key: add(key, (d, x) => setInput(cfg.id, hostString(x))(d)), label, value, options: all, off, ...(tip ? { tip } : {}) };
    }
    if (cfg.type === 'int' || cfg.type === 'float') {
      return {
        k: 'number', key: add(key, (d, x) => setInput(cfg.id, hostNumber(x))(d)), label, value: typeof v === 'number' && Number.isFinite(v) ? v : null, int: cfg.type === 'int',
        ...(cfg.min !== undefined ? { min: cfg.min } : {}), ...(cfg.max !== undefined ? { max: cfg.max } : {}), ...(cfg.step !== undefined ? { step: cfg.step } : {}), off, ...(tip ? { tip } : {}),
      }; // prettier-ignore
    }
    if (cfg.type === 'time') return { k: 'time', key: add(key, (d, x) => setInput(cfg.id, typeof x === 'number' ? x : NaN)(d)), label, value: typeof v === 'number' && Number.isFinite(v) ? v : null, off, ...(tip ? { tip } : {}) };
    return { k: 'text', key: add(key, (d, x) => setInput(cfg.id, hostString(x).slice(0, 300))(d)), label, value: String(v ?? ''), ...(cfg.type === 'text_area' ? { area: true } : {}), off, ...(tip ? { tip } : {}) };
  };
  const inputGroups: HostGroup[] = groupsOf(mod.inputConfig).map((g) => ({ title: g.title, fields: g.rows.flat().map(hostInput) }));
  const styleFields: HostField[] = [
    ...stylePlots(mod).map((def): HostField => {
      const o = draft.plots[def.id] ?? {};
      const shown = plotShownInForm(def, o, draft.inputs);
      const palette = def.palette?.length ? def.palette : null;
      const title = def.title || def.id;
      const input = lineInput(study.id, def.id);
      const colored = INPUT_COLORED[study.id]?.[def.id];
      const prefix = `plot:${def.id}`;
      const look: Extract<HostField, { k: 'look' }> = { k: 'look', label: title, toggle: { key: add(`${prefix}:v`, (d, x) => setPlot(def.id, { visible: x === true })(d)), value: shown }, colors: [] };
      if (input) look.colors = [{ key: add(`${prefix}:in`, (d, x) => setInput(input, hostString(x))(d)), label: `${title}: linie`, value: String(draft.inputs[input] ?? def.color ?? '#2962FF') }];
      else if (colored) {
        look.colors = [{ label: `${title}: culori`, value: '', gradient: colored.inputs.map((i) => String(draft.inputs[i] ?? '#787B86')) }];
        look.note = colored.note;
      } else
        look.colors = (palette ?? [null]).map((c) => ({
          key: add(`${prefix}:c:${c ?? ''}`, (d, x) => setPlot(def.id, c ? { palette: { ...(d.plots[def.id] ?? {}).palette, [c]: hostString(x) } } : { color: hostString(x) })(d)),
          label: c ? `${title}: culoarea ${c}` : `${title}: culoare`,
          value: plotBoxColor(def, o, c),
        }));
      return withLineBox(look, def, [def.id], prefix);
    }),
    ...styleHlines(mod).map((h): HostField => {
      const o = draft.hlines[h.id] ?? {};
      const prefix = `hl:${h.id}`;
      return {
        k: 'look',
        label: h.title || h.id,
        toggle: { key: add(`${prefix}:v`, (d, x) => setHline(h.id, { visible: x === true })(d)), value: hlineShown(h, o) },
        level: { key: add(`${prefix}:p`, (d, x) => setHline(h.id, { price: hostNumber(x) })(d)), value: o.price === undefined ? h.price : Number.isFinite(o.price) ? o.price : null },
        colors: [{ key: add(`${prefix}:c`, (d, x) => setHline(h.id, { color: hostString(x) })(d)), label: `${h.title ?? h.id}: culoare`, value: o.color ?? hlineDefault(mod, h, result) }],
        width: { key: add(`${prefix}:w`, (d, x) => setHline(h.id, { width: width(x) })(d)), value: o.width ?? h.linewidth ?? 1 },
        style: { key: add(`${prefix}:s`, (d, x) => setHline(h.id, { style: hostStyle(x) })(d)), value: o.style ?? styleId(h.linestyle) },
      };
    }),
  ];
  const fillFields: HostField[] = styleFills(mod, result).map((f) => {
    const o = draft.fills[f.key] ?? {};
    return {
      k: 'look',
      label: f.title,
      toggle: { key: add(`fill:${f.key}:v`, (d, x) => setFill(f.key, { visible: x === true })(d)), value: o.visible ?? true },
      colors: f.color !== null ? [{ key: add(`fill:${f.key}:c`, (d, x) => setFill(f.key, { color: hostString(x) })(d)), label: `${f.title}: culoare`, value: o.color ?? f.color }] : [],
    };
  });
  return { inputGroups, styleFields, fillFields, setters };
}

/** The sheet's whole form (its tabs, intro, empty notes and the save's state). */
export function studyHostForm(args: {
  uid: string;
  name: string;
  mod: StudyModule;
  tab: 'inputs' | 'style';
  parts: { inputGroups: HostGroup[]; styleFields: HostField[]; fillFields: HostField[] };
  invalid: string | null;
  error: string | null;
  saving: boolean;
  saved: boolean;
}): HostForm {
  const { mod, tab, parts } = args;
  return {
    target: `study:${args.uid}`,
    title: args.name,
    premium: false,
    tabs: [
      { id: 'inputs', label: 'Intrări' },
      { id: 'style', label: 'Stil' },
    ],
    tab,
    intro: tab === 'inputs' && mod.inputConfig.length > 0 ? 'Aceleași nume, limite și valori implicite ca în TradingView.' : null,
    empty: tab === 'inputs' ? (mod.inputConfig.length === 0 ? 'Indicatorul nu are intrări.' : null) : parts.styleFields.length === 0 && parts.fillFields.length === 0 ? 'Nimic de stilizat.' : null,
    groups: tab === 'inputs' ? parts.inputGroups : [{ title: null, fields: parts.styleFields }, ...(parts.fillFields.length ? [{ title: 'Umpleri', fields: parts.fillFields }] : [])],
    invalid: args.invalid,
    error: args.error,
    saving: args.saving,
    saved: args.saved && !args.invalid,
  };
}
