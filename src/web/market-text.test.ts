// FD-MARKETMOVE: the market's reaction in words on the Today card.
import { describe, expect, it } from 'vitest';
import type { MarketPart } from '../shared/api-types.ts';
import { zonedTimeToUtc } from '../shared/time.ts';
import { marketLine, marketShown, sharePct, signedPct } from './market-text.ts';

const TZ = 'Europe/Bucharest';
const part = (o: Partial<MarketPart> = {}): MarketPart => ({
  area: 'stocks',
  day: '2026-11-20',
  live: true,
  closedAt: null,
  indices: [
    { id: '^SPX', name: 'S&P 500', changePct: -1.999, typicalPct: 0.51, z: -3.92 },
    { id: '^NDX', name: 'Nasdaq 100', changePct: -3.738, typicalPct: 0.837, z: -4.46 },
  ],
  move: -4.19,
  sentiment: -0.78,
  value: 7.59,
  strength: 0.74,
  decay: 1,
  share: 0.74,
  news: 40.3,
  weight: 120,
  dayShare: 0.68,
  ...o,
});

describe('the market reaction in words (FD-MARKETMOVE)', () => {
  it('during the session', () => {
    expect(marketLine(part(), TZ, zonedTimeToUtc('2026-11-20', TZ, 19))).toBe(
      'Piața acum: S&P 500 −2,00%, Nasdaq 100 −3,74%, de 3,9 și 4,5 ori mișcarea unei zile obișnuite. Reacția pieței (7.6) are 74% din scorul Acțiunilor; din știri singure ar fi 40.3.',
    );
  });

  it('after the close: today, or the day of the last session; its share falling', () => {
    const closedAt = zonedTimeToUtc('2026-11-19', 'America/New_York', 16);
    const m = part({ live: false, closedAt, decay: 0.17, share: 0.12, day: '2026-11-19' });
    expect(marketLine(m, TZ, zonedTimeToUtc('2026-11-19', TZ, 23, 30))).toMatch(/^La închiderea de azi: /);
    expect(marketLine(m, TZ, zonedTimeToUtc('2026-11-20', TZ, 9))).toMatch(/^La închiderea de joi, 19 noiembrie: .* mai are 12% din scorul Acțiunilor \(scade cu orele de la închidere\); /);
  });

  it('crypto: the last 24 hours, the Crypto part', () => {
    const c = part({
      area: 'crypto',
      indices: [
        { id: 'BTC', name: 'BTC', changePct: -6.25, typicalPct: 0.91, z: -6.87 },
        { id: 'ETH', name: 'ETH', changePct: -8.2, typicalPct: 0.86, z: -9.53 },
      ],
      value: 4.3,
      share: 0.85,
      news: 26.1,
    });
    expect(marketLine(c, TZ, zonedTimeToUtc('2026-11-20', TZ, 19))).toBe(
      'Crypto în ultimele 24 de ore: BTC −6,25%, ETH −8,20%, de 6,9 și 9,5 ori mișcarea unei zile obișnuite. Reacția pieței (4.3) are 85% din scorul Crypto; din știri singure ar fi 26.1.',
    );
  });

  it('signs and shares; a reaction under 1% is not shown', () => {
    expect([signedPct(1.31), signedPct(-0.004), signedPct(0)]).toEqual(['+1,31%', '0,00%', '0,00%']);
    expect([sharePct(0.004), sharePct(0.735)]).toEqual(['sub 1%', '74%']);
    expect([marketShown(null), marketShown(part({ share: 0.004 })), marketShown(part())]).toEqual([false, false, true]);
  });
});
