// Sentiq.iOS FD-TRADESOUND: the site's watch of the chart's trades (useTradeEndSound) without React: the readings of each
// account kept here, compared only with one made while watching (from `start`: the chart seen, another symbol, the app
// back in front), and never across a gap of more than 50 s (trade-ends' MAX_GAP_MS).
import type { Portfolio } from '../shared/api-types.ts';
import { endedTrades, tradeKeys, type TradeSnapshot } from '../web/chart/trade-ends.ts';

export type TradeEndsArgs = { op: 'start'; now: number } | { op: 'read'; accountId: number; at: number; portfolio: Portfolio; base: string };

let seen = new Map<number, TradeSnapshot>();
let watchFrom = Number.POSITIVE_INFINITY;

/** `read`: whether a trade of the chart's asset ended since this account's last reading. */
export function tradeEndsCall(a: TradeEndsArgs): { ended: boolean } | null {
  if (a.op === 'start') {
    seen = new Map();
    watchFrom = a.now;
    return null;
  }
  const prev = seen.get(a.accountId);
  const next = tradeKeys(a.portfolio, a.at, a.base);
  seen.set(a.accountId, next);
  return { ended: Boolean(prev && prev.at >= watchFrom && endedTrades(prev, next).length > 0) };
}
