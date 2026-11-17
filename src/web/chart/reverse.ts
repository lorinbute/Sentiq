// FD-REVERSE: whether a position can be turned (TradingView's ⇅). Pure: shared by the dialog, the chart page and the iOS
// app's chart engine (Sentiq.iOS TD-V4-S2).
import type { AccountView } from '../../shared/api-types.ts';

/** Whether a position can be turned from here: a crypto futures one, with futures trading on. */
export const canReverse = (account: AccountView, symbol: string): boolean =>
  // FD-PAPER, FIX-PAPERLEV: a profile turns its positions on every market (shares, spot, futures).
  (account.exchange === 'paper' && account.trading.enabled) || (account.kind === 'crypto' && account.trading.enabled && account.trading.markets.includes('futures') && symbol.includes(':'));
