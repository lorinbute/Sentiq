// The site's pages in the iOS app (FD-IOSPAGES; the chart's part is FD-IOSCHART; Sentiq.iOS TD §7, §14): a page runs in
// a WKWebView, the app around it is native. The page tells the app what it shows (events), takes its commands (the
// timeframe, the indicators, the chart's settings…) and asks it for what only the app has (iOS's passkeys). In the
// browser none of this exists: `embedded` is false and nothing is sent.
import { createContext, useContext, useEffect, useRef } from 'react';

/** What the app may ask of the embedded chart. */
export type EmbedCommand =
  | { type: 'open'; path: string }
  | { type: 'tf'; tf: string }
  | { type: 'picker' }
  | { type: 'look' }
  | { type: 'reset' }
  | { type: 'menu' }
  | { type: 'ticket' }
  | { type: 'bots' }
  | { type: 'positions'; on: boolean }
  | { type: 'refresh' }
  // Sentiq.iOS FD-V3-S19: the native „Indicatori” sheet, the native settings of an indicator, the jump to a signal.
  | { type: 'addStudy'; id: string }
  | { type: 'addPremium'; key: 'slingshot' | 'lma' }
  | { type: 'favorite'; id: string }
  | { type: 'formSet'; key: string; value: HostValue }
  | { type: 'formTab'; tab: 'inputs' | 'style' }
  | { type: 'formSave' }
  | { type: 'formDefaults' }
  | { type: 'formClose' }
  | { type: 'goto'; time: number };

/** A value the app sets in a form's field (an empty number field is null). */
export type HostValue = string | number | boolean | null;

/** A chart's path the app may open: a pair, a share, an index (nothing else of the site). */
export const CHART_PATH_RE = /^\/charts(\/(s|i)\/[A-Za-z0-9.^-]{1,20}|\/[A-Za-z0-9.-]{1,20}\/[A-Za-z0-9.-]{1,20})?$/;

const COMMAND_TYPES = new Set<EmbedCommand['type']>([
  'open', 'tf', 'picker', 'look', 'reset', 'menu', 'ticket', 'bots', 'positions', 'refresh',
  'addStudy', 'addPremium', 'favorite', 'formSet', 'formTab', 'formSave', 'formDefaults', 'formClose', 'goto',
]); // prettier-ignore

/** An indicator's id (a standard one, Slingshot, LMA). */
const STUDY_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A field's value as the app may send it: short text, a finite number, a box ticked or not, nothing. */
function hostValue(v: unknown): { ok: true; value: HostValue } | { ok: false } {
  if (v === null || typeof v === 'boolean') return { ok: true, value: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, value: v } : { ok: false };
  if (typeof v === 'string') return v.length <= 300 ? { ok: true, value: v } : { ok: false };
  return { ok: false };
}

interface Bridge {
  postMessage(message: unknown): void;
}

/** The app's message handler (WKScriptMessageHandler "sentiq"), when the page runs inside it. */
function bridge(): Bridge | null {
  const w = globalThis as unknown as { webkit?: { messageHandlers?: { sentiq?: Bridge } } };
  return w.webkit?.messageHandlers?.sentiq ?? null;
}

/** Tells the app something (`chart`, `signals`, `alerts`, `navigate`…); nothing in a browser. */
export function sendToHost(type: string, data?: unknown): void {
  try {
    bridge()?.postMessage({ type, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) });
  } catch {
    // The app went away (the view is closing): nothing to tell.
  }
}

/** The page runs inside the iOS app (its message handler is there), whatever page it is. */
export function isEmbeddedApp(): boolean {
  return bridge() !== null;
}

/** Requests to the app that answer (a passkey from iOS): pending ones by id. */
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 1;

/**
 * Asks the app for something it answers (`passkeyGet`, `passkeyCreate`); the answer comes through
 * `window.sentiqHost.reply`. A refusal with `cancelled` rejects with a `NotAllowedError`, as the browser's own.
 */
export function hostRequest<T>(type: string, data: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    sendToHost(type, { id, data });
  });
}

/** The app's answer to `hostRequest`; unknown ids are ignored. */
export function hostReply(id: unknown, ok: unknown, value: unknown): void {
  if (typeof id !== 'number') return;
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  if (ok === true) return w.resolve(value);
  const e = new Error(typeof value === 'string' && value !== 'cancelled' ? value : 'Operația a fost anulată sau a expirat.');
  if (value === 'cancelled') e.name = 'NotAllowedError';
  w.reject(e);
}

type Listener = (c: EmbedCommand) => void;
const listeners = new Set<Listener>();

/** A command from the app, checked: unknown types and malformed ones are dropped. */
export function parseCommand(raw: unknown): EmbedCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.type !== 'string' || !COMMAND_TYPES.has(c.type as EmbedCommand['type'])) return null;
  if (c.type === 'open') return typeof c.path === 'string' && CHART_PATH_RE.test(c.path) && !c.path.includes('..') ? { type: 'open', path: c.path } : null;
  if (c.type === 'tf') return typeof c.tf === 'string' && /^[0-9]{1,2}[mhdw]$/.test(c.tf) ? { type: 'tf', tf: c.tf } : null;
  if (c.type === 'positions') return typeof c.on === 'boolean' ? { type: 'positions', on: c.on } : null;
  if (c.type === 'addStudy' || c.type === 'favorite') return typeof c.id === 'string' && STUDY_ID_RE.test(c.id) ? { type: c.type, id: c.id } : null;
  if (c.type === 'addPremium') return c.key === 'slingshot' || c.key === 'lma' ? { type: 'addPremium', key: c.key } : null;
  if (c.type === 'formSet') {
    // A field's key: the form's own (an input's id, a colour of a palette); no control characters.
    if (typeof c.key !== 'string' || c.key.length === 0 || c.key.length > 300 || [...c.key].some((ch) => ch.charCodeAt(0) < 32)) return null;
    const v = hostValue(c.value);
    return v.ok ? { type: 'formSet', key: c.key, value: v.value } : null;
  }
  if (c.type === 'formTab') return c.tab === 'inputs' || c.tab === 'style' ? { type: 'formTab', tab: c.tab } : null;
  if (c.type === 'goto') return typeof c.time === 'number' && Number.isFinite(c.time) ? { type: 'goto', time: c.time } : null;
  return { type: c.type } as EmbedCommand;
}

/** The entry point the app calls (`window.sentiqHost.command({...})`). */
export function installCommandEntry(): void {
  (globalThis as unknown as { sentiqHost?: unknown }).sentiqHost = {
    command(raw: unknown) {
      const c = parseCommand(raw);
      if (c) for (const l of listeners) l(c);
    },
    reply: hostReply,
  };
}

/** The page is the iOS app's chart (set by the app's entry, never in the browser). */
export const EmbedContext = createContext(false);

export function useEmbedded(): boolean {
  return useContext(EmbedContext);
}

/** Runs `handler` for each command from the app, while `active`. */
export function useEmbedCommands(active: boolean, handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const l: Listener = (c) => ref.current(c);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [active]);
}

/** Sends `data` under `type` whenever it changes (by its JSON), while `active`. */
export function useHostReport(active: boolean, type: string, data: unknown): void {
  const json = active ? JSON.stringify(data ?? null) : '';
  const last = useRef('');
  useEffect(() => {
    if (!active || json === last.current) return;
    last.current = json;
    sendToHost(type, JSON.parse(json));
  }, [active, type, json]);
}
