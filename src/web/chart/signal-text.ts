// The Slingshot tables' words (FD-SLINGSHOT34, FD-IOSCHART): the alerts' and the outcomes' names, why a signal closed,
// the sources' names. Pure, shared by the chart page and the iOS app's chart engine (Sentiq.iOS TD-V4-S2).
import type { SlingshotAlert, SlingshotSignal } from '../../shared/indicator/slingshot.ts';

export const ALERT_RO: Record<string, string> = {
  longSignal: 'Long Signal',
  takeProfitSignal: 'Take Profit Signal',
  atrTakeProfit: 'ATR Take Profit Hit',
  atrStopLoss: 'ATR Stop Loss Hit',
  msBullish: 'Bullish Market Structure',
  msBearish: 'Bearish Market Structure',
  shortSignal: 'Short Signal',
  shortTakeProfitSignal: 'Short Take Profit Signal',
  shortAtrTakeProfit: 'Short ATR Take Profit Hit',
  shortAtrStopLoss: 'Short ATR Stop Loss Hit',
};
export const OUTCOME_RO: Record<string, string> = { active: 'Activ', tp: 'TP atins', sl: 'SL atins', invalidated: 'Invalidat' };
export const EXCHANGE_NAME: Record<string, string> = { kucoin: 'KuCoin', binance: 'Binance', bybit: 'Bybit', okx: 'OKX', bitget: 'Bitget', twelvedata: 'Twelve Data', nasdaq: 'Nasdaq', cboe: 'Cboe', cnbc: 'CNBC' };
export const MARKET_RO: Record<string, string> = { open: 'bursa e deschisă', pre: 'pre-market', after: 'after-hours', closed: 'bursa e închisă' };
export const REASON_RO: Record<string, string> = {
  takeProfitSignal: 'maximul depășit',
  atrTakeProfit: 'ținta ATR',
  stopLoss: 'stop loss',
  superseded: 'înlocuit de un semnal nou',
  trendFlip: 'trendul s-a întors',
};
/** Why a signal closed; a SHORT's take profit signal is a low broken (FD-SLINGSHOT34). */
export const reasonRo = (s: SlingshotSignal) => (s.side === 'short' && s.outcomeReason === 'takeProfitSignal' ? 'minimul depășit' : s.outcomeReason ? REASON_RO[s.outcomeReason] : '');

/** Collapses consecutive repeats of the same alert (e.g. ATR TP on every bar above the target). */
export function collapseAlerts(alerts: SlingshotAlert[]): (SlingshotAlert & { count: number })[] {
  const out: (SlingshotAlert & { count: number })[] = [];
  for (const a of alerts) {
    const prev = out.at(-1);
    if (prev && prev.type === a.type && a.bar - (prev.bar + prev.count - 1) === 1) prev.count++;
    else out.push({ ...a, count: 1 });
  }
  return out;
}
