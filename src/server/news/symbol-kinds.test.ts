// FD-NEWSKIND: which symbols of a news item are companies' (a story about Disney names DIS the company, not a coin).
import { describe, expect, it } from 'vitest';
import { isStockSymbol, stocksOf, type SymbolKinds } from './symbol-kinds.ts';

const kinds = (watch: Record<string, string> = {}): SymbolKinds => ({
  watch: new Map(Object.entries(watch)),
  members: {
    byTicker: new Map([
      ['DIS', { aliases: ['Disney'], indices: ['SPX', 'DJI'] }],
      ['NKE', { aliases: ['Nike'], indices: ['SPX'] }],
      ['COIN', { aliases: ['Coinbase'], indices: ['SPX'] }],
    ]),
    // BTC (Grayscale's trust), ETH (Ethan Allen), SOL (ReneSola) and LINK (Interlink) are listed shares too.
    listed: new Set(['BTC', 'ETH', 'SOL', 'LINK', 'XYZW']),
  },
  // The coin list: DIS (a coin with that ticker), LINK; not XYZW.
  isCoin: (s) => ['DIS', 'LINK', 'BTC', 'ETH', 'SOL', 'COIN'].includes(s),
});

describe('the symbols of a news item: companies or coins (FD-NEWSKIND)', () => {
  it('an index member is the company, even with a coin of the same ticker (DIS is Disney)', () => {
    expect(isStockSymbol('DIS', kinds())).toBe(true);
    expect(isStockSymbol('NKE', kinds())).toBe(true);
    expect(isStockSymbol('COIN', kinds())).toBe(true);
  });

  it('a major coin is never a company, even listed (BTC, ETH, SOL)', () => {
    expect(stocksOf(['BTC', 'ETH', 'SOL'], kinds())).toEqual([]);
  });

  it('a listed share the coin list does not know is a company; one it knows is the coin (LINK)', () => {
    expect(isStockSymbol('XYZW', kinds())).toBe(true);
    expect(isStockSymbol('LINK', kinds())).toBe(false);
    expect(isStockSymbol('NOPE', kinds())).toBe(false);
  });

  it("the user's own favourite says what it is; an index is neither", () => {
    expect(isStockSymbol('DIS', kinds({ DIS: 'crypto' }))).toBe(false);
    expect(isStockSymbol('LINK', kinds({ LINK: 'stock' }))).toBe(true);
    expect(isStockSymbol('^SPX', kinds({ '^SPX': 'index' }))).toBe(false);
  });

  it('without the member lists (a test, the lists not read yet): only the favourites', () => {
    const none: SymbolKinds = { watch: new Map([['AAPL', 'stock']]), members: null, isCoin: () => false };
    expect(stocksOf(['AAPL', 'DIS', 'BTC'], none)).toEqual(['AAPL']);
  });
});
