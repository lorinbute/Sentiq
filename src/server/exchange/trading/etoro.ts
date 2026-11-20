// eToro orders (FD-TRADING; api-portal.etoro.com, Trading - Real / Demo): opening a position (market, market-if-touched,
// immediate limit; by USD amount or units; buy or short; leverage, SL / TP), closing positions (all or some units),
// cancelling a pending order. A 200 means "accepted for processing": the outcome is read back from the order lookup.
import { randomUUID } from 'node:crypto';
import { ETORO_LEVERAGE_TEXT, etoroProtectionOf, isEtoroLeverage, type ClosablePosition, type HeldPosition, type InstrumentInfo, type ModifyPreview, type ModifyResult, type ModifyStepPlan, type ModifyTicket, type OrderPreview, type OrderResult, type OrderTicket, type TradeMarket, type TradeSymbol } from '../../../shared/trading.ts';
import { ETORO_COMMODITY_TEXT, etoroInverseOf, fxCompact, fxFromCompact, fxKindOf } from '../../../shared/fx.ts';
import { brokerCall } from './http.ts';
import { httpRequest } from '../../net/http.ts';
import { commonChecks, fmtPlain, modifyStatus, protectionChecks, TradingError, type CancelInput, type ModifyPlan, type Trader } from './types.ts';

const BASE = 'https://public-api.etoro.com';
const FORBIDDEN = 'cheia nu are permisiunea „Write” pentru acest mediu (fă o cheie nouă cu ea) sau IP-ul nu e permis';
const LOOKUP_TRIES = 5;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : []);

/** The form's key with its last digits replaced by `i`: one valid request id per closed position. */
export function nthRequestId(idemKey: string, i: number): string {
  if (i === 0) return idemKey;
  const hex = i.toString(16).padStart(4, '0');
  return `${idemKey.slice(0, -4)}${hex}`;
}

/**
 * What closing `units` of several positions sends (FD-ETOROUNITS): whole positions in the order given, then part of the
 * next one. Without `units`, every position whole. A position no longer held is left out (its units are not there).
 */
export function closePlan(held: readonly { id: string; units: number }[], ids: readonly string[], units: number | undefined): { id: string; units: number | null }[] {
  if (units === undefined) return ids.map((id) => ({ id, units: null }));
  const byId = new Map(held.map((p) => [p.id, p.units]));
  const out: { id: string; units: number | null }[] = [];
  let left = units;
  for (const id of ids) {
    const has = byId.get(id);
    if (has === undefined || left <= 1e-9) continue;
    if (left >= has - 1e-9) {
      out.push({ id, units: null });
      left -= has;
    } else {
      out.push({ id, units: Number(left.toFixed(8)) });
      left = 0;
    }
  }
  return out;
}

interface Held {
  instrumentId: number;
  units: number;
  positions: ClosablePosition[];
  rate: number | null;
}

/**
 * FD-FXCOMMODITIES: eToro's symbol of Sentiq's: a forex pair without its "/" (EUR/USD → EURUSD, eToro's own: EURUSD,
 * GBPUSD, AUDUSD, NZDUSD seen on eToro on 19 Nov 2026), a share as it is (AAPL/USD → AAPL). A commodity of the charts
 * (XAU/USD, HG1) is refused (the user: only forex on eToro); one of eToro's own ("GOLD") is a symbol as any other.
 */
export function etoroSymbolOf(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const td = fxKindOf(s) ? s : fxFromCompact(s);
  const kind = td ? fxKindOf(td) : null;
  if (kind === 'commodity') throw new TradingError('INVALID', ETORO_COMMODITY_TEXT);
  if (kind === 'forex' && td) return etoroInverseOf(td) ?? fxCompact(td);
  return s.replace(/\/.*$/, '');
}

/** 1/x with the digits a rate has (eToro takes a rate, not a long fraction). */
const flip = (x: number | undefined): number | undefined => (x === undefined || !(x > 0) ? x : Number((1 / x).toPrecision(6)));

/** An eToro position on USDJPY as one on JPY/USD: the other side, its units in yen (at its own rate), its rate 1/x. */
function inverted(p: ClosablePosition, rate: number | null): ClosablePosition {
  const r = p.openRate ?? rate;
  return { ...p, isBuy: !p.isBuy, units: r ? Number((p.units * r).toFixed(4)) : p.units, openRate: p.openRate ? 1 / p.openRate : null };
}

/**
 * FIX-ETOROSTALE: a bot takes eToro's rate only this fresh, by the rate's own time. eToro's public API was seen giving
 * rates 3 h 26 min old (19 Nov 2026: EUR/USD at 23:11 UTC was Twelve Data's of 19:46); an older one is not used.
 */
export const ETORO_RATE_MAX_AGE_MS = 60_000;

/** FIX-BOT24: eToro's instrument ids by symbol (they never change). */
const instrumentIds = new Map<string, number>();
/**
 * FIX-ETOROLIMIT (the user: „eToro limitează cererile acum” on EUR/USD): an instrument found once is kept (its id never
 * changes), so a bot's check, an order and a look no longer search eToro for it each time.
 */
const resolved = new Map<string, { instrumentId: number; symbol: string; name: string; marketData: boolean }>();
/**
 * FIX-ETOROLIMIT: eToro's rates were seen hours late (FIX-ETOROSTALE): once one is, they are not asked for again for 10
 * minutes (each would be dropped, and each costs a request of eToro's limit).
 */
const RATES_STALE_PAUSE_MS = 10 * 60_000;
let ratesStaleUntil = 0;
/** Tests: forget what was kept. */
export function resetEtoroCaches(): void {
  instrumentIds.clear();
  resolved.clear();
  ratesStaleUntil = 0;
  listed = null;
}

/**
 * FIX-ETOROSEARCH (the user: „nu pot adăuga ANT în bot … eroarea că ANT nu există … e fals”): eToro's search filters a
 * symbol partly too (43 of its symbols contain „ANT”: ANT.24-7, ANT.RTH, ANTO.L…), a page at a time: the exact one is
 * looked for on its first pages, 100 a page.
 */
export const ETORO_SEARCH_PAGE = 100;
export const ETORO_SEARCH_PAGES = 5;
/** eToro's own list of its instruments (its site's, public), read only when the search does not find a symbol. */
export const ETORO_LISTED_URL = 'https://api.etorostatic.com/sapi/instrumentsmetadata/V1.1/instruments';
const LISTED_TTL = 6 * 3_600_000;
let listed: { at: number; bySymbol: Map<string, { instrumentId: number; name: string; type: number; exchange: number }>; byId: Map<number, { symbol: string; name: string; type: number }> } | null = null;

/**
 * FIX-ETOROSEARCH: a symbol in eToro's own list (exact, upper case): its id, name, and whether the market data prices
 * the same thing (a forex pair, type 1; a share or an ETF, types 5 / 6, of Nasdaq or NYSE, exchanges 4 / 5); null when
 * not there. The list (16 MB) is read at most every 6 hours, only after a search that did not find a symbol.
 */
async function listedNow(now: number): Promise<NonNullable<typeof listed>> {
  if (!listed || now - listed.at > LISTED_TTL) {
    const r = await httpRequest(ETORO_LISTED_URL, { headers: { Accept: 'application/json' }, timeoutMs: 30_000, maxBytes: 64 * 1024 * 1024 });
    if (r.status !== 200) throw new TradingError('INVALID', `Lista instrumentelor eToro nu s-a putut citi (HTTP ${r.status}).`);
    const rows = arr(obj(JSON.parse(r.body)).InstrumentDisplayDatas);
    const bySymbol = new Map<string, { instrumentId: number; name: string; type: number; exchange: number }>();
    const byId = new Map<number, { symbol: string; name: string; type: number }>();
    for (const row of rows) {
      const sym = str(row.SymbolFull)?.toUpperCase();
      const id = num(row.InstrumentID);
      if (!sym || id === null) continue;
      const name = str(row.InstrumentDisplayName) ?? sym;
      if (!bySymbol.has(sym)) bySymbol.set(sym, { instrumentId: id, name, type: num(row.InstrumentTypeID) ?? 0, exchange: num(row.ExchangeID) ?? 0 });
      if (!byId.has(id)) byId.set(id, { symbol: sym, name, type: num(row.InstrumentTypeID) ?? 0 });
    }
    listed = { at: now, bySymbol, byId };
  }
  return listed;
}

/**
 * FIX-ETOROMETA: an instrument by its id in eToro's own list (its symbol, name and type): for the portfolio's
 * instruments eToro's market data does not know yet (new listings: SPCX, ANT), else shown by number („#15618”).
 */
export async function etoroListedById(id: number, now = Date.now()): Promise<{ symbol: string; name: string; type: number } | null> {
  return (await listedNow(now)).byId.get(id) ?? null;
}

export async function etoroListed(symbol: string, now = Date.now()): Promise<{ instrumentId: number; name: string; marketData: boolean } | null> {
  const hit = (await listedNow(now)).bySymbol.get(symbol.toUpperCase());
  if (!hit) return null;
  return { instrumentId: hit.instrumentId, name: hit.name, marketData: hit.type === 1 || ((hit.type === 5 || hit.type === 6) && (hit.exchange === 4 || hit.exchange === 5)) };
}

export class EtoroTrader implements Trader {
  private readonly headers: Record<string, string>;
  private readonly demo: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fallback: (symbol: string) => Promise<number | null>;

  /**
   * `fallback`: FIX-ETOROSTALE, the price of a symbol from the market data (Nasdaq for a share, Twelve Data for a pair),
   * when eToro's rate is not fresh.
   */
  constructor(
    creds: Record<string, string>,
    env: string,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    fallback: (symbol: string) => Promise<number | null> = async () => null,
  ) {
    this.headers = { 'x-api-key': creds.publicKey ?? '', 'x-user-key': creds.userKey ?? '' };
    this.demo = env === 'demo';
    this.sleep = sleep;
    this.fallback = fallback;
  }

  private call(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, requestId: string, body?: unknown): Promise<unknown> {
    return brokerCall('eToro', `${BASE}${path}`, { method, headers: { ...this.headers, 'x-request-id': requestId }, body, write: method !== 'GET', forbidden: FORBIDDEN });
  }

  private seg(): string {
    return this.demo ? 'demo/' : '';
  }

  async symbols(_market: TradeMarket): Promise<TradeSymbol[]> {
    return [];
  }

  /**
   * The instrument id of a symbol (exact match on eToro's full symbol). `marketData`: FIX-ETOROSTALE, the market data
   * prices the same instrument (a share of Nasdaq / NYSE, a forex pair); eToro's other symbols may be another thing there
   * (eToro's gold "GOLD" is Barrick at Nasdaq).
   */
  private async resolve(symbol: string): Promise<{ instrumentId: number; symbol: string; name: string; marketData: boolean }> {
    const want = etoroSymbolOf(symbol);
    if (/^#\d+$/.test(want)) return { instrumentId: Number(want.slice(1)), symbol: want, name: want, marketData: false };
    const kept = resolved.get(want);
    if (kept) return kept;
    // FIX-ETOROSEARCH: the exact symbol among the partial matches, on the first pages.
    let hit: Record<string, unknown> | undefined;
    for (let page = 1; page <= ETORO_SEARCH_PAGES && !hit; page++) {
      const r = obj(await this.call('GET', `/api/v1/market-data/search?internalSymbolFull=${encodeURIComponent(want)}&pageSize=${ETORO_SEARCH_PAGE}&pageNumber=${page}`, randomUUID()));
      const items = arr(r.items);
      hit = items.find((i) => (str(i.internalSymbolFull) ?? '').toUpperCase() === want);
      const total = num(r.totalItems);
      if (items.length < ETORO_SEARCH_PAGE || (total !== null && page * ETORO_SEARCH_PAGE >= total)) break;
    }
    const id = hit ? num(hit.instrumentId ?? hit.instrumentID ?? hit.InstrumentID) : null;
    if (!hit || id === null) {
      // Not found by the search (a listing too new for it, or past its pages): eToro's own list of its instruments.
      const own = await etoroListed(want).catch(() => null);
      if (!own) throw new TradingError('INVALID', `eToro nu are simbolul ${want}.`);
      const out = { instrumentId: own.instrumentId, symbol: want, name: own.name, marketData: own.marketData };
      resolved.set(want, out);
      return out;
    }
    const cls = str(hit.internalAssetClassName) ?? '';
    const exchange = str(hit.internalExchangeName) ?? '';
    const marketData = cls === 'Forex' || (/^(stocks|etf)$/i.test(cls) && /^(nasdaq|nyse)/i.test(exchange));
    const out = { instrumentId: id, symbol: want, name: str(hit.displayname ?? hit.instrumentDisplayName ?? hit.displayName) ?? want, marketData };
    resolved.set(want, out);
    while (resolved.size > 2000) resolved.delete(resolved.keys().next().value as string);
    return out;
  }

  /** FIX-ETOROLIMIT: whether eToro has a symbol (a bot's check), from the instrument kept or one search. */
  async known(symbol: string): Promise<void> {
    await this.resolve(symbol);
  }

  /**
   * FIX-BOT24: an instrument's price now (its id found once, then kept): a bot's price at any hour, on any exchange.
   * FIX-ETOROSTALE: null when eToro's rate is older than ETORO_RATE_MAX_AGE_MS or has no time (the bot takes another).
   */
  async price(symbol: string, now = Date.now()): Promise<number | null> {
    const want = etoroSymbolOf(symbol);
    let id = instrumentIds.get(want);
    if (id === undefined) {
      id = (await this.resolve(want)).instrumentId;
      instrumentIds.set(want, id);
      while (instrumentIds.size > 2000) instrumentIds.delete(instrumentIds.keys().next().value as string);
    }
    if (now < ratesStaleUntil) return null;
    const r = await this.rateAt(id);
    if (r.price !== null && r.at !== null && now - r.at > ETORO_RATE_MAX_AGE_MS) ratesStaleUntil = now + RATES_STALE_PAUSE_MS;
    if (r.price === null || r.at === null || now - r.at > ETORO_RATE_MAX_AGE_MS) return null;
    // FIX-ETOROFX: JPY/USD's price through USDJPY's.
    return etoroInverseOf(symbol) && r.price > 0 ? 1 / r.price : r.price;
  }

  /**
   * FIX-ETOROSTALE (the user's choice): the price the order form shows and checks with: eToro's rate when it is at most
   * ETORO_RATE_MAX_AGE_MS old, else the market data's (Nasdaq for a share, Twelve Data for a pair), else none.
   */
  private async lastOf(ins: { instrumentId: number; symbol: string; marketData: boolean }): Promise<number | null> {
    const now = Date.now();
    if (now >= ratesStaleUntil) {
      const r = await this.rateAt(ins.instrumentId);
      if (r.price !== null && r.at !== null && now - r.at <= ETORO_RATE_MAX_AGE_MS) return r.price;
      if (r.price !== null && r.at !== null) ratesStaleUntil = now + RATES_STALE_PAUSE_MS;
    }
    return ins.marketData ? this.fallback(ins.symbol).catch(() => null) : null;
  }

  /** An instrument's rate and its time (ms; null without one). */
  private async rateAt(instrumentId: number): Promise<{ price: number | null; at: number | null }> {
    try {
      const r = obj(await this.call('GET', `/api/v1/market-data/instruments/rates?instrumentIds=${instrumentId}`, randomUUID()));
      const row = arr(r.rates)[0] ?? arr(r.items)[0] ?? {};
      const at = Date.parse(str(row.date) ?? '');
      return { price: num(row.lastExecution ?? row.ask ?? row.bid ?? row.rate), at: Number.isFinite(at) ? at : null };
    } catch {
      return { price: null, at: null };
    }
  }

  /** Free cash and the open positions on an instrument. */
  private async portfolio(instrumentId: number): Promise<{ cash: number | null; held: Held }> {
    const root = obj(await this.call('GET', `/api/v1/trading/info/${this.demo ? 'demo' : 'real'}/pnl`, randomUUID()));
    const pf = Object.keys(obj(root.clientPortfolio)).length ? obj(root.clientPortfolio) : root;
    const held: Held = { instrumentId, units: 0, positions: [], rate: null };
    for (const p of arr(pf.positions)) {
      if (num(p.instrumentID ?? p.instrumentId) !== instrumentId) continue;
      const units = num(p.units) ?? 0;
      const id = str(p.positionID ?? p.positionId);
      if (!id) continue;
      const opened = Date.parse(str(p.openDateTime) ?? '');
      held.positions.push({
        id,
        units,
        isBuy: p.isBuy !== false,
        leverage: num(p.leverage) ?? 1,
        openRate: num(p.openRate),
        openedAt: Number.isFinite(opened) ? opened : null,
        pnl: num(obj(p.unrealizedPnL).pnL ?? obj(p.unrealizedPnL).pnl) ?? num(p.netProfit),
        invested: num(p.amount),
      });
      held.units += units;
      held.rate = num(obj(p.unrealizedPnL).closeRate) ?? num(p.currentRate) ?? held.rate;
    }
    return { cash: num(pf.credit), held };
  }

  async instrument(_market: TradeMarket, symbol: string): Promise<InstrumentInfo> {
    const ins = await this.resolve(symbol);
    const [{ cash, held: raw }, rawRate] = await Promise.all([this.portfolio(ins.instrumentId), this.lastOf(ins)]);
    // FIX-ETOROFX: JPY/USD through USDJPY: its positions and its rate seen as JPY/USD's (the bot's own terms).
    const inverse = etoroInverseOf(symbol) !== null;
    const held = inverse ? { ...raw, positions: raw.positions.map((p) => inverted(p, rawRate)) } : raw;
    const rate = inverse && rawRate ? 1 / rawRate : rawRate;
    const longs = held.positions.filter((p) => p.isBuy);
    const shorts = held.positions.filter((p) => !p.isBuy);
    // One side: the position, as before. Both (FD-HEDGEALL: eToro keeps every position apart, a short beside the
    // buys): each side summed, as hedge mode on the exchanges.
    const sideOf = (side: 'long' | 'short', list: Held['positions']): HeldPosition | null =>
      list.length ? { side, amount: list.reduce((s, p) => s + p.units, 0), entryPrice: list[0]?.openRate ?? null } : null;
    const both = longs.length > 0 && shorts.length > 0;
    return {
      market: 'stock',
      symbol: ins.symbol,
      ref: String(ins.instrumentId),
      name: ins.name,
      currency: 'USD',
      base: ins.symbol,
      last: rate,
      amountStep: null,
      minAmount: null,
      minCost: null,
      priceStep: null,
      contractSize: null,
      maxLeverage: null,
      availableQuote: cash,
      availableBase: longs.reduce((s, p) => s + p.units, 0),
      position: both ? null : (sideOf('long', longs) ?? sideOf('short', shorts)),
      ...(both ? { positionMode: 'hedge' as const, hedgePositions: { long: sideOf('long', longs), short: sideOf('short', shorts) } } : {}),
      // FD-ETOROPICK: each position, so the form can close the ones picked.
      positions: held.positions,
    };
  }

  async normalize(t: OrderTicket): Promise<OrderPreview> {
    const via = etoroInverseOf(t.symbol);
    if (via) return this.normalizeInverse(t, via);
    const ins = await this.resolve(t.symbol);
    const [{ cash, held }, last] = await Promise.all([this.portfolio(ins.instrumentId), this.lastOf(ins)]);
    const warnings: string[] = [];
    const errors: string[] = [];
    if (t.market !== 'stock') errors.push('Pe eToro, instrumentele se tranzacționează ca acțiuni (simbolul eToro).');
    let amount = t.amount;
    let value: number | null = null;
    if (t.close) {
      // Closing: the positions must be this instrument's, the units within them.
      const ids = new Set(held.positions.map((p) => p.id));
      const missing = t.close.positionIds.filter((id) => !ids.has(id));
      if (missing.length) errors.push(`Poziția ${missing.join(', ')} nu mai e deschisă.`);
      const units = held.positions.filter((p) => t.close?.positionIds.includes(p.id)).reduce((s, p) => s + p.units, 0);
      const many = t.close.positionIds.length > 1;
      if (t.close.units !== undefined && t.close.units > units + 1e-9) errors.push(`${many ? 'Pozițiile au' : 'Poziția are'} ${fmtPlain(units)} unități; închizi ${fmtPlain(t.close.units)}.`);
      // Units of several positions: whole ones first, then part of the next (said, so the confirmation shows it).
      if (t.close.units !== undefined && many && !errors.length) {
        const plan = closePlan(held.positions, t.close.positionIds, t.close.units);
        const whole = plan.filter((x) => x.units === null).length;
        const part = plan.find((x) => x.units !== null);
        warnings.push(
          [whole ? `Se închid complet ${whole} ${whole === 1 ? 'poziție' : 'poziții'}` : '', part ? `${whole ? 'și' : 'Se închide'} parțial poziția ${part.id} (${fmtPlain(part.units as number)} ${part.units === 1 ? 'unitate' : 'unități'})` : '']
            .filter(Boolean)
            .join(' ') + '.',
        );
      }
      amount = t.close.units ?? units;
      value = last !== null ? amount * last : null;
      warnings.push('Închiderea se face la prețul pieței.');
    } else {
      if (!['market', 'mit', 'limit_ioc'].includes(t.kind)) errors.push('eToro deschide poziții la piață, la un preț țintă (market-if-touched) sau cu o limită imediată.');
      const lev = t.leverage ?? 1;
      // FIX-ETOROLEV3: another leverage is refused by eToro.
      if (!isEtoroLeverage(lev)) errors.push(ETORO_LEVERAGE_TEXT);
      if ((lev > 1 || t.side === 'sell') && t.stopLoss === undefined) errors.push(lev > 1 ? 'eToro cere stop loss la un levier peste 1×.' : 'eToro cere stop loss la o poziție short.');
      if (t.kind === 'limit_ioc' && t.price !== undefined && last !== null && Math.abs(t.price - last) / last > 0.1) errors.push(`eToro refuză o limită la peste 10% de prețul de acum (${fmtPlain(last)}).`);
      value = t.amountIn === 'quote' ? t.amount : last !== null ? t.amount * last : null;
      if (t.amountIn === 'quote' && last !== null) amount = t.amount / last;
      if (value !== null && cash !== null) {
        if (value / lev > cash) warnings.push(`Disponibil: ${fmtPlain(cash)} USD; poziția cere ${fmtPlain(value / lev)}.`);
        else if (value / lev > cash * 0.5) warnings.push(`Poziția folosește peste jumătate din disponibil (${fmtPlain(cash)} USD).`);
      }
      if (lev > 10) warnings.push(`Levier ${lev}×: o mișcare de ${fmtPlain(100 / lev)}% împotriva poziției o închide.`);
      if (t.side === 'sell') warnings.push('Pe eToro, „Vinde” deschide o poziție short; o deținere se vinde cu „Închide”.');
      commonChecks({ ...t, kind: t.kind === 'mit' ? 'limit' : t.kind, price: t.kind === 'mit' ? undefined : t.price }, { last, entry: t.triggerPrice ?? t.price ?? last }, { warnings, errors }, fmtPlain);
    }
    return {
      ticket: t,
      displaySymbol: `${ins.symbol} · ${ins.name}`,
      amount,
      contracts: null,
      price: t.price ?? null,
      triggerPrice: t.triggerPrice ?? null,
      last,
      value,
      margin: !t.close && value !== null ? value / (t.leverage ?? 1) : null,
      available: cash,
      currency: 'USD',
      env: 'live',
      warnings,
      errors,
    };
  }

  /**
   * FIX-ETOROFX: an order on JPY/USD as eToro takes it, on USDJPY: the other side, its levels and prices 1/x, its units
   * (yen) as dollars at USDJPY's rate now (eToro's when fresh, else Twelve Data's), a part closed as the same share of
   * the positions' dollars. The form's preview is the one sent (its ticket), with what was turned said first.
   */
  private async normalizeInverse(t: OrderTicket, via: string): Promise<OrderPreview> {
    const ins = await this.resolve(t.symbol);
    const [{ held }, rate] = await Promise.all([this.portfolio(ins.instrumentId), this.lastOf(ins)]);
    const pair = `USD/${via.slice(3)}`;
    let u: OrderTicket;
    if (t.close) {
      let units = t.close.units;
      if (units !== undefined) {
        const picked = held.positions.filter((p) => t.close?.positionIds.includes(p.id));
        const dollars = picked.reduce((a, p) => a + p.units, 0);
        const own = picked.reduce((a, p) => a + p.units * (p.openRate ?? rate ?? 0), 0);
        if (!(own > 0)) throw new TradingError('INVALID', `Unitățile pozițiilor ${pair} nu se pot citi acum.`);
        units = Number(((units / own) * dollars).toFixed(4));
      }
      u = { ...t, symbol: via, side: t.side === 'buy' ? 'sell' : 'buy', close: { ...t.close, ...(units !== undefined ? { units } : {}) } };
    } else {
      if (t.amountIn !== 'quote' && !(rate && rate > 0)) throw new TradingError('INVALID', `Prețul ${pair} nu se poate citi acum: unitățile ordinului nu se pot calcula.`);
      u = {
        ...t,
        symbol: via,
        side: t.side === 'buy' ? 'sell' : 'buy',
        amount: t.amountIn === 'quote' ? t.amount : Number((t.amount / (rate as number)).toFixed(4)),
        ...(t.stopLoss !== undefined ? { stopLoss: flip(t.stopLoss) } : {}),
        ...(t.takeProfit !== undefined ? { takeProfit: flip(t.takeProfit) } : {}),
        ...(t.price !== undefined ? { price: flip(t.price) } : {}),
        ...(t.triggerPrice !== undefined ? { triggerPrice: flip(t.triggerPrice) } : {}),
      };
    }
    const p = await this.normalize(u);
    const what = t.close
      ? `La eToro, ${t.symbol} e ${pair}: se închid pozițiile ${pair}.`
      : `La eToro, ${t.symbol} se tranzacționează ca ${pair}: ${t.side === 'buy' ? 'un long' : 'un short'} pe ${t.symbol} e ${t.side === 'buy' ? 'un short' : 'un long'} pe ${pair}${u.stopLoss !== undefined ? `, SL ${fmtPlain(u.stopLoss)}` : ''}${u.takeProfit !== undefined ? `, TP ${fmtPlain(u.takeProfit)}` : ''}.`;
    return { ...p, warnings: [what, ...p.warnings] };
  }

  /** An order's lookup read as a state: filled, rejected (with eToro's reason), cancelled; null: still in flight. */
  private static stateOf(r: Record<string, unknown>): { status: OrderResult['status']; message: string | null } | null {
    const status = obj(r.status);
    const id = num(status.id);
    if (id === 3 || id === 5) return { status: 'filled', message: null };
    if (id === 4 || id === 10) return { status: 'rejected', message: `Refuzat de eToro: ${str(status.errorMessage) ?? str(status.errorCode) ?? 'fără motiv'}` };
    if (id === 7 || id === 9) return { status: 'cancelled', message: 'Anulat la eToro.' };
    return null;
  }

  /** FIX-ETOROPENDING: an order's state now (one lookup); still in flight: pending. */
  async lookup(orderId: string): Promise<{ status: OrderResult['status']; message: string | null }> {
    const r = obj(await this.call('GET', `/api/v2/trading/info/${this.seg()}orders:lookup?orderId=${encodeURIComponent(orderId)}`, randomUUID()));
    return EtoroTrader.stateOf(r) ?? { status: 'pending', message: null };
  }

  /** Reads the order back: filled, rejected (with the reason) or still in flight after a few seconds. */
  private async outcome(orderId: string | null, requestId: string): Promise<OrderResult> {
    for (let i = 0; i < LOOKUP_TRIES; i++) {
      await this.sleep(1000);
      let r: Record<string, unknown>;
      try {
        const q = orderId ? `orderId=${encodeURIComponent(orderId)}` : `referenceId=${encodeURIComponent(requestId)}`;
        r = obj(await this.call('GET', `/api/v2/trading/info/${this.seg()}orders:lookup?${q}`, randomUUID()));
      } catch {
        continue;
      }
      const oid = str(r.orderId) ?? orderId;
      const s = EtoroTrader.stateOf(r);
      if (s) return { status: s.status, orderId: oid, message: s.status === 'cancelled' ? null : s.message, followUps: [] };
    }
    return { status: 'pending', orderId, message: 'Primit de eToro; se execută când piața permite (verifică pagina Tranzacții).', followUps: [] };
  }

  async place(preview: OrderPreview): Promise<OrderResult> {
    const t = preview.ticket;
    const ins = await this.resolve(t.symbol);
    if (t.close) {
      // Position by position: one that fails does not hide the ones already closed.
      const out: string[] = [];
      const failed: string[] = [];
      // A close whose answer was lost may have gone through: told apart from a refusal.
      const unsure: string[] = [];
      let firstError: unknown = null;
      let unsureError: unknown = null;
      // Units of several positions: split on the positions held now (whole ones, then part of the next).
      const plan =
        t.close.units !== undefined && t.close.positionIds.length > 1
          ? closePlan((await this.portfolio(ins.instrumentId)).held.positions, t.close.positionIds, t.close.units)
          : t.close.positionIds.map((id) => ({ id, units: t.close?.units ?? null }));
      if (plan.length === 0) throw new TradingError('REJECTED', 'Pozițiile nu mai sunt deschise.');
      for (const [i, { id: positionId, units: deduct }] of plan.entries()) {
        try {
          const body = { InstrumentId: ins.instrumentId, UnitsToDeduct: deduct };
          const r = obj(await this.call('POST', `/api/v1/trading/execution/${this.seg()}market-close-orders/positions/${encodeURIComponent(positionId)}`, nthRequestId(t.idemKey, i), body));
          const oid = str(obj(r.orderForClose).orderID ?? obj(r.orderForClose).orderId ?? r.orderId);
          if (oid) out.push(oid);
        } catch (err) {
          firstError ??= err;
          if (err instanceof TradingError && err.code === 'UNKNOWN_OUTCOME') {
            unsureError ??= err;
            unsure.push(positionId);
          } else failed.push(`${positionId} (${(err as Error).message})`);
        }
      }
      const total = plan.length;
      const received = total - failed.length - unsure.length;
      if (received === 0) throw unsureError ?? firstError;
      const parts = [`Închiderea a fost primită pentru ${received} ${received === 1 ? 'poziție' : 'poziții'}`];
      if (failed.length) parts.push(`NU s-au închis: ${failed.join('; ')}`);
      if (unsure.length) parts.push(`nu știm sigur dacă s-au închis (verifică pe eToro): ${unsure.join(', ')}`);
      const message = received === total ? 'Cererea de închidere a fost primită de eToro.' : `${parts.join('; ')}.`;
      return { status: 'sent', orderId: out.join(', ') || null, message, followUps: [] };
    }
    const body: Record<string, unknown> = {
      action: 'open',
      transaction: t.side === 'buy' ? 'buy' : 'sellShort',
      instrumentId: ins.instrumentId,
      orderType: t.kind === 'mit' ? 'mit' : t.kind === 'limit_ioc' ? 'limitIOC' : 'mkt',
      leverage: t.leverage ?? 1,
      ...(t.amountIn === 'quote' ? { amount: t.amount, orderCurrency: 'usd' } : { units: t.amount }),
      ...(t.kind === 'mit' ? { triggerRate: t.triggerPrice } : {}),
      ...(t.kind === 'limit_ioc' ? { limitRate: t.price } : {}),
      ...(t.stopLoss !== undefined ? { stopLossRate: t.stopLoss } : {}),
      ...(t.takeProfit !== undefined ? { takeProfitRate: t.takeProfit } : {}),
    };
    const r = obj(await this.call('POST', `/api/v2/trading/execution/${this.seg()}orders`, t.idemKey, body));
    return this.outcome(str(r.orderId), t.idemKey);
  }

  async cancel(input: CancelInput): Promise<OrderResult> {
    if (!/^\d+$/.test(input.orderId)) throw new TradingError('INVALID', 'Acesta e un SL / TP al unei poziții eToro: se schimbă din eToro.');
    await this.call('DELETE', `/api/v2/trading/execution/${this.seg()}orders/${input.orderId}`, randomUUID());
    return { status: 'cancelled', orderId: input.orderId, message: 'Anularea a fost cerută (dacă ordinul nu s-a executat deja).', followUps: [] };
  }

  // ---------------- FD-ORDEREDIT: a position's stop loss / take profit ----------------

  /** One open position as eToro gives it (with its stop loss / take profit), or null when it is no longer open. */
  private async positionById(positionId: string): Promise<Record<string, unknown> | null> {
    const root = obj(await this.call('GET', `/api/v1/trading/info/${this.demo ? 'demo' : 'real'}/pnl`, randomUUID()));
    const pf = Object.keys(obj(root.clientPortfolio)).length ? obj(root.clientPortfolio) : root;
    return arr(pf.positions).find((p) => str(p.positionID ?? p.positionId) === positionId) ?? null;
  }

  async normalizeModify(t: ModifyTicket): Promise<ModifyPlan> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const steps: ModifyStepPlan[] = [];
    const ids: (string | null)[] = [];
    const cache = new Map<string, Record<string, unknown> | null>();
    let last: number | null = null;
    for (const [i, c] of t.changes.entries()) {
      if (c.what === 'order') {
        errors.push('Un ordin eToro în așteptare nu se poate modifica: anulează-l și pune altul.');
        continue;
      }
      const positionId = c.orderId ? etoroProtectionOf({ id: c.orderId, cancellable: false })?.positionId : t.position?.ref;
      if (!positionId) {
        errors.push('Poziția eToro lipsește.');
        continue;
      }
      if (!cache.has(positionId)) cache.set(positionId, await this.positionById(positionId));
      const p = cache.get(positionId);
      if (!p) {
        errors.push('Poziția nu mai e deschisă.');
        continue;
      }
      const isBuy = p.isBuy !== false;
      const rate = num(obj(p.unrealizedPnL).closeRate) ?? num(p.currentRate);
      last = rate ?? last;
      const sl = p.isNoStopLoss === true ? null : num(p.stopLossRate);
      const tp = p.isNoTakeProfit === true ? null : num(p.takeProfitRate);
      const now = c.what === 'sl' ? (sl !== null && sl > 0 ? sl : null) : tp !== null && tp > 0 ? tp : null;
      if (c.level !== null) protectionChecks(c.what, isBuy, c.level, rate, { errors }, fmtPlain);
      if (c.level === null && c.what === 'sl') {
        warnings.push('Fără stop loss, pierderea poziției nu mai e limitată de un ordin.');
        if ((num(p.leverage) ?? 1) > 1 || !isBuy) warnings.push('eToro poate refuza ștergerea stop loss-ului la o poziție cu levier sau short.');
      }
      if (c.level === now) continue;
      const key = c.what === 'sl' ? 'stopLoss' : 'takeProfit';
      steps.push({
        change: i,
        how: 'position',
        orderId: c.orderId,
        side: isBuy ? 'sell' : 'buy',
        kind: c.what,
        before: { price: null, triggerPrice: null, amount: num(p.units), takeProfit: null, stopLoss: null, [key]: now },
        after: { price: null, triggerPrice: null, amount: num(p.units), takeProfit: null, stopLoss: null, [key]: c.level },
        removes: c.level === null,
      });
      ids.push(positionId);
    }
    if (!steps.length && !errors.length) errors.push('Nimic nu se schimbă: valorile sunt cele de acum.');
    const preview: ModifyPreview = { ticket: t, displaySymbol: t.symbol, last, currency: 'USD', env: '', steps, warnings: [...new Set(warnings)], errors };
    return { preview, internal: { ids } };
  }

  async modify(plan: ModifyPlan): Promise<ModifyResult> {
    const { ids } = plan.internal as { ids: string[] };
    // A position's stop loss and take profit go out together, in one request (PATCH .../positions/{id}).
    const byPosition = new Map<string, { body: Record<string, unknown>; changes: number[] }>();
    plan.preview.steps.forEach((s, i) => {
      const id = ids[i] as string;
      const e = byPosition.get(id) ?? { body: {}, changes: [] };
      const level = s.kind === 'sl' ? s.after.stopLoss : s.after.takeProfit;
      if (s.kind === 'sl') Object.assign(e.body, level === null ? { clearStopLoss: true } : { stopLossRate: level });
      else Object.assign(e.body, level === null ? { clearTakeProfit: true } : { takeProfitRate: level });
      e.changes.push(s.change);
      byPosition.set(id, e);
    });
    const results: (ModifyResult['steps'][number] & { unknown?: boolean })[] = [];
    let n = 0;
    for (const [id, e] of byPosition) {
      try {
        // eToro answers 202: accepted, carried out a moment later.
        await this.call('PATCH', `/api/v2/trading/${this.seg()}positions/${encodeURIComponent(id)}`, nthRequestId(plan.preview.ticket.idemKey, n++), e.body);
        for (const c of e.changes) results.push({ change: c, what: 'cerere primită de eToro', ok: true, orderId: id, message: null });
      } catch (err) {
        const unknown = err instanceof TradingError && err.code === 'UNKNOWN_OUTCOME';
        for (const c of e.changes) results.push({ change: c, what: 'eroare', ok: false, orderId: id, message: (err as Error).message, ...(unknown ? { unknown } : {}) });
        if (unknown) break;
      }
    }
    return { status: modifyStatus(results), steps: results.map(({ unknown: _u, ...r }) => r) };
  }
}
