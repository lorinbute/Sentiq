// Slingshot Premium (FD-BOT §6): what the bar that just closed says (a confirmed signal, a take profit signal, what
// became of the signal a position entered on), the levels and the size of a trade, and its exit at the price now.
import { isUsdQuote, liqDistance, LIQ_SAFETY, MIN_TRADE_PROFIT, reached, type BotSide, type PremiumConfig } from '../../shared/bot.ts';
import type { SlingshotResult, SlingshotSetup, SlingshotSignal } from '../../shared/indicator/slingshot.ts';
import { money } from './format.ts';
import type { BotPosition } from './state.ts';

export interface BarEvents {
  /** Signals confirmed on the closed bar (never one on the forming bar). */
  signals: SlingshotSignal[];
  /** Slingshot's take profit signal of each side on the closed bar. */
  tpSignal: Record<BotSide, boolean>;
  /** The last break of the market structure up to the closed bar. */
  structure: 'msBullish' | 'msBearish' | null;
}

export function barEvents(r: SlingshotResult, closed: number): BarEvents {
  const signals = r.signals.filter((s) => s.confirmBar === closed && !s.provisional);
  const at = r.alerts.filter((a) => a.bar === closed && !a.provisional);
  let structure: BarEvents['structure'] = null;
  for (const a of r.alerts) if (a.bar <= closed && (a.type === 'msBullish' || a.type === 'msBearish')) structure = a.type;
  return {
    signals,
    tpSignal: { long: at.some((a) => a.type === 'takeProfitSignal'), short: at.some((a) => a.type === 'shortTakeProfitSignal') },
    structure,
  };
}

export type SignalFate = 'sl' | 'tp' | 'tp_signal' | 'flip' | null;

/** What Slingshot did with the signal a position entered on, by a closed bar (a superseded one keeps the position). */
export function signalFate(r: SlingshotResult, side: BotSide, time: number, closed: number): SignalFate {
  const s = r.signals.find((x) => x.side === side && x.time === time);
  if (!s || s.outcome === 'active' || s.closedBar === undefined || s.closedBar > closed) return null;
  if (s.outcome === 'sl') return 'sl';
  if (s.outcome === 'tp') return s.outcomeReason === 'takeProfitSignal' ? 'tp_signal' : 'tp';
  return s.outcomeReason === 'trendFlip' ? 'flip' : null;
}

/** FIX-BOTSHORTS: the setups forming on the closed bar (never one on the forming bar). */
export const setupsOn = (r: SlingshotResult, closed: number): SlingshotSetup[] => (r.setups ?? []).filter((x) => x.bar === closed && !x.provisional);

/**
 * FIX-BOTSHORTS: what became of a setup a position entered on (its V2 search started at `start`), by a closed bar: the
 * signal it was confirmed as (the search ends at the first confirmation after its start, whose V2 is within it), still
 * forming, or ended without a signal.
 */
export function setupFate(r: SlingshotResult, side: BotSide, start: number, closed: number): { signal: SlingshotSignal } | 'forming' | 'cancelled' {
  const signal = r.signals.find((s) => s.side === side && s.time >= start && s.confirmBar <= closed && !s.provisional);
  if (signal) return { signal };
  return setupsOn(r, closed).some((x) => x.side === side && x.startTime === start) ? 'forming' : 'cancelled';
}

/**
 * The stop loss and the take profit of a trade entered at `price` (FD-BOT §6), or why it cannot be entered: Slingshot's
 * are the signal's both, as they are, whatever the R:R from the price now (FD-BOTSLRR); "Risc / câștig" puts them at the
 * user's percents from the entry (FD-BOTPCT).
 */
export function levelsFor(cfg: PremiumConfig, signal: Pick<SlingshotSignal, 'side' | 'sl' | 'tp'>, price: number): { sl: number; tp: number } | { error: string } {
  const dir = signal.side === 'long' ? 1 : -1;
  const slingshot = cfg.levels === 'slingshot';
  const sl = slingshot ? signal.sl : price * (1 - (dir * cfg.slPct) / 100);
  if (!(dir * (price - sl) > 0)) return { error: 'Prețul a trecut deja de stop loss.' };
  const tp = slingshot ? signal.tp : price * (1 + (dir * cfg.tpPct) / 100);
  if (!(dir * (tp - price) > 0)) return { error: 'Prețul a atins deja take profit-ul.' };
  if (!(tp > 0)) return { error: 'Take profit-ul ar fi la un preț sub zero.' };
  return { sl, tp };
}

export interface SizeIn {
  cfg: PremiumConfig;
  /** Leverage and margin apply (futures; a Paper Trading profile's every market). */
  futures: boolean;
  /** FIX-BOTBUDGET: the bot's budget (its maximum amount, in margin) and the margin of its open trades. */
  budget: number;
  committed: number;
  /** The trades it may still open: its open trades' maximum (at most one a symbol) less those open; at least 1. */
  slots: number;
  leverage: number;
  price: number;
  sl: number;
  tp: number;
  /** The commission of one execution, in percent. */
  feePct: number;
  /** FIX-BOTBUDGET: the least a trade must bring at the take profit, in the bot's currency (MIN_TRADE_PROFIT dollars). */
  minProfit: number;
  currency: string;
}

export interface Sized {
  qty: number;
  margin: number;
  lev: number;
  notional: number;
  /** Said in the journal: the leverage lowered for the liquidation. */
  notes: string[];
  /** FIX-BOTBUDGET: the least margin that brings the minimum profit at the take profit, and the most allowed. */
  lower: number;
  upper: number;
}

/** A margin within [lower, upper]. */
export const clampMargin = (v: number, lower: number, upper: number): number => Math.min(upper, Math.max(lower, v));

/**
 * The size of a trade (FD-BOT §6, FIX-BOTBUDGET): at the bot's leverage (lowered until the stop loss comes well before
 * the liquidation), the bot's free budget shared among the trades it may still open, at most its maximum a trade and
 * at least what brings MIN_TRADE_PROFIT at the take profit after the commissions in and out. Refused when even the
 * most allowed would bring less.
 */
export function sizeFor(x: SizeIn): Sized | { error: string } {
  const free = x.budget - x.committed;
  const upper = Math.min(x.cfg.maxPerTrade, free);
  if (!(upper > 0)) return { error: 'bugetul botului e tot în tranzacții deschise.' };
  const dist = Math.abs(x.price - x.sl) / x.price;
  const notes: string[] = [];
  let lev = x.futures ? Math.max(1, x.leverage) : 1;
  // The stop loss must come well before the liquidation.
  while (x.futures && lev > 1 && dist >= LIQ_SAFETY * liqDistance(lev)) {
    lev -= 1;
    if (!notes.includes(LIQ_NOTE)) notes.push(LIQ_NOTE);
  }
  if (x.futures && dist >= LIQ_SAFETY * liqDistance(lev)) return { error: 'Stop loss-ul e prea departe: poziția s-ar lichida înaintea lui.' };
  // What a unit of margin brings at the take profit, the commissions in and out taken.
  const edge = lev * (Math.abs(x.tp - x.price) / x.price - (2 * x.feePct) / 100);
  if (!(edge > 0)) return { error: 'take profit-ul e prea aproape: nu acoperă comisioanele de intrare și de ieșire.' };
  const lower = x.minProfit / edge;
  if (lower > upper * (1 + 1e-9)) {
    const c = x.currency;
    return { error: `cu cel mult ${money(upper, c)} ${c} disponibili pentru tranzacție, ea ar aduce la take profit ${money(upper * edge, c)} ${c}: sub minimul de ${MIN_TRADE_PROFIT} USD${isUsdQuote(c) ? '' : ` (${money(x.minProfit, c)} ${c})`}.` };
  }
  const margin = clampMargin(free / Math.max(1, x.slots), lower, upper);
  return { qty: (margin * lev) / x.price, margin, lev, notional: margin * lev, notes, lower, upper };
}

const LIQ_NOTE = 'Levierul a fost coborât: stop loss-ul trebuie atins cu mult înaintea lichidării.';

/**
 * FIX-BOTSHORTS: a trade cut to what the account has free, at the same leverage: the platform takes the margin and the
 * opening fee (KuCoin's order cost: the value × (1 / leverage + the fee)). FIX-BOTBUDGET: never under its least
 * (`lower`): null when the account has less than that.
 */
export function fitFunds(x: Sized, free: number, feePct: number, price: number): Sized | null {
  const margin = free / (1 + (x.lev * feePct) / 100);
  if (!(margin > 0) || !(price > 0) || margin < x.lower * (1 - 1e-9)) return null;
  const notional = margin * x.lev;
  return { ...x, qty: notional / price, margin, notional };
}

/** A trade at another margin (the AI's choice), within its bounds, at the same leverage. */
export function withMargin(x: Sized, margin: number, price: number): Sized {
  const m = clampMargin(margin, x.lower, x.upper);
  return { ...x, qty: (m * x.lev) / price, margin: m, notional: m * x.lev };
}

/** What a trade asks of the account: its margin (its cost on spot) and the opening fee. */
export const fundsFor = (x: Pick<Sized, 'margin' | 'notional'>, feePct: number): number => x.margin + (x.notional * feePct) / 100;

/** The stop loss or the take profit reached at `price`. */
export function exitAt(p: Pick<BotPosition, 'side' | 'sl' | 'tp'>, price: number): 'sl' | 'tp' | null {
  const long = p.side === 'long';
  if (p.sl !== null && reached(price, p.sl, !long)) return 'sl';
  if (p.tp !== null && reached(price, p.tp, long)) return 'tp';
  return null;
}
