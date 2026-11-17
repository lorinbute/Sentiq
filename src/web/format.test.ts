import { describe, expect, it } from 'vitest';
import { countRo, fmtBytes, fmtCountdown, positionAmount } from './format.ts';

describe('fmtCountdown', () => {
  const now = Date.parse('2026-10-12T18:46:00Z');
  it('shows days, hours and minutes when more than a day is left', () => {
    expect(fmtCountdown(now + (41 * 60 + 44) * 60_000, now)).toBe('1z 17h 44m');
  });
  it('drops the days, then the hours', () => {
    expect(fmtCountdown(now + (3 * 60 + 5) * 60_000, now)).toBe('3h 05m');
    expect(fmtCountdown(now + 12 * 60_000 + 9_000, now)).toBe('12m 09s');
  });
  it('never goes negative', () => {
    expect(fmtCountdown(now - 60_000, now)).toBe('0m 00s');
  });
});

describe('fmtBytes', () => {
  it('goes up to GB for the database limits (FD-AZURE §5)', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(4.4 * 1024 ** 2)).toBe('4.4 MB');
    expect(fmtBytes(2 * 1024 ** 3)).toBe('2 GB');
    expect(fmtBytes(10 * 1024 ** 3)).toBe('10 GB');
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });
});

describe('countRo', () => {
  it('says the count as Romanian does', () => {
    expect(countRo(1, 'desen', 'desene')).toBe('1 desen');
    expect(countRo(3, 'desen', 'desene')).toBe('3 desene');
    expect(countRo(19, 'indicator', 'indicatori')).toBe('19 indicatori');
    expect(countRo(20, 'indicator', 'indicatori')).toBe('20 de indicatori');
    expect(countRo(101, 'desen', 'desene')).toBe('101 desene');
    expect(countRo(120, 'desen', 'desene')).toBe('120 de desene');
    expect(countRo(200, 'desen', 'desene')).toBe('200 de desene');
  });
});

// FD-TRADESMOBILE: on a phone's narrow card only the unit of an amount may go to the next line.
describe('breakableUnit', () => {
  it('turns only the no-break space before the unit into an ordinary one', async () => {
    const { breakableUnit } = await import('./format.ts');
    expect(breakableUnit('1.000,00\u00a0USD')).toBe('1.000,00 USD');
    expect(breakableUnit('-1.234,50\u00a0USD')).toBe('-1.234,50 USD');
    expect(breakableUnit('70\u00a0%')).toBe('70 %');
    // The amount's own no-break spaces (none in ro-RO, but a group separator could be one) stay; a value without a unit too.
    expect(breakableUnit('1\u00a0000,00\u00a0USD')).toBe('1\u00a0000,00 USD');
    expect(breakableUnit('7')).toBe('7');
    expect(breakableUnit('—')).toBe('—');
  });
});

describe('positionAmount (FIX-POSAMOUNT)', () => {
  it('the money a futures position took, without leverage: dollars for a dollar coin, else its settlement coin; a dash unknown', () => {
    expect(positionAmount({ symbol: 'BTC/USDT:USDT', margin: 4080.4 })).toBe(`4.080,40\u00a0USD`);
    expect(positionAmount({ symbol: 'BTC/USDT', margin: 25502.5 })).toBe(`25.502,50\u00a0USD`);
    expect(positionAmount({ symbol: 'BTC/USD:BTC', margin: 0.04 })).toBe('0,04 BTC');
    expect(positionAmount({ symbol: 'BTC/USDT:USDT', margin: null })).toBe('—');
    expect(positionAmount({ symbol: 'BTC/USDT:USDT' })).toBe('—');
  });
});
