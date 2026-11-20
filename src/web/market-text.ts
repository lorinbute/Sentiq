// FD-MARKETMOVE: the markets' reactions in words, as the Today card and "Cum s-a calculat?" tell them. The index values
// as on the card ("7.6"); the other numbers in the page's (Romanian) style.
import type { MarketPart } from '../shared/api-types.ts';
import { dayKey } from '../shared/time.ts';
import { fmtNum, fmtWeekday } from './format.ts';

/** "−2,00%", "+1,31%", "0,00%". */
export const signedPct = (v: number): string => `${v > 0.004 ? '+' : v < -0.004 ? '−' : ''}${fmtNum(Math.abs(v), 2, 2)}%`;

/** A share in whole percents ("74%"), "sub 1%" below. */
export const sharePct = (v: number): string => (v < 0.005 ? 'sub 1%' : `${Math.round(v * 100)}%`);

/** The reaction is worth showing: at least 1% of its part. */
export const marketShown = (m: MarketPart | null | undefined): m is MarketPart => Boolean(m && m.share >= 0.005);

/** The part's name as the sentence needs it: "Acțiunilor", "Crypto". */
export const partOf = (m: MarketPart): string => (m.area === 'crypto' ? 'Crypto' : 'Acțiunilor');

/**
 * Stocks: "Piața acum" while the session is on; then "La închiderea de azi" / "La închiderea de joi, 19 noiembrie".
 * Crypto (never closed): "Crypto în ultimele 24 de ore".
 */
export function marketWhen(m: MarketPart, tz: string, now: number): string {
  if (m.area === 'crypto') return 'Crypto în ultimele 24 de ore';
  if (m.live || m.closedAt === null) return 'Piața acum';
  return dayKey(m.closedAt, tz) === dayKey(now, tz) ? 'La închiderea de azi' : `La închiderea de ${fmtWeekday(m.closedAt, tz)}`;
}

/** "S&P 500 −2,00%, Nasdaq 100 −3,74%". */
export const marketMoves = (m: MarketPart): string => m.indices.map((i) => `${i.name} ${signedPct(i.changePct)}`).join(', ');

/** "de 3,9 și 4,5 ori mișcarea unei zile obișnuite" (how rare, whichever the direction). */
export function marketRarity(m: MarketPart): string {
  const zs = m.indices.map((i) => fmtNum(Math.abs(i.z), 1, 1));
  const list = zs.length > 1 ? `${zs.slice(0, -1).join(', ')} și ${zs.at(-1)}` : (zs[0] ?? '0');
  return `de ${list} ori mișcarea unei zile obișnuite`;
}

/** The Today card's line under the four parts, one per market. */
export function marketLine(m: MarketPart, tz: string, now: number): string {
  const share = sharePct(m.share);
  return (
    `${marketWhen(m, tz, now)}: ${marketMoves(m)}, ${marketRarity(m)}. ` +
    `Reacția pieței (${m.value.toFixed(1)}) ${m.live ? 'are' : 'mai are'} ${share} din scorul ${partOf(m)}${m.live ? '' : ' (scade cu orele de la închidere)'}; ` +
    `din știri singure ar fi ${m.news.toFixed(1)}.`
  );
}
