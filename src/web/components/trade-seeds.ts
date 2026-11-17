// What "Închide" (a position) and "Vinde" (a holding) open (FD-TRADING §4): from the Trades page and from the × of a
// trade's box on the chart (FD-TRADEUI).
import type { AccountView, BalanceRow, PositionRow } from '../../shared/api-types.ts';
import type { TicketSeed } from './OrderTicket.tsx';

/** FD-TRADING §4: what "Închide" opens for a position (a market order that only reduces it; eToro: the positions). */
export function closeSeed(account: AccountView, pos: PositionRow): TicketSeed | null {
  const base = pos.symbol.split('/')[0] ?? pos.symbol;
  if (account.exchange === 'etoro') return pos.ref?.positionIds ? { kind: 'stocks', accountId: account.id, symbol: base, side: 'sell', close: { positionIds: pos.ref.positionIds }, amount: pos.size ?? pos.contracts, title: `Închide poziția ${base}` } : null;
  // FIX-PAPERLEV: a profile's position closes reduce-only on its own market (a spot pair has no settlement), never turning.
  const paper = account.exchange === 'paper';
  if (account.kind === 'stocks') return { kind: 'stocks', accountId: account.id, symbol: base, side: pos.side === 'short' ? 'buy' : 'sell', amount: pos.size ?? pos.contracts, ...(paper ? { reduceOnly: true } : {}), title: `Închide poziția ${base}` };
  const market = paper && !pos.symbol.includes(':') ? 'spot' : 'futures';
  // Only where trading was switched on for that market (a spot-only key shows its positions without the button).
  if (!account.trading.markets.includes(market)) return null;
  const mode = pos.marginMode === 'cross' || pos.marginMode === 'isolated' ? pos.marginMode : undefined;
  return { kind: 'crypto', accountId: account.id, market, symbol: pos.symbol, side: pos.side === 'short' ? 'buy' : 'sell', amount: pos.size ?? pos.contracts, reduceOnly: true, marginMode: mode, title: `Închide ${pos.symbol}` };
}

/** What "Vinde" opens for a holding (eToro: closing its positions; IBKR: nothing). */
export function sellSeed(account: AccountView, b: BalanceRow): TicketSeed | null {
  if (account.exchange === 'ibkr') return null;
  if (account.exchange === 'etoro') return b.ref?.positionIds ? { kind: 'stocks', accountId: account.id, symbol: b.asset, side: 'sell', close: { positionIds: b.ref.positionIds }, amount: b.total, title: `Vinde ${b.asset} (închide pozițiile)` } : null;
  if (account.kind === 'stocks') return { kind: 'stocks', accountId: account.id, symbol: b.ref?.ticker ?? b.asset, side: 'sell', amount: b.free, title: `Vinde ${b.asset}` };
  if (!account.trading.markets.includes('spot')) return null;
  return { kind: 'crypto', accountId: account.id, market: 'spot', symbol: `${b.asset}/USDT`, side: 'sell', amount: b.free, title: `Vinde ${b.asset}` };
}
