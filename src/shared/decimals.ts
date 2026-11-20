// FIX-DECIMALS (the user, 20 Nov 2026: „Maxim două zecimale afișezi în orice număr, cu excepția numerelor care sunt
// sub 1”): every number shown has at most two decimals from 1 on and at most four under 1. Two choices of the user's:
// under 0,0001 a number keeps its first four digits (PEPE's 0,00001234; four decimals would read 0,0000), and a forex
// or commodity rate keeps four decimals under 10 (EUR/USD 1,0845 moves on the fourth, FD-FXCOMMODITIES).

/** The most decimals `v` is shown with: 2 from 1 on (and for 0), 4 under 1, under 0,0001 its first four digits. */
export function maxDecimals(v: number): number {
  const a = Math.abs(v);
  if (!Number.isFinite(a) || a === 0 || a >= 1) return 2;
  if (a >= 0.0001) return 4;
  return Math.min(12, Math.ceil(-Math.log10(a)) + 3);
}

/** A price's decimals: a forex / commodity rate (`fx`) four under 10 and two from 10, any other price `maxDecimals`. */
export const priceDecimals = (v: number, fx = false): number => (fx ? (Math.abs(v) < 10 ? 4 : 2) : maxDecimals(v));
