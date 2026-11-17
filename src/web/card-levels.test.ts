import { describe, expect, it } from 'vitest';
import { cardLevels } from './card-levels.ts';

describe('FIX-CARDROWS: the TP / SL rows of an Azi card', () => {
  const long = { side: 'long' as const, tp: 66120.4, sl: 62980.1 };
  const short = { side: 'short' as const, tp: 61250.4, sl: 66862.2 };
  it('both sides: four rows, the LONG first, each with its side', () => {
    expect(cardLevels({ atr: long, atrShort: short }).map((l) => [l.label, l.value, l.tone])).toEqual([
      ['LONG TP', 66120.4, 'bull'],
      ['LONG SL', 62980.1, 'bear'],
      ['SHORT TP', 61250.4, 'bull'],
      ['SHORT SL', 66862.2, 'bear'],
    ]);
  });
  it('one side only: its two rows', () => {
    expect(cardLevels({ atr: long, atrShort: null }).map((l) => l.label)).toEqual(['LONG TP', 'LONG SL']);
    expect(cardLevels({ atr: null, atrShort: short }).map((l) => l.label)).toEqual(['SHORT TP', 'SHORT SL']);
    expect(cardLevels({ atr: undefined, atrShort: short }).map((l) => l.label)).toEqual(['SHORT TP', 'SHORT SL']);
  });
  it('no side: no row', () => {
    expect(cardLevels({ atr: null, atrShort: null })).toEqual([]);
  });
  it('the keys differ (React siblings)', () => {
    const keys = cardLevels({ atr: long, atrShort: short }).map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
