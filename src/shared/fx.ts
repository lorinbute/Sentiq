// FD-FXCOMMODITIES: forex pairs and commodities, from Twelve Data (the user's own key). Shared by the server
// (validation, data, news aliases) and the web (labels). A symbol is kept under its Twelve Data symbol ("EUR/USD",
// "XAU/USD", "HG1"): a "/" never appears in a coin or a share, so it never collides with one; its kind tells them apart.

import { isPaperExchange } from './providers.ts';

export const FX_KINDS = ['forex', 'commodity'] as const;
export type FxKind = (typeof FX_KINDS)[number];
export const isFxKind = (k: string): k is FxKind => (FX_KINDS as readonly string[]).includes(k);

/**
 * A Twelve Data forex or commodity symbol: "EUR/USD", "XAU/USD", "HG1", "URALS/USD". Upper case only: the few in mixed
 * case (the silver gram's "XAGg/EUR") are left out of the lists, so every symbol travels upper case as the others do.
 */
export const FX_SYMBOL_RE = /^[A-Z0-9]{1,10}(\/[A-Z]{3})?$/;

/** The currency a symbol is priced in: what follows "/", else USD (copper's "HG1"). */
export const fxQuote = (symbol: string): string => symbol.split('/')[1]?.toUpperCase() ?? 'USD';
/** What a symbol is of: the part before "/" ("XAU" of "XAU/USD"). */
export const fxBase = (symbol: string): string => symbol.split('/')[0] ?? symbol;

/** The commodities' names in Romanian, by their base (Twelve Data gives English). */
const COMMODITY_RO: Record<string, string> = {
  XAU: 'Aur',
  GAU: 'Aur (gram)',
  XAG: 'Argint',
  XAGG: 'Argint (gram)',
  XPT: 'Platină',
  XPD: 'Paladiu',
  HG1: 'Cupru',
  WTI: 'Petrol WTI',
  XBR: 'Petrol Brent',
  URALS: 'Petrol Urals',
};

/**
 * The currencies (ISO 4217, the offshore yuan CNH and the codes replaced since): a forex pair is two of them. A share shown with its currency
 * ("AAPL/USD", as the trades pages show one) or a coin ("BTC/USD") is therefore never taken for a pair.
 */
const FIAT = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY CNH COP CRC CUP CVE CZK ' +
    'DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW ' +
    'KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR ' +
    'PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU ' +
    'UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL ' +
    // Codes replaced since, which a data catalog may still list (a pair of them is still a pair, never a share).
    'BYR CUC CYP EEK GHC HRK LTL LVL MRO MTL ROL SIT SKK STD TRL VEB VEF XDR ZMK ZWD'
  ).split(' '),
);

/**
 * A symbol's kind from its form alone (a news tag, a chip, a ticket): a commodity by its base (gold, silver, oil…, and
 * copper's "HG1"), a forex pair when both sides are currencies ("EUR/USD"); anything else not one of them (null).
 */
export function fxKindOf(symbol: string): FxKind | null {
  const s = symbol.toUpperCase();
  if (s === 'HG1') return 'commodity';
  if (!FX_SYMBOL_RE.test(s) || !s.includes('/')) return null;
  if (COMMODITY_RO[fxBase(s)]) return 'commodity';
  const [b, q] = s.split('/');
  return b && q && b !== q && FIAT.has(b) && FIAT.has(q) ? 'forex' : null;
}

/** FD-FXCOMMODITIES: a pair or a commodity priced in USD (the only ones a bot trades: its sums are in USD). */
export const isUsdFx = (symbol: string): boolean => fxKindOf(symbol) !== null && fxQuote(symbol.toUpperCase()) === 'USD';

/**
 * FD-FXCOMMODITIES: a pair's or a commodity's form on an account (eToro's own, kept by Paper Trading too): without its
 * "/" (EUR/USD → EURUSD, XAU/USD → XAUUSD; HG1 stays). A share is never changed (it has no "/").
 */
export const fxCompact = (symbol: string): string => (fxKindOf(symbol) ? symbol.toUpperCase().replace('/', '') : symbol);

/**
 * FD-FXCOMMODITIES (the user's choice): on eToro only forex. eToro's commodities are CFDs on futures contracts ("Non
 * Expiry", copper and palladium "Expiring Future"), priced unlike Twelve Data's spot: a stop loss read on the chart
 * could fall elsewhere on eToro.
 */
export const ETORO_COMMODITY_TEXT =
  'Pe eToro, Sentiq tranzacționează doar forex: mărfurile eToro sunt CFD-uri pe contracte futures, cu alt preț decât cel spot al graficului (Twelve Data). Pentru mărfuri folosește un profil Paper Trading.';

/** FD-FXCOMMODITIES: what a pair or a commodity needs (its data). */
export const FX_KEY_TEXT = 'Forex și mărfurile cer cheia ta Twelve Data (Setări → Date pentru acțiuni).';

/** FD-FXCOMMODITIES: where a pair or a commodity can be traded from Sentiq (Alpaca and Trading 212 have no forex here). */
export const FX_ACCOUNT_TEXT = 'Forex și mărfurile se tranzacționează din Sentiq pe eToro (doar forex) sau pe un profil Paper Trading de acțiuni.';

/** FIX-ETOROFX: the currencies eToro has before the dollar (EURUSD, GBPUSD, AUDUSD, NZDUSD, seen on eToro). */
const USD_SECOND = new Set(['EUR', 'GBP', 'AUD', 'NZD']);

/**
 * FIX-ETOROFX (the user: „vreau perechile înapoi”): a pair of the charts in USD that eToro has only the other way round
 * (JPY/USD → USDJPY, CHF/USD → USDCHF, CAD/USD → USDCAD): its eToro symbol; null for every other symbol. Traded through
 * it: a long on JPY/USD is a short on USDJPY, its levels 1/x, its units (yen) as dollars at the rate.
 */
export function etoroInverseOf(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  if (fxKindOf(s) !== 'forex') return null;
  const [b, q] = s.split('/');
  return q === 'USD' && b && !USD_SECOND.has(b) ? `USD${b}` : null;
}

/**
 * FD-FXCOMMODITIES: an account that trades a pair (eToro, every one: those it has the other way round through it, FIX-
 * ETOROFX; a stocks Paper Trading profile) or a commodity (the profile).
 */
export const fxTradable = (a: { kind: string; exchange: string }, kind: FxKind, _symbol?: string): boolean =>
  a.kind === 'stocks' && (isPaperExchange(a.exchange) || (a.exchange === 'etoro' && kind === 'forex'));

/** The Twelve Data symbol of an account's compact one (EURUSD → EUR/USD, XAUUSD → XAU/USD, HG1); null: not one. */
export function fxFromCompact(compact: string): string | null {
  const s = compact.toUpperCase();
  if (s === 'HG1') return s;
  if (!/^[A-Z]{6,8}$/.test(s)) return null;
  const q = s.slice(-3);
  const b = s.slice(0, -3);
  const td = `${b}/${q}`;
  return fxKindOf(td) ? td : null;
}

/** A Twelve Data symbol of either form (the chart's "EUR/USD" or an account's "EURUSD"); null: neither. */
export const fxSymbolOf = (symbol: string): string | null => (fxKindOf(symbol) ? symbol.toUpperCase() : fxFromCompact(symbol));

/**
 * FIX-DECIMALS: a forex pair or a commodity in any of its forms (the chart's EUR/USD, an account's EURUSD, a broker row's
 * EURUSD/USD): its rate keeps four decimals under 10.
 */
export const isFxRate = (symbol: string): boolean => fxSymbolOf(symbol) !== null || fxFromCompact(symbol.split('/')[0] ?? '') !== null;

/** A commodity's name in Romanian ("Aur"), else Twelve Data's own. */
export const commodityName = (symbol: string, given?: string | null): string => COMMODITY_RO[fxBase(symbol).toUpperCase()] ?? given ?? symbol;

/** The words the news use for a commodity (FD-INDICES' way: proper nouns, matched as company names are). */
const COMMODITY_ALIASES: Record<string, string[]> = {
  XAU: ['gold', 'aur'],
  GAU: ['gold', 'aur'],
  XAG: ['silver', 'argint'],
  XAGG: ['silver', 'argint'],
  XPT: ['platinum', 'platină'],
  XPD: ['palladium', 'paladiu'],
  HG1: ['copper', 'cupru'],
  WTI: ['WTI', 'crude oil', 'petrol'],
  XBR: ['Brent'],
  URALS: ['Urals'],
};

/** The default aliases of a forex pair or a commodity, for the news (editable as a share's). */
export function fxAliases(kind: FxKind, symbol: string): string[] {
  if (kind === 'commodity') return COMMODITY_ALIASES[fxBase(symbol).toUpperCase()] ?? [symbol];
  const [b, q] = symbol.toUpperCase().split('/');
  return b && q ? [`${b}/${q}`, `${b}${q}`] : [symbol.toUpperCase()];
}

const NY = 'America/New_York';

/** The weekday (0 = Sunday) and the minutes of the day in New York. */
function nyClock(ms: number): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/**
 * The forex and commodities week (24/5): open from Sunday 17:00 to Friday 17:00, New York time (the market's own
 * convention); closed over the weekend. The commodities' short daily break (17:00–18:00) is not counted.
 */
export function fxOpen(ms: number): boolean {
  const { day, minutes } = nyClock(ms);
  if (day === 6) return false;
  if (day === 5) return minutes < 17 * 60;
  if (day === 0) return minutes >= 17 * 60;
  return true;
}
