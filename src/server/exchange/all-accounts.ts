// FD-TRADESALL: Tranzacții' „Toate” (the iOS app): every account of the user at once. The real-money accounts (the
// virtual ones only when the user includes them), in the user's order; the sums in USD; the period's results summed;
// the trades of the period combined, each with its account. Pure: the routes read the accounts and the rates.
import { isUsdQuote } from '../../shared/bot.ts';
import { isPaperExchange } from '../../shared/providers.ts';
import { isDemoEnv } from '../../shared/trading.ts';
import type { Portfolio, TradeStats } from './accounts.ts';
import { HISTORY_MAX_ROWS, type TradeHistory, type TradeHistoryRow } from './trade-history.ts';

/** An account with virtual money: a demo environment (eToro Virtual, a testnet) or a Paper Trading profile. */
export const isVirtual = (a: { env: string; exchange: string }): boolean => isDemoEnv(a.env) || isPaperExchange(a.exchange);

/** The accounts in the user's order: those it names first (as it names them), the others after, by id. */
export function orderAccounts<T extends { id: number }>(list: T[], order: readonly number[]): T[] {
  const at = new Map<number, number>();
  order.forEach((id, i) => {
    if (!at.has(id)) at.set(id, i);
  });
  return [...list].sort((a, b) => {
    const x = at.get(a.id);
    const y = at.get(b.id);
    if (x !== undefined && y !== undefined) return x - y;
    if (x !== undefined) return -1;
    if (y !== undefined) return 1;
    return a.id - b.id;
  });
}

/** The dollar's value of one unit of a currency: 1 for the dollars and their stablecoins. */
export const dollarRate = (currency: string): number | null => (isUsdQuote(currency) ? 1 : null);

export interface AccountError {
  code: string;
  message: string;
}

/** One account's read for „Toate”: its portfolio (or why not) and its currency's rate in USD (null: none). */
export interface AllAccount {
  accountId: number;
  label: string;
  portfolio: Portfolio | null;
  error: AccountError | null;
  rate: number | null;
}

/** An account left out of the sums, and why (said under them). */
export interface LeftOut {
  accountId: number;
  reason: string;
}

export interface AllPortfolio {
  currency: 'USD';
  /** The virtual accounts are in. */
  virtual: boolean;
  accounts: Omit<AllAccount, 'label'>[];
  totals: { available: number; spotValue: number; unrealizedPnl: number };
  left: LeftOut[];
  fetchedAt: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** An account's message with its name before it, once (a platform's own message may already start with it). */
const named = (label: string, message: string): string => (message.toLowerCase().startsWith(`${label.toLowerCase()}:`) ? message : `${label}: ${message}`);

/** Why an account cannot be counted, else null. */
const leftReason = (a: AllAccount): string | null => {
  if (!a.portfolio) return `Fără ${named(a.label, a.error?.message ?? 'contul nu s-a putut citi.')}`;
  if (a.rate === null) return `Fără ${a.label}: valoarea în ${a.portfolio.currency} nu s-a putut trece în USD.`;
  return null;
};

/**
 * The sums in USD: what is free to trade (a broker's or a profile's cash, the stablecoins free on spot, what is free
 * in futures), the holdings' value, the open positions' PnL. An account without its portfolio or its rate is left out.
 */
export function sumPortfolios(accounts: AllAccount[], virtual: boolean, now: number): AllPortfolio {
  let available = 0;
  let spotValue = 0;
  let unrealizedPnl = 0;
  const left: LeftOut[] = [];
  for (const a of accounts) {
    const reason = leftReason(a);
    if (reason || !a.portfolio || a.rate === null) {
      left.push({ accountId: a.accountId, reason: reason ?? `Fără ${a.label}.` });
      continue;
    }
    const p = a.portfolio;
    available += ((p.cash ?? 0) + (p.totals.futuresAvailable ?? 0)) * a.rate;
    spotValue += p.totals.spotValue * a.rate;
    unrealizedPnl += p.totals.unrealizedPnl * a.rate;
  }
  return {
    currency: 'USD',
    virtual,
    accounts: accounts.map(({ label: _label, ...rest }) => rest),
    totals: { available: round2(available), spotValue: round2(spotValue), unrealizedPnl: round2(unrealizedPnl) },
    left,
    fetchedAt: now,
  };
}

/** One account's results for „Toate”, with its currency's rate (null: none). */
export interface AllStatsPart {
  label: string;
  stats: TradeStats | null;
  error: AccountError | null;
  rate: number | null;
}

/**
 * The period's results of all the accounts: the counts summed over those that give a closed history, the success rate
 * from the sums, the net in USD. One left out (an error, no history, no rate) makes the net partial.
 */
export function sumStats(parts: AllStatsPart[], period: TradeStats['period'], from: number, now: number): TradeStats & { left: string[] } {
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let net = 0;
  let counted = 0;
  let netCounted = 0;
  let partial = false;
  let unknown = 0;
  let limited = false;
  const left: string[] = [];
  let firstError: TradeStats['error'] = null;
  for (const p of parts) {
    const s = p.stats;
    if (!s || s.error) {
      partial = true;
      const e = s?.error ?? p.error;
      if (e && !firstError) firstError = { code: (s?.error?.code ?? 'EXCHANGE') as NonNullable<TradeStats['error']>['code'], message: e.message };
      left.push(named(p.label, e?.message ?? 'rezultatele nu s-au putut citi.'));
      continue;
    }
    if (!s.supported) continue;
    counted += 1;
    wins += s.wins ?? 0;
    losses += s.losses ?? 0;
    breakeven += s.breakeven ?? 0;
    unknown += s.unknownResults;
    limited ||= s.limited;
    if (s.net !== null) {
      const rate = isUsdQuote(s.currency) ? 1 : p.rate;
      if (rate === null) {
        partial = true;
        left.push(`${p.label}: câștigul în ${s.currency} nu s-a putut trece în USD.`);
      } else {
        net += s.net * rate;
        netCounted += 1;
      }
    }
    partial ||= s.netPartial;
  }
  const supported = counted > 0;
  return {
    period,
    from,
    to: now,
    supported,
    wins: supported ? wins : null,
    losses: supported ? losses : null,
    breakeven: supported ? breakeven : null,
    successRate: supported && wins + losses ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
    net: netCounted ? round2(net) : null,
    netPartial: partial && netCounted > 0,
    currency: 'USD',
    asOf: null,
    limited,
    unknownResults: unknown,
    // Every account failed: the first error; some: the others' results, the failed ones under them (`left`).
    error: !supported && firstError && left.length === parts.length ? firstError : null,
    left,
    fetchedAt: now,
  };
}

/** One account's trades of the period for „Toate” (or why not). */
export interface AllHistoryPart {
  accountId: number;
  label: string;
  history: Omit<TradeHistory, 'exchange' | 'broker'> | null;
  error: AccountError | null;
}

export type AllHistoryRow = TradeHistoryRow & { accountId: number };

/** When a trade happened: its close, else its opening. */
const at = (r: TradeHistoryRow): number => r.closedAt ?? r.openedAt ?? 0;

/**
 * The period's trades of all the accounts, the newest first, each with its account (its key made unique across them),
 * at most HISTORY_MAX_ROWS; the accounts' errors in one message (each on its line).
 */
export function mergeAllHistory(parts: AllHistoryPart[], period: TradeHistory['period'], from: number, now: number): Omit<TradeHistory, 'rows'> & { rows: AllHistoryRow[] } {
  const rows: AllHistoryRow[] = [];
  const errors: string[] = [];
  let truncated = false;
  let supported = false;
  let limited = false;
  for (const p of parts) {
    const h = p.history;
    if (!h) {
      errors.push(named(p.label, p.error?.message ?? 'istoricul nu s-a putut citi.'));
      continue;
    }
    if (h.error) errors.push(named(p.label, h.error.message));
    truncated ||= h.truncated;
    supported ||= h.supported;
    limited ||= h.limited;
    for (const r of h.rows) rows.push({ ...r, key: `${p.accountId}:${r.key}`, accountId: p.accountId });
  }
  rows.sort((a, b) => at(b) - at(a));
  return {
    period,
    from,
    to: now,
    rows: rows.slice(0, HISTORY_MAX_ROWS),
    truncated: truncated || rows.length > HISTORY_MAX_ROWS,
    supported,
    error: errors.length ? { code: 'EXCHANGE', message: errors.join('\n') } : null,
    limited,
    asOf: null,
    fetchedAt: now,
  };
}
