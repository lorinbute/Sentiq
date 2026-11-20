import { describe, expect, it } from 'vitest';
import type { Portfolio, TradeStats } from './accounts.ts';
import { isVirtual, mergeAllHistory, orderAccounts, sumPortfolios, sumStats } from './all-accounts.ts';
import type { TradeHistoryRow } from './trade-history.ts';

const portfolio = (over: Omit<Partial<Portfolio>, 'totals'> & { totals?: Partial<Portfolio['totals']> }): Portfolio =>
  ({ accountId: 1, exchange: 'kucoin', kind: 'crypto', currency: 'USDT', cash: null, asOf: null, mode: 'classic', balances: [], positions: [], orders: [], fills: [], errors: {}, stale: {}, fetchedAt: 0, ...over, totals: { spotValue: 0, unrealizedPnl: 0, futuresAvailable: null, ...over.totals } }) as Portfolio;
const stats = (over: Partial<TradeStats>): TradeStats =>
  ({ period: '30d', from: 0, to: 0, supported: true, wins: 0, losses: 0, breakeven: 0, successRate: null, net: 0, netPartial: false, currency: 'USD', asOf: null, limited: false, unknownResults: 0, error: null, fetchedAt: 0, ...over }) as TradeStats;
const row = (key: string, closedAt: number): TradeHistoryRow => ({ key, closedAt, openedAt: closedAt - 1 }) as TradeHistoryRow;

describe('FD-TRADESALL: „Toate”', () => {
  it('tells the virtual accounts: a demo environment or a Paper Trading profile', () => {
    expect(isVirtual({ env: 'demo', exchange: 'etoro' })).toBe(true);
    expect(isVirtual({ env: 'paper', exchange: 'paper' })).toBe(true);
    expect(isVirtual({ env: 'live', exchange: 'paper' })).toBe(true);
    expect(isVirtual({ env: 'live', exchange: 'kucoin' })).toBe(false);
  });

  it('orders the accounts as the user named them, the others after by id; unknown and repeated ids ignored', () => {
    const list = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    expect(orderAccounts(list, [3, 9, 1, 3]).map((a) => a.id)).toEqual([3, 1, 2, 4]);
    expect(orderAccounts(list, []).map((a) => a.id)).toEqual([1, 2, 3, 4]);
  });

  it('sums in USD: cash and futures free, the holdings, the PnL; at a rate; an account unread or without a rate left out', () => {
    const r = sumPortfolios(
      [
        { accountId: 1, label: 'KuCoin', portfolio: portfolio({ cash: 100, totals: { spotValue: 1000, unrealizedPnl: 12.345, futuresAvailable: 250 } }), error: null, rate: 1 },
        { accountId: 2, label: 'T212', portfolio: portfolio({ currency: 'EUR', cash: 50, totals: { spotValue: 200, unrealizedPnl: -10 } }), error: null, rate: 1.1 },
        { accountId: 3, label: 'Bybit', portfolio: null, error: { code: 'NETWORK', message: 'nu răspunde' }, rate: null },
        { accountId: 4, label: 'IBKR', portfolio: portfolio({ currency: 'CHF', cash: 10 }), error: null, rate: null },
      ],
      false,
      5,
    );
    expect(r.totals).toEqual({ available: 405, spotValue: 1220, unrealizedPnl: 1.35 });
    expect(r.left).toEqual([
      { accountId: 3, reason: 'Fără Bybit: nu răspunde' },
      { accountId: 4, reason: 'Fără IBKR: valoarea în CHF nu s-a putut trece în USD.' },
    ]);
    expect(r.accounts.map((a) => a.accountId)).toEqual([1, 2, 3, 4]);
    expect(r.accounts[0]).not.toHaveProperty('label');
  });

  it('sums the results: the counts of those with a closed history, the rate from the sums, the net in USD, partial when one is missing', () => {
    const r = sumStats(
      [
        { label: 'KuCoin', stats: stats({ wins: 3, losses: 1, breakeven: 1, net: 40 }), error: null, rate: 1 },
        { label: 'T212', stats: stats({ wins: 1, losses: 1, net: 10, currency: 'EUR' }), error: null, rate: 1.1 },
        { label: 'Kraken', stats: stats({ supported: false, wins: null, losses: null, net: null }), error: null, rate: null },
      ],
      '30d',
      0,
      9,
    );
    expect(r).toMatchObject({ supported: true, wins: 4, losses: 2, breakeven: 1, successRate: 66.7, net: 51, netPartial: false, currency: 'USD', error: null, left: [] });
    const failed = sumStats([{ label: 'KuCoin', stats: null, error: { code: 'NETWORK', message: 'nu răspunde' }, rate: null }, { label: 'Bybit', stats: stats({ wins: 1, net: 5 }), error: null, rate: 1 }], '30d', 0, 9);
    expect(failed).toMatchObject({ wins: 1, net: 5, netPartial: true, error: null, left: ['KuCoin: nu răspunde'] });
    const none = sumStats([{ label: 'KuCoin', stats: stats({ error: { code: 'AUTH', message: 'cheia' } as TradeStats['error'] }), error: null, rate: null }], '30d', 0, 9);
    expect(none).toMatchObject({ supported: false, wins: null, net: null, error: { code: 'AUTH', message: 'cheia' } });
    expect(sumStats([], '30d', 0, 9)).toMatchObject({ supported: false, net: null, error: null });
  });

  it('combines the trades: the newest first, each with its account and a key unique across them; the errors on their lines', () => {
    const base = { period: '30d' as const, from: 0, to: 0, truncated: false, supported: true, error: null, limited: false, asOf: null, fetchedAt: 0 };
    const r = mergeAllHistory(
      [
        { accountId: 1, label: 'KuCoin', history: { ...base, rows: [row('a', 10), row('b', 30)] }, error: null },
        { accountId: 2, label: 'eToro', history: { ...base, rows: [row('a', 20)], error: { code: 'NETWORK', message: 'parțial' } }, error: null },
        { accountId: 3, label: 'Bybit', history: null, error: { code: 'AUTH', message: 'cheia' } },
      ],
      '30d',
      0,
      9,
    );
    expect(r.rows.map((x) => [x.key, x.accountId])).toEqual([['1:b', 1], ['2:a', 2], ['1:a', 1]]);
    expect(r.error).toEqual({ code: 'EXCHANGE', message: 'eToro: parțial\nBybit: cheia' });
    expect(r.supported).toBe(true);
    // A platform's message that already starts with the account's name keeps it once.
    const once = mergeAllHistory([{ accountId: 1, label: 'eToro', history: null, error: { code: 'AUTH', message: 'eToro: cheile nu sunt valide' } }], '30d', 0, 9);
    expect(once.error?.message).toBe('eToro: cheile nu sunt valide');
  });
});
