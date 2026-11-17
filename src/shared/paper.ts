// FD-PAPER: Paper Trading profiles: their settings, how a commission is charged, what a profile trades. Shared by the
// server (validation, the engine) and the pages.
import { z } from 'zod';
import type { TradeMarket } from './trading.ts';

/** TradingView's starting balance. */
export const PAPER_DEFAULT_BUDGET = 100_000;
export const PAPER_MIN_BUDGET = 100;
export const PAPER_MAX_BUDGET = 1_000_000_000;
/** The default commission: a percent of each execution's value. */
export const PAPER_DEFAULT_COMMISSION = { type: 'percent', value: 0.1 } as const;

export type PaperKind = 'crypto' | 'stocks';
export type CommissionType = 'percent' | 'fixed';
export const COMMISSION_MAX: Record<CommissionType, number> = { percent: 10, fixed: 10_000 };
export const COMMISSION_TYPE_RO: Record<CommissionType, string> = { percent: 'Procent', fixed: 'Fix' };
export const PAPER_KIND_RO: Record<PaperKind, string> = { crypto: 'Crypto', stocks: 'Acțiuni' };

/** What a profile trades: a crypto one spot and futures (as an exchange), a stocks one shares (as a broker). */
export const PAPER_MARKETS: Record<PaperKind, TradeMarket[]> = { crypto: ['spot', 'futures'], stocks: ['stock'] };

/** The quotes counted as dollars (1:1). */
export const USD_QUOTES: ReadonlySet<string> = new Set(['USDT', 'USDC', 'USD']);
export const isUsdQuote = (quote: string): boolean => USD_QUOTES.has(quote.toUpperCase());

const name = z.string({ error: 'Numele lipsește' }).trim().min(1, 'Numele lipsește').max(60, 'Numele: cel mult 60 de caractere');
const budget = z
  .number({ error: 'Bugetul lipsește' })
  .finite('Bugetul trebuie să fie un număr')
  .min(PAPER_MIN_BUDGET, `Bugetul: cel puțin ${PAPER_MIN_BUDGET} USD`)
  .max(PAPER_MAX_BUDGET, 'Bugetul: cel mult 1.000.000.000 USD');
const commission = {
  commissionType: z.enum(['percent', 'fixed'], { error: 'Tipul comisionului lipsește' }),
  commissionValue: z.number({ error: 'Comisionul lipsește' }).finite('Comisionul trebuie să fie un număr').min(0, 'Comisionul nu poate fi negativ'),
};
const commissionLimit = (v: { commissionType: CommissionType; commissionValue: number }, ctx: z.RefinementCtx) => {
  if (v.commissionValue > COMMISSION_MAX[v.commissionType]) {
    ctx.addIssue({ code: 'custom', path: ['commissionValue'], message: v.commissionType === 'percent' ? 'Comisionul: cel mult 10%' : 'Comisionul: cel mult 10.000 USD pe execuție' });
  }
};

/** A new profile (POST /api/accounts/paper). */
export const paperCreateSchema = z.object({ label: name, kind: z.enum(['crypto', 'stocks'], { error: 'Piața lipsește' }), budget, ...commission }).strict().superRefine(commissionLimit);
export type PaperCreate = z.infer<typeof paperCreateSchema>;

/** A profile's settings (PUT /api/accounts/:id/paper): its name and commission, from the next execution. */
export const paperSettingsSchema = z.object({ label: name, ...commission }).strict().superRefine(commissionLimit);
export type PaperSettingsInput = z.infer<typeof paperSettingsSchema>;

/** A reset (POST /api/accounts/:id/paper/reset): positions, orders and history gone, the money the new budget. */
export const paperResetSchema = z.object({ budget }).strict();

/** A profile as the pages see it (in the account's view). */
export interface PaperProfile {
  kind: PaperKind;
  budget: number;
  cash: number;
  commissionType: CommissionType;
  commissionValue: number;
  resetAt: number;
}

/** The commission of one execution: a percent of its value, or a fixed sum (USD) whatever its size. */
export const commissionOf = (type: CommissionType, value: number, notional: number): number => (type === 'percent' ? (Math.abs(notional) * value) / 100 : value);

const fmt = (v: number) => new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 4 }).format(v);

/** „0,1% pe execuție”, „1 USD pe execuție”, „fără comision”. */
export function commissionText(type: CommissionType, value: number): string {
  if (!(value > 0)) return 'fără comision';
  return type === 'percent' ? `${fmt(value)}% pe execuție` : `${fmt(value)} USD pe execuție`;
}
