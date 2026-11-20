// Numbers in the bots' words (the summary, the journal), as the pages write them: 84.425,3 (FD-BOT §7); at most the
// decimals FIX-DECIMALS shows (two from 1 on, four under 1).
import { isUsdQuote } from '../../shared/bot.ts';
import { maxDecimals, priceDecimals } from '../../shared/decimals.ts';

const formats = new Map<string, Intl.NumberFormat>();

/** A number with at most `max` decimals (at least `min`), in Romanian; never more than FIX-DECIMALS shows. */
export function num(v: number, max = 2, min = 0): string {
  const m = Math.min(max, maxDecimals(v));
  return digits(v, Math.min(min, m), m);
}

function digits(v: number, min: number, max: number): string {
  const key = `${min}|${max}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: min, maximumFractionDigits: max });
    formats.set(key, f);
  }
  return f.format(v);
}

/** A price with the decimals FIX-DECIMALS shows: 2 from 1 on, 4 under 1; a forex / commodity rate (`fx`) 4 under 10. */
export const price = (v: number, fx = false): string => digits(v, 0, priceDecimals(v, fx));

/** FIX-BOTBUDGET: a sum in a bot's currency: two decimals in dollars, in a coin as FIX-DECIMALS shows (0,0005 BTC). */
export const money = (v: number, currency: string): string => (isUsdQuote(currency) ? num(v, 2, 2) : num(v, 8));

/** An amount of an asset (FIX-DECIMALS: 0,0123 BTC, 1.234,57 DOGE). */
export const qty = (v: number): string => num(v, 8);

/** A profit with its sign: +12,30 / −4,10. */
export const signed = (v: number): string => `${v >= 0 ? '+' : '−'}${num(Math.abs(v), 2, 2)}`;
