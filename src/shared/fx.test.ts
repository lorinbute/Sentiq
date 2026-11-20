import { describe, expect, it } from 'vitest';
import { commodityName, FX_SYMBOL_RE, fxAliases, fxBase, fxCompact, fxFromCompact, fxKindOf, fxOpen, fxQuote, fxSymbolOf, fxTradable, etoroInverseOf, isFxKind, isUsdFx } from './fx.ts';

describe('FD-FXCOMMODITIES: forex and commodities', () => {
  it('reads a Twelve Data symbol: its base, its quote (USD without one), its Romanian name', () => {
    expect(fxQuote('EUR/USD')).toBe('USD');
    expect(fxQuote('XAU/EUR')).toBe('EUR');
    expect(fxQuote('HG1')).toBe('USD');
    expect(fxBase('XAG/EUR')).toBe('XAG');
    expect(commodityName('XAU/USD')).toBe('Aur');
    expect(commodityName('GAU/USD')).toBe('Aur (gram)');
    expect(commodityName('NEW/USD', 'Something')).toBe('Something');
    expect(isFxKind('forex')).toBe(true);
    expect(fxKindOf('EUR/USD')).toBe('forex');
    expect(fxKindOf('XAU/USD')).toBe('commodity');
    expect(fxKindOf('HG1')).toBe('commodity');
    expect(fxKindOf('BTC')).toBeNull();
    expect(fxKindOf('AAPL')).toBeNull();
    // A share shown with its currency, a coin, a made-up pair: never forex (both sides must be currencies).
    expect(fxKindOf('AAPL/USD')).toBeNull();
    expect(fxKindOf('BTC/USD')).toBeNull();
    expect(fxKindOf('USD/USD')).toBeNull();
    expect(fxKindOf('USD/JPY')).toBe('forex');
    expect(isFxKind('stock')).toBe(false);
  });

  it('the USD ones (a bot trades only them); the compact form of an account and back', () => {
    expect(isUsdFx('EUR/USD')).toBe(true);
    expect(isUsdFx('XAU/USD')).toBe(true);
    expect(isUsdFx('HG1')).toBe(true);
    expect(isUsdFx('USD/JPY')).toBe(false);
    expect(isUsdFx('EUR/GBP')).toBe(false);
    expect(isUsdFx('AAPL')).toBe(false);
    expect(fxCompact('EUR/USD')).toBe('EURUSD');
    expect(fxCompact('XAU/USD')).toBe('XAUUSD');
    expect(fxCompact('HG1')).toBe('HG1');
    expect(fxCompact('AAPL')).toBe('AAPL');
    expect(fxFromCompact('EURUSD')).toBe('EUR/USD');
    expect(fxFromCompact('XAUUSD')).toBe('XAU/USD');
    expect(fxFromCompact('URALSUSD')).toBe('URALS/USD');
    expect(fxFromCompact('HG1')).toBe('HG1');
    expect(fxFromCompact('AAPL')).toBeNull();
    expect(fxFromCompact('GOOGL')).toBeNull();
    expect(fxFromCompact('ABCDEF')).toBeNull();
    expect(fxSymbolOf('EUR/USD')).toBe('EUR/USD');
    expect(fxSymbolOf('EURUSD')).toBe('EUR/USD');
    expect(fxSymbolOf('MSFT')).toBeNull();
    // FIX-ETOROFX: eToro has EUR/USD as it is, the yen the other way round (USD/JPY), traded through it.
    const etoro = { kind: 'stocks', exchange: 'etoro' };
    const paper = { kind: 'stocks', exchange: 'paper' };
    expect(fxTradable(etoro, 'forex', 'EUR/USD')).toBe(true);
    expect(fxTradable(etoro, 'forex', 'JPY/USD')).toBe(true);
    expect(etoroInverseOf('JPY/USD')).toBe('USDJPY');
    expect(etoroInverseOf('CAD/USD')).toBe('USDCAD');
    expect(etoroInverseOf('EUR/USD')).toBeNull();
    expect(etoroInverseOf('USD/JPY')).toBeNull();
    expect(etoroInverseOf('XAU/USD')).toBeNull();
    expect(fxTradable(etoro, 'commodity', 'XAU/USD')).toBe(false);
    expect(fxTradable(paper, 'forex', 'JPY/USD')).toBe(true);
    expect(fxTradable({ kind: 'stocks', exchange: 'alpaca' }, 'forex', 'EUR/USD')).toBe(false);
  });

  it('takes Twelve Data symbols only, upper case (no spaces, one "/" before a three-letter currency)', () => {
    for (const s of ['EUR/USD', 'XAU/USD', 'HG1', 'URALS/USD']) expect(FX_SYMBOL_RE.test(s)).toBe(true);
    for (const s of ['EUR/US', 'EUR USD', 'EUR/USD/X', '', 'A'.repeat(11), 'XAGg/EUR', 'eur/usd']) expect(FX_SYMBOL_RE.test(s)).toBe(false);
  });

  it('gives the news aliases: a pair written both ways, a commodity by its words', () => {
    expect(fxAliases('forex', 'eur/usd')).toEqual(['EUR/USD', 'EURUSD']);
    expect(fxAliases('commodity', 'XAU/USD')).toEqual(['gold', 'aur']);
    expect(fxAliases('commodity', 'XBR/USD')).toEqual(['Brent']);
    expect(fxAliases('commodity', 'NEW/USD')).toEqual(['NEW/USD']);
  });

  it('is open 24/5: from Sunday 17:00 to Friday 17:00 in New York', () => {
    // 2026-11-20 is a Friday; New York is UTC−5 in November.
    expect(fxOpen(Date.parse('2026-11-20T21:59:00Z'))).toBe(true); // Fri 16:59
    expect(fxOpen(Date.parse('2026-11-20T22:00:00Z'))).toBe(false); // Fri 17:00
    expect(fxOpen(Date.parse('2026-11-21T15:00:00Z'))).toBe(false); // Sat
    expect(fxOpen(Date.parse('2026-11-22T21:59:00Z'))).toBe(false); // Sun 16:59
    expect(fxOpen(Date.parse('2026-11-22T22:00:00Z'))).toBe(true); // Sun 17:00
    expect(fxOpen(Date.parse('2026-11-18T03:00:00Z'))).toBe(true); // Tue night
    // Summer time (UTC−4): Friday 17:00 is 21:00 UTC.
    expect(fxOpen(Date.parse('2026-07-17T20:59:00Z'))).toBe(true);
    expect(fxOpen(Date.parse('2026-07-17T21:00:00Z'))).toBe(false);
  });
});
