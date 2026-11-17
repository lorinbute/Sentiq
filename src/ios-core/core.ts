// Sentiq.iOS TD-V4-S2 §2: the chart engine the app runs in JavaScriptCore (no page, no DOM). One entry point,
// `SentiqCore.call(name, json) -> json`, called on the engine's own thread, one call at a time. Every answer is
// `{ ok: true, value }` or `{ ok: false, error }`: a failure in the site's code never throws into the app.
import { computeChart, type ComputeRequest } from './chart.ts';
import { catalog } from './catalog.ts';
import { formCall } from './forms.ts';
import { studiesCall } from './studies.ts';
import { tradeEndsCall } from './trade-ends.ts';
import { tradesCall } from './trades.ts';

type Handler = (args: never) => unknown;

const HANDLERS: Record<string, Handler> = {
  version: () => ({ engine: 1 }),
  catalog: () => catalog(),
  compute: (req: ComputeRequest) => computeChart(req),
  form: (args: Parameters<typeof formCall>[0]) => formCall(args),
  studies: (args: Parameters<typeof studiesCall>[0]) => studiesCall(args),
  trades: (args: Parameters<typeof tradesCall>[0]) => tradesCall(args),
  tradeEnds: (args: Parameters<typeof tradeEndsCall>[0]) => tradeEndsCall(args),
};

/** NaN / Infinity as null (JSON has neither), the way the app reads them. */
const replacer = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? null : v);

export function call(name: string, json: string): string {
  try {
    const handler = HANDLERS[name];
    if (!handler) return JSON.stringify({ ok: false, error: `unknown call ${name}` });
    const args = json ? (JSON.parse(json) as never) : (undefined as never);
    return JSON.stringify({ ok: true, value: handler(args) }, replacer);
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
}

(globalThis as unknown as { SentiqCore: { call: typeof call } }).SentiqCore = { call };
