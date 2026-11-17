// Sentiq.iOS TD-V4-S2 §2: the settings forms of the chart's indicators (Slingshot, LMA, a standard indicator), as the
// chart page's drawer has them: a draft, the same fields, values, rules and messages (study-form.ts, premium-form.ts),
// described for the app's native sheet. The app sends the edits (`set`), the tab, „Valorile implicite” and „Salvează”;
// a save gives back the settings patch the app sends to the server, then the app says how that went (`saved`).
import { isInputActive } from 'oakscriptjs';
import { DEFAULT_SLINGSHOT_PARAMS, slingshotParamsSchema, SLINGSHOT_TITLE, type SlingshotParams } from '../shared/indicator/params.ts';
import { DEFAULT_LMA_PARAMS, LMA_TITLE, lmaParamsSchema, type LmaParams } from '../shared/indicator/lma-params.ts';
import type { Study, StudyMemoryEntry } from '../shared/studies.ts';
import type { HostValue } from '../web/embed.ts';
import type { HostForm } from '../web/host-form-model.ts';
import { LMA_GROUPS, lmaLocked, premiumCheck, premiumHostField, SLINGSHOT_GROUPS, type GroupDef } from '../web/chart/premium-form.ts';
import { STUDY_MODULES } from '../web/indicators/catalog.ts';
import { STUDY_META } from '../web/indicators/catalog-meta.ts';
import { memoryOf, rememberStudy } from '../web/indicators/memory.ts';
import { activeIn, checkStudyDraft, describeStudy, studyDefaults, studyDraftOf, studyHostForm, studyToSave, type DraftSetter, type StudyDraft } from '../web/indicators/study-form.ts';
import { lastResults } from './chart.ts';

type Status = 'idle' | 'saving' | 'saved' | { error: string };

interface PremiumSession {
  kind: 'premium';
  settingsKey: 'indicator' | 'lma';
  title: string;
  draft: Record<string, unknown>;
  defaults: Record<string, unknown>;
  groups: GroupDef<Record<string, unknown>>[];
  locked: ((d: Record<string, unknown>) => Record<string, unknown> | null) | null;
}

interface StudySession {
  kind: 'study';
  study: Study;
  name: string;
  draft: StudyDraft;
  tab: 'inputs' | 'style';
}

type Session = (PremiumSession | StudySession) & {
  id: number;
  invalid: string | null;
  status: Status;
  setters: Map<string, (d: never, v: HostValue) => unknown>;
};

const sessions = new Map<number, Session>();
let nextId = 1;

export type FormArgs =
  | { op: 'open'; target: string; settings: { indicator?: unknown; lma?: unknown; studies?: Study[] } }
  | { op: 'set'; id: number; key: string; value: HostValue }
  | { op: 'tab'; id: number; tab: 'inputs' | 'style' }
  | { op: 'defaults'; id: number }
  | { op: 'save'; id: number; settings?: { studies?: Study[]; studyMemory?: StudyMemoryEntry[] } }
  | { op: 'saved'; id: number; error?: string | null }
  | { op: 'close'; id: number };

/** The form as the sheet draws it, with the setters of its fields registered on the session. */
function describe(s: Session): HostForm | null {
  if (s.kind === 'premium') {
    const setters = new Map<string, (d: never, v: HostValue) => unknown>();
    const forced = s.locked?.(s.draft) ?? null;
    const add = (key: string, fn: (d: Record<string, unknown>, v: HostValue) => Record<string, unknown>) => {
      setters.set(`p:${key}`, fn as never);
      return `p:${key}`;
    };
    const form: HostForm = {
      target: s.settingsKey === 'indicator' ? 'slingshot' : 'lma',
      title: s.title,
      premium: true,
      intro: 'Aceleași nume, limite și valori implicite ca în TradingView.',
      groups: s.groups.map((g) => ({ title: g.title, fields: g.fields.map((f) => premiumHostField(f, s.draft, forced, add)) })),
      invalid: s.invalid,
      error: typeof s.status === 'object' ? s.status.error : null,
      saving: s.status === 'saving',
      saved: s.status === 'saved' && !s.invalid,
    };
    s.setters = setters;
    return form;
  }
  const mod = STUDY_MODULES[s.study.id];
  if (!mod) return null;
  const active = activeIn(isInputActive as never, mod, s.draft);
  const parts = describeStudy({ mod, study: s.study, draft: s.draft, result: lastResults.get(s.study.uid) ?? null, active });
  s.setters = parts.setters as unknown as Session['setters'];
  return studyHostForm({
    uid: s.study.uid,
    name: s.name,
    mod,
    tab: s.tab,
    parts,
    invalid: s.invalid,
    error: typeof s.status === 'object' ? s.status.error : null,
    saving: s.status === 'saving',
    saved: s.status === 'saved',
  });
}

export function formCall(args: FormArgs): { id: number; form: HostForm | null; patch?: Record<string, unknown> } {
  if (args.op === 'open') {
    const id = nextId++;
    let s: Session;
    if (args.target === 'slingshot' || args.target === 'lma') {
      const isS = args.target === 'slingshot';
      const parsed = isS ? slingshotParamsSchema.safeParse(args.settings.indicator ?? {}) : lmaParamsSchema.safeParse(args.settings.lma ?? {});
      const defaults = (isS ? DEFAULT_SLINGSHOT_PARAMS : DEFAULT_LMA_PARAMS) as unknown as Record<string, unknown>;
      // The drawer's params: the saved ones (LMA's merged over its defaults, as the page does).
      const params = isS ? (parsed.success ? (parsed.data as unknown as Record<string, unknown>) : defaults) : { ...defaults, ...(parsed.success ? (parsed.data as unknown as Record<string, unknown>) : {}) };
      s = {
        id,
        kind: 'premium',
        settingsKey: isS ? 'indicator' : 'lma',
        title: isS ? SLINGSHOT_TITLE : LMA_TITLE,
        draft: params,
        defaults,
        groups: (isS ? SLINGSHOT_GROUPS : LMA_GROUPS) as unknown as GroupDef<Record<string, unknown>>[],
        locked: isS ? null : (lmaLocked as unknown as PremiumSession['locked']),
        invalid: null,
        status: 'idle',
        setters: new Map(),
      };
    } else if (args.target.startsWith('study:')) {
      const uid = args.target.slice(6);
      const study = (args.settings.studies ?? []).find((x) => x.uid === uid);
      const mod = study ? STUDY_MODULES[study.id] : undefined;
      const meta = study ? STUDY_META.find((m) => m.id === study.id) : undefined;
      if (!study || !mod || !meta) return { id: 0, form: null };
      s = { id, kind: 'study', study, name: meta.name, draft: studyDraftOf(mod, study), tab: 'inputs', invalid: null, status: 'idle', setters: new Map() };
    } else return { id: 0, form: null };
    sessions.set(id, s);
    return { id, form: describe(s) };
  }
  const s = sessions.get(args.id);
  if (!s) return { id: args.id, form: null };
  switch (args.op) {
    case 'set': {
      const fn = s.setters.get(args.key);
      if (fn) {
        (s as { draft: unknown }).draft = fn(s.draft as never, args.value);
        // An edit after a save: the "saved" note goes, as in the drawer (its status stays until the next save).
      }
      return { id: s.id, form: describe(s) };
    }
    case 'tab':
      if (s.kind === 'study') s.tab = args.tab;
      return { id: s.id, form: describe(s) };
    case 'defaults': {
      s.invalid = null;
      if (s.kind === 'premium') s.draft = { ...s.defaults };
      else {
        const mod = STUDY_MODULES[s.study.id];
        if (mod) s.draft = studyDefaults(mod);
      }
      return { id: s.id, form: describe(s) };
    }
    case 'save': {
      if (s.kind === 'premium') {
        const schema = s.settingsKey === 'indicator' ? slingshotParamsSchema : lmaParamsSchema;
        const r = premiumCheck(schema as never, s.draft as SlingshotParams & LmaParams, s.groups as never);
        if (!r.ok) {
          s.invalid = r.invalid;
          return { id: s.id, form: describe(s) };
        }
        s.invalid = null;
        s.status = 'saving';
        return { id: s.id, form: describe(s), patch: { [s.settingsKey]: r.data } };
      }
      const mod = STUDY_MODULES[s.study.id];
      if (!mod) return { id: s.id, form: describe(s) };
      const problem = checkStudyDraft(mod, s.draft, activeIn(isInputActive as never, mod, s.draft));
      if (problem) {
        s.invalid = problem.invalid;
        s.tab = problem.tab;
        return { id: s.id, form: describe(s) };
      }
      s.invalid = null;
      s.status = 'saving';
      const next = studyToSave(s.study, mod, s.draft);
      // As the page's saveStudy: the list with this one replaced, its settings remembered (FD-STUDYMEMORY).
      const list = args.settings?.studies ?? [];
      const memory = args.settings?.studyMemory ?? [];
      return { id: s.id, form: describe(s), patch: { studies: list.map((x) => (x.uid === next.uid ? next : x)), studyMemory: rememberStudy(memory, memoryOf(next)) } };
    }
    case 'saved':
      s.status = args.error ? { error: args.error } : 'saved';
      return { id: s.id, form: describe(s) };
    case 'close':
      sessions.delete(s.id);
      return { id: s.id, form: null };
  }
}

// Kept for the types (the LMA params' type is used through the schema).
export type { LmaParams, DraftSetter };
