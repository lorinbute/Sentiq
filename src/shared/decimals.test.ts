// FIX-DECIMALS: at most two decimals from 1 on, four under 1; under 0,0001 the first four digits; a forex / commodity
// rate four under 10.
import { describe, expect, it } from 'vitest';
import { maxDecimals, priceDecimals } from './decimals.ts';
import { autoDigits, fmtNum, fmtPct, fmtPlain, fmtPrice } from '../web/format.ts';
import { num, price } from '../server/bots/format.ts';
import { isFxRate } from './fx.ts';

describe('the decimals a number is shown with (FIX-DECIMALS)', () => {
  it('two from 1 on, four under 1, the first four digits under 0,0001', () => {
    expect([95_123.4, 2.1234, 1, 0.9999, 0.38123, 0.0001, 0.00001234, 0.000000045, 0, -2.5, -0.25].map(maxDecimals)).toEqual([2, 2, 2, 4, 4, 4, 8, 11, 2, 2, 4]);
  });

  it('a forex / commodity rate: four under 10, two from 10', () => {
    expect([priceDecimals(1.08453, true), priceDecimals(155.234, true), priceDecimals(0.006445, true), priceDecimals(1.08453)]).toEqual([4, 2, 4, 2]);
    expect(['EUR/USD', 'EURUSD', 'EURUSD/USD', 'XAU/USD', 'JPY/USD'].every(isFxRate)).toBe(true);
    expect(['BTC/USDT', 'AAPL', 'AAPL/USD', 'XRP/USDT:USDT', 'GOOGLE'].some(isFxRate)).toBe(false);
  });

  it('the site: amounts, prices, percents and the order forms never show more', () => {
    // A quantity of 6 or 8 decimals: two from 1 on, four under 1, the first four digits under 0,0001.
    expect([fmtNum(1234.567891, 8), fmtNum(0.01234567, 8), fmtNum(0.00001234567, 8), fmtNum(5, 8), fmtNum(0.5, 2, 2)]).toEqual(['1.234,57', '0,0123', '0,00001235', '5', '0,50']);
    expect([fmtPct(12.3456, 4), fmtPct(0.12345, 4)]).toEqual(['+12,35%', '+0,1235%']);
    expect([autoDigits(2.1234), autoDigits(0.38123), autoDigits(1.0845, true), autoDigits(0.00001234)]).toEqual([2, 4, 4, 8]);
    // A price keeps the decimals it is given (its source already counts them: the chart's, a rate's).
    expect(fmtPrice(1.0845, 4)).toBe('1,0845');
    expect([fmtPlain(0.01234567), fmtPlain(2.123456, 8, false), fmtPlain(1.084567, 8, true), fmtPlain(1234.5678, 2), fmtPlain(null)]).toEqual(['0.0123', '2.12', '1.0846', '1234.57', '—']);
  });

  it("the bots' words: the journal, the summary, the notifications", () => {
    expect([num(0.01234567, 8), num(1234.567, 8), price(84_425.31), price(2.1234), price(0.253812), price(1.08453, true)]).toEqual(['0,0123', '1.234,57', '84.425,31', '2,12', '0,2538', '1,0845']);
  });
});
