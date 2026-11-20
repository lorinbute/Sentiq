// FIX-BOTLEVELS: the stop losses / take profits a real bot keeps for the positions it holds, as lines on the chart. The
// bot closes the position itself at them (they are no orders at the platform): drawn dashed, no ×; FIX-BOTDRAG: dragged
// as an order's, the bot gets the new level.
import { etoroInverseOf, fxCompact } from '../../shared/fx.ts';
import type { BotLevel } from '../../shared/bot.ts';
import { pnlAtLevel, PNL_COLORS, type PnlPalette, type TradeLine } from './pnl.ts';

/** A bot's name in a box, at most this long. */
export const BOT_NAME_MAX = 16;

/** Within this share of the price, a bot's level and an order's at the platform are the same level. */
export const SAME_LEVEL = 1e-3;

export interface BotLinesInput {
  /** The chart's coin (BTC) or share (AAPL). */
  base: string;
  quote: string;
  stock: boolean;
  accountId: number;
  /** The account's name, added to every title when several accounts are shown. */
  account?: string;
}

const shortName = (name: string) => (name.length > BOT_NAME_MAX ? `${name.slice(0, BOT_NAME_MAX - 1).trimEnd()}…` : name);

/** Whether a bot's position is on the chart's asset: a share by its ticker, a coin by its base (spot: and its quote). */
export function onChart(l: Pick<BotLevel, 'market' | 'symbol'>, input: Pick<BotLinesInput, 'base' | 'quote' | 'stock'>): boolean {
  // FD-FXCOMMODITIES: a pair's bot (EUR/USD) on its chart, whose base is the accounts' compact form (EURUSD).
  if (input.stock) return l.market === 'stock' && fxCompact(l.symbol) === input.base;
  if (l.market === 'stock') return false;
  const [base, quote] = l.symbol.split('/');
  return base === input.base && (l.market === 'futures' || quote === input.quote);
}

/** What `stillHeld` reads of an account's portfolio. */
export interface HeldRead {
  positions: readonly { symbol: string; side: string }[];
  balances: readonly { asset: string; total: number }[];
  errors?: Partial<Record<string, unknown>>;
}

/**
 * FIX-BOTLEVELGONE (the user: a trade closed from the chart, its SL and TP stayed until long after): a bot's level is
 * drawn while the account still holds what it is for: a position of its side on the asset (futures, a short, a
 * broker's CFD), or for a long on spot or a share also a holding of it. The bot drops its position only at its next
 * look and the levels are read once a minute; the account's portfolio is read at once after a trading action. An
 * account not read yet, or whose positions failed: unknown, kept.
 */
export function stillHeld(l: Pick<BotLevel, 'market' | 'symbol' | 'side'>, p: HeldRead | undefined): boolean {
  if (!p || p.errors?.positions || p.errors?.balances) return true;
  const base = l.market === 'stock' ? fxCompact(l.symbol) : (l.symbol.split('/')[0] ?? l.symbol);
  const baseOf = (s: string) => s.split('/')[0] ?? s;
  const short = l.side === 'short';
  // FIX-ETOROFX: a bot's JPY/USD is a position on USDJPY at eToro, of the other side.
  const via = l.market === 'stock' ? etoroInverseOf(l.symbol) : null;
  if (p.positions.some((x) => (baseOf(x.symbol) === base && (x.side === 'short') === short) || (via !== null && baseOf(x.symbol) === via && (x.side === 'short') !== short))) return true;
  if (short || l.market === 'futures') return false;
  return p.balances.some((b) => b.asset === base && b.total > 0);
}

/**
 * The lines of the bots' levels on this account and asset: one per stop loss / take profit, with the PnL of the bot's
 * position there. `named`: several bots have levels on the chart, each box says which one.
 */
export function botLinesOf(levels: readonly BotLevel[], input: BotLinesInput, colors: PnlPalette = PNL_COLORS, named = false): TradeLine[] {
  const out: TradeLine[] = [];
  const ns = `${input.accountId}`;
  const acct = input.account ? ` (${input.account})` : '';
  const seen = new Map<string, number>();
  for (const l of levels) {
    if (l.accountId !== input.accountId || !onChart(l, input) || !(l.qty > 0) || !(l.entry > 0)) continue;
    const quote = l.market === 'stock' ? 'USD' : (l.symbol.split('/')[1] ?? input.quote);
    const key = `${ns}|bot|${l.bot.id}|${l.symbol}|${l.side}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const group = n ? `${key}#${n}` : key;
    const basis = { long: l.side === 'long', entry: l.entry, qty: l.qty, quote, used: l.margin ?? null };
    // "bot", "bot <name>" among several bots; "… oprit" while it has a problem (its levels do not fire).
    const tag = `bot${named ? ` ${shortName(l.bot.name)}` : ''}${l.active ? '' : ' oprit'}`;
    for (const [role, price] of [
      ['sl', l.sl],
      ['tp', l.tp],
    ] as const) {
      if (price === null || !Number.isFinite(price) || price <= 0) continue;
      const label = `${role === 'sl' ? 'SL' : 'TP'} ${tag}${acct}`;
      out.push({
        id: `${group}|${role}`,
        role,
        group,
        price,
        color: role === 'sl' ? colors.sl : colors.tp,
        title: `${label} ${pnlAtLevel(basis, price).text}`,
        name: label,
        style: 'dashed',
        basis,
        bot: { id: l.bot.id, name: l.bot.name, tag, symbol: l.symbol, side: l.side, openedAt: l.openedAt },
      });
    }
  }
  return out;
}

/**
 * The bots' lines that are not already an order at the platform: the same role and side on the same account, within
 * SAME_LEVEL of the price (eToro's stop loss on a short the bot sent, or one put by hand on the bot's level). The order's
 * line stays: it can be dragged and removed.
 */
export function withoutDuplicates<L extends TradeLine & { account: { id: number } }>(bot: readonly L[], lines: readonly L[]): L[] {
  return bot.filter((b) => {
    const side = b.basis?.long === false ? 'short' : 'long';
    return !lines.some((l) => l.order && l.account.id === b.account.id && l.role === b.role && l.position?.side === side && Math.abs(l.price - b.price) <= Math.abs(b.price) * SAME_LEVEL);
  });
}
