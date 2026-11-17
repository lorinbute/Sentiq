import type { ScanRow } from '../shared/api-types.ts';

/** One TP / SL level of an Azi card (FIX-CARDROWS): its own row, the side written on it. */
export interface CardLevel {
  key: string;
  label: string;
  value: number;
  tone: 'bull' | 'bear';
}

/**
 * The card's levels, one per row: the LONG's TP and SL first, then the SHORT's (FD-SLINGSHOT34: the two sides are
 * independent, either may be missing).
 */
export function cardLevels(r: Pick<ScanRow, 'atr' | 'atrShort'>): CardLevel[] {
  return [r.atr, r.atrShort].flatMap((a) => {
    if (!a) return [];
    const side = a.side === 'short' ? 'SHORT' : 'LONG';
    return [
      { key: `${a.side}-tp`, label: `${side} TP`, value: a.tp, tone: 'bull' as const },
      { key: `${a.side}-sl`, label: `${side} SL`, value: a.sl, tone: 'bear' as const },
    ];
  });
}
