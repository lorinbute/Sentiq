// FD-NEWSKIND (18 Nov 2026, the user: „Dacă eu citesc o știre despre Nike, vreau să citesc despre Nike, nu despre tokenul
// lui Nike”; „știrea este despre Disney … și tu aduci simbolul DIS USDT”): which symbols of a news item are companies'.
// A news item keeps its symbols only (`news_coins`); the clients took every symbol they do not follow for a coin, so a
// company named in a story (DIS, Disney) opened a coin or a tokenized stock with the same ticker. The server says it now,
// from what it knows: the user's favourites, the major coins, the index members, the listed shares and the coin list.
import { CORE_COINS, type MemberIndex } from './coins.ts';

const CORE = new Set(CORE_COINS.map((c) => c.symbol));

export interface SymbolKinds {
  /** The user's favourites: symbol → kind (`crypto`, `stock`, `index`). */
  watch: ReadonlyMap<string, string>;
  /** The index members (S&P 500, Nasdaq-100, Dow Jones, …) and the US listed shares. */
  members: MemberIndex | null;
  /** A coin of the coin list the news are tagged with (and not a stock somebody follows). */
  isCoin: (symbol: string) => boolean;
}

/**
 * Whether a news item's symbol is a company's stock, in this order: the user's own favourite says what it is; a major coin
 * (BTC, ETH, SOL, …) is never a company; an index member is (DIS is Disney); a listed share the coin list does not know
 * came in only as „$XYZ” or „NYSE: XYZ”, so it is one; anything else is a coin. An index (`^SPX`) is neither.
 */
export function isStockSymbol(symbol: string, k: SymbolKinds): boolean {
  if (symbol.startsWith('^')) return false;
  const own = k.watch.get(symbol);
  if (own) return own === 'stock';
  if (CORE.has(symbol)) return false;
  if (k.members?.byTicker.has(symbol)) return true;
  return k.members?.listed.has(symbol) === true && !k.isCoin(symbol);
}

/** The stocks among a news item's symbols, in their order. */
export const stocksOf = (coins: readonly string[], k: SymbolKinds): string[] => coins.filter((c) => isStockSymbol(c, k));
