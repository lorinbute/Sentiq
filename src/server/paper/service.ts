// FD-PAPER: Paper Trading profiles and their engine. A profile is an account of its own (`exchange = paper`); its money,
// positions, waiting orders and closed trades are in the database. Orders are checked like a platform's (the same
// shapes: OrderPreview, ModifyPlan…), filled at the prices the charts show (prices.ts), and the waiting ones, the stop
// losses / take profits and the liquidations are looked at every few seconds (`match`, a job). Never an order anywhere.
import type { Db } from '../db/database.ts';
import type { Logger } from '../log.ts';
import { ValidationError } from '../settings.ts';
import { commissionOf, commissionText, isUsdQuote, PAPER_MARKETS, paperCreateSchema, paperResetSchema, paperSettingsSchema, type CommissionType, type PaperKind } from '../../shared/paper.ts';
import type { CancelInput, ModifyPlan, ReversePlan } from '../exchange/trading/types.ts';
import { commonChecks, fmtPlain, TradingError } from '../exchange/trading/types.ts';
import type { AccountHistory, BalanceRow, OrderRow, Portfolio, PositionRow, TradeStats } from '../exchange/accounts.ts';
import { periodStart, summarizeResults, type StatsPeriod } from '../exchange/trade-stats.ts';
import { marginOf, pnlPercent, type TradeHistoryRow } from '../exchange/trade-history.ts';
import type { InstrumentInfo, ModifyChange, ModifyPreview, ModifyResult, ModifyStepPlan, ModifyStepResult, ModifyTicket, ModifyValues, OrderPreview, OrderResult, OrderTicket, ReversePreview, ReverseTicket, TradeMarket } from '../../shared/trading.ts';
import type { QuoteDeps } from '../market/quote.ts';
import {
  applyFill,
  available,
  closingSide,
  crossBreached,
  crossLiquidationPrice,
  effectiveLeverage,
  liquidationPrice,
  orderTouch,
  protectionTouch,
  reserveFor,
  sideOf,
  unrealized,
  type ClosedPart,
  type CloseReason,
  type Execution,
  type MarginMode,
  type PaperMarket,
  type PaperOrder,
  type PaperOrderKind,
  type PaperPosition,
  type PositionState,
} from './model.ts';
import { PaperPrices, priceSymbol, type Prices } from './prices.ts';

/** A profile's settings and money, with its owner and name. */
export interface PaperAccountRow {
  account_id: number;
  user_id: number;
  label: string;
  kind: PaperKind;
  budget: number;
  cash: number;
  commission_type: CommissionType;
  commission_value: number;
  reset_at: number;
  checked_at: number | null;
}

interface PositionDb {
  id: number;
  market: PaperMarket;
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entry: number;
  leverage: number;
  margin_mode: MarginMode;
  margin: number;
  sl: number | null;
  tp: number | null;
  fees: number;
  opened_at: number;
  updated_at: number;
}

interface OrderDb {
  id: number;
  market: PaperMarket;
  symbol: string;
  side: 'buy' | 'sell';
  kind: PaperOrderKind;
  qty: number;
  price: number | null;
  trigger_price: number | null;
  leverage: number | null;
  margin_mode: MarginMode | null;
  reduce_only: boolean | number;
  sl: number | null;
  tp: number | null;
  triggered: boolean | number;
  reserved: number;
  created_at: number;
  checked_at: number;
}

interface TradeDb {
  id: number;
  market: PaperMarket;
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  leverage: number;
  sl: number | null;
  tp: number | null;
  opened_at: number;
  closed_at: number;
  reason: CloseReason;
}

const toPosition = (r: PositionDb): PaperPosition => ({
  id: r.id,
  market: r.market,
  symbol: r.symbol,
  side: r.side,
  qty: r.qty,
  entry: r.entry,
  leverage: r.leverage,
  marginMode: r.margin_mode,
  margin: r.margin,
  sl: r.sl,
  tp: r.tp,
  fees: r.fees,
  openedAt: r.opened_at,
  updatedAt: r.updated_at,
});

const toOrder = (r: OrderDb): PaperOrder => ({
  id: r.id,
  market: r.market,
  symbol: r.symbol,
  side: r.side,
  kind: r.kind,
  qty: r.qty,
  price: r.price,
  triggerPrice: r.trigger_price,
  leverage: r.leverage,
  marginMode: r.margin_mode,
  reduceOnly: Boolean(r.reduce_only),
  sl: r.sl,
  tp: r.tp,
  triggered: Boolean(r.triggered),
  reserved: r.reserved,
  createdAt: r.created_at,
  checkedAt: r.checked_at,
});

export const PAPER_SELECT = `SELECT p.*, a.user_id, a.label FROM paper_accounts p JOIN exchange_accounts a ON a.id = p.account_id`;
const STEP: Record<PaperMarket, number> = { spot: 1e-8, futures: 1e-8, stock: 1e-6 };
const MIN_VALUE = 1;
const MAX_LEVERAGE = 125;
const REASON_RO: Record<CloseReason, string> = { order: 'închisă', sl: 'stop loss', tp: 'take profit', liquidation: 'lichidare', reverse: 'inversată' };
/** Down to a step; a whole number of steps stays whole (0.29 / 1e-8 is 28999999.999999996 in floating point). */
const floorTo = (v: number, step: number) => {
  const x = v / step;
  return Math.floor(x + Math.max(1e-9, Math.abs(x) * 1e-12)) * step;
};
const round = (v: number, step: number) => Number(floorTo(v, step).toFixed(10));
/** The order id the pages see: `p<id>`; a position's stop loss / take profit: `sl-<id>` / `tp-<id>` (as eToro's). */
const orderId = (id: number) => `p${id}`;
const parseOrderId = (s: string): { kind: 'order' | 'sl' | 'tp'; id: number } | null => {
  const m = /^(p|sl-|tp-)(\d+)$/.exec(s);
  if (!m) return null;
  return { kind: m[1] === 'p' ? 'order' : m[1] === 'sl-' ? 'sl' : 'tp', id: Number(m[2]) };
};

/** A symbol as the profile keeps it: a share without the `/USD` the pages show it with (AAPL/USD → AAPL), upper case. */
const ownSymbol = (market: TradeMarket | PaperMarket, symbol: string): string => {
  const s = symbol.trim().toUpperCase();
  return market === 'stock' ? (s.split('/')[0] as string) : s;
};

/** What the pages call a paper symbol: a share as `AAPL`, a coin as its pair. */
const shownSymbol = (market: PaperMarket, symbol: string) => (market === 'stock' ? `${symbol}/USD` : symbol);

/** The market a ticket's symbol is on, checked against the profile (a crypto one: spot or futures; a stocks one: shares). */
function symbolCheck(kind: PaperKind, market: TradeMarket, symbol: string): string | null {
  if (!PAPER_MARKETS[kind].includes(market)) return kind === 'crypto' ? 'Profilul e de crypto: tranzacționează spot și futures.' : 'Profilul e de acțiuni: tranzacționează acțiuni.';
  if (market === 'stock') return /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol) ? null : 'Simbolul acțiunii nu e valid (ex. AAPL).';
  const m = market === 'futures' ? /^([A-Z0-9]+)\/([A-Z0-9]+):([A-Z0-9]+)$/.exec(symbol) : /^([A-Z0-9]+)\/([A-Z0-9]+)$/.exec(symbol);
  if (!m) return market === 'futures' ? 'Perechea futures se scrie BTC/USDT:USDT.' : 'Perechea se scrie BTC/USDT.';
  if (!isUsdQuote(m[2] as string) || (market === 'futures' && m[3] !== m[2])) return 'Paper Trading tranzacționează doar perechi în USDT, USDC sau USD.';
  return null;
}

export interface PaperDeps {
  db: Db;
  quotes: QuoteDeps;
  log: Logger;
  now?: () => number;
}

export class PaperService {
  private readonly db: Db;
  private readonly log: Logger;
  private now: () => number;
  prices: PaperPrices;

  constructor(d: PaperDeps) {
    this.db = d.db;
    this.log = d.log;
    this.now = d.now ?? Date.now;
    this.prices = new PaperPrices(d.quotes);
  }

  /** Tests: the prices and the clock made by hand (the engine tests' market). */
  setQuotes(quotes: QuoteDeps, now?: () => number): void {
    this.prices = new PaperPrices(quotes);
    if (now) this.now = now;
  }

  // ------------------------------------------------------------------ profiles (FD-PAPER §2)

  /** A new profile: an account of its own, trading on from the start (no key, no money at stake). */
  async create(userId: number, input: unknown, maxAccounts: number): Promise<number> {
    const r = paperCreateSchema.safeParse(input);
    if (!r.success) throw new ValidationError(r.error.issues.map((i) => i.message).join(' '), r.error.issues);
    const p = r.data;
    const now = this.now();
    return this.db.tx(async () => {
      if (((await this.db.get<{ n: number }>('SELECT count(*) AS n FROM exchange_accounts WHERE user_id = ?', [userId]))?.n ?? 0) >= maxAccounts) {
        throw new ValidationError(`Poți avea cel mult ${maxAccounts} conturi.`);
      }
      const id = (
        await this.db.run(
          "INSERT INTO exchange_accounts(user_id, exchange, label, api_key, secret, password, credentials, env, key_hint, created_at, kind, trading_enabled_at, trading_markets) VALUES (?, N'paper', ?, N'', N'', NULL, NULL, N'paper', N'', ?, ?, ?, ?)",
          [userId, p.label, now, p.kind, now, PAPER_MARKETS[p.kind].join(',')],
        )
      ).lastInsertRowid;
      await this.db.run('INSERT INTO paper_accounts(account_id, kind, budget, cash, commission_type, commission_value, reset_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', [
        id,
        p.kind,
        p.budget,
        p.budget,
        p.commissionType,
        p.commissionValue,
        now,
      ]);
      return id;
    });
  }

  /** The name and the commission (from the next execution). */
  async settings(id: number, input: unknown): Promise<void> {
    const r = paperSettingsSchema.safeParse(input);
    if (!r.success) throw new ValidationError(r.error.issues.map((i) => i.message).join(' '), r.error.issues);
    await this.db.tx(async () => {
      await this.db.run('UPDATE exchange_accounts SET label = ? WHERE id = ?', [r.data.label, id]);
      await this.db.run('UPDATE paper_accounts SET commission_type = ?, commission_value = ? WHERE account_id = ?', [r.data.commissionType, r.data.commissionValue, id]);
    });
  }

  /**
   * A reset (FD-PAPER §2): the bots trading on it end first, then its positions, orders and history go and its money is
   * the new budget. Returns the bots ended.
   */
  async reset(id: number, input: unknown): Promise<number> {
    const r = paperResetSchema.safeParse(input);
    if (!r.success) throw new ValidationError(r.error.issues.map((i) => i.message).join(' '), r.error.issues);
    const now = this.now();
    return this.db.tx(async () => {
      const bots = await this.db.all<{ id: number }>("SELECT id FROM bots WHERE account_id = ? AND status <> N'ended'", [id]);
      for (const b of bots) {
        await this.db.run("UPDATE bots SET status = N'ended', status_reason = ?, updated_at = ? WHERE id = ?", ['Profilul Paper a fost resetat.', now, b.id]);
        await this.db.run("INSERT INTO bot_events(bot_id, at, kind, symbol, message, detail) VALUES (?, ?, N'end', NULL, ?, NULL)", [b.id, now, 'Profilul Paper a fost resetat: botul s-a încheiat.']);
      }
      await this.db.run('DELETE FROM paper_orders WHERE account_id = ?', [id]);
      await this.db.run('DELETE FROM paper_positions WHERE account_id = ?', [id]);
      await this.db.run('DELETE FROM paper_trades WHERE account_id = ?', [id]);
      await this.db.run('UPDATE paper_accounts SET budget = ?, cash = ?, reset_at = ?, checked_at = NULL WHERE account_id = ?', [r.data.budget, r.data.budget, now, id]);
      return bots.length;
    });
  }

  async account(id: number): Promise<PaperAccountRow | undefined> {
    return this.db.get<PaperAccountRow>(`${PAPER_SELECT} WHERE p.account_id = ?`, [id]);
  }

  private async mustAccount(id: number): Promise<PaperAccountRow> {
    const a = await this.account(id);
    if (!a) throw new TradingError('NO_ACCOUNT', 'Profilul Paper Trading nu există.');
    return a;
  }

  private async positions(id: number): Promise<PaperPosition[]> {
    return (await this.db.all<PositionDb>('SELECT * FROM paper_positions WHERE account_id = ? ORDER BY id', [id])).map(toPosition);
  }

  private async orders(id: number): Promise<PaperOrder[]> {
    return (await this.db.all<OrderDb>('SELECT * FROM paper_orders WHERE account_id = ? ORDER BY id', [id])).map(toOrder);
  }

  private fee(a: Pick<PaperAccountRow, 'commission_type' | 'commission_value'>): (notional: number) => number {
    return (notional) => commissionOf(a.commission_type, a.commission_value, notional);
  }

  // ------------------------------------------------------------------ writes (inside a transaction)

  private async savePosition(accountId: number, before: PaperPosition | null, after: PositionState | null): Promise<void> {
    if (!after) {
      if (before) await this.db.run('DELETE FROM paper_positions WHERE id = ?', [before.id]);
      return;
    }
    if (before && after.id === before.id) {
      await this.db.run('UPDATE paper_positions SET side = ?, qty = ?, entry = ?, leverage = ?, margin_mode = ?, margin = ?, sl = ?, tp = ?, fees = ?, opened_at = ?, updated_at = ? WHERE id = ?', [
        after.side,
        after.qty,
        after.entry,
        after.leverage,
        after.marginMode,
        after.margin,
        after.sl,
        after.tp,
        after.fees,
        after.openedAt,
        after.updatedAt,
        before.id,
      ]);
      return;
    }
    if (before) await this.db.run('DELETE FROM paper_positions WHERE id = ?', [before.id]);
    await this.db.run(
      'INSERT INTO paper_positions(account_id, market, symbol, side, qty, entry, leverage, margin_mode, margin, sl, tp, fees, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [accountId, after.market, after.symbol, after.side, after.qty, after.entry, after.leverage, after.marginMode, after.margin, after.sl, after.tp, after.fees, after.openedAt, after.updatedAt],
    );
  }

  private async book(accountId: number, c: ClosedPart): Promise<void> {
    await this.db.run(
      'INSERT INTO paper_trades(account_id, market, symbol, side, qty, entry, [exit], pnl, fees, leverage, sl, tp, opened_at, closed_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [accountId, c.market, c.symbol, c.side, c.qty, c.entry, c.exit, c.pnl, c.fees, c.leverage, c.sl, c.tp, c.openedAt, c.closedAt, c.reason],
    );
  }

  /**
   * One execution, booked: the position, the closed part, the money; a position closed or turned takes its reduce-only
   * orders with it. Inside a transaction. Returns the commission.
   */
  private async execute(a: PaperAccountRow, x: Execution): Promise<{ fee: number; position: PositionState | null }> {
    const before = (await this.db.get<PositionDb>('SELECT * FROM paper_positions WHERE account_id = ? AND market = ? AND symbol = ?', [a.account_id, x.market, x.symbol])) ?? null;
    const pos = before ? toPosition(before) : null;
    const fee = this.fee(a)(x.qty * x.price);
    const out = applyFill(pos, x, fee);
    const keepId = out.position && pos && out.position.side === pos.side ? { ...out.position, id: pos.id } : out.position;
    await this.savePosition(a.account_id, pos, keepId);
    if (out.closed) await this.book(a.account_id, out.closed);
    await this.db.run('UPDATE paper_accounts SET cash = cash + ? WHERE account_id = ?', [out.cash, a.account_id]);
    if (pos && (!out.position || out.position.side !== pos.side)) {
      await this.db.run('DELETE FROM paper_orders WHERE account_id = ? AND market = ? AND symbol = ? AND reduce_only = 1', [a.account_id, x.market, x.symbol]);
    }
    return { fee: out.fee, position: out.position };
  }

  /** An isolated position liquidated (FD-PAPER §5): its margin lost, the commission of the execution, its orders gone. */
  private async liquidate(a: PaperAccountRow, p: PaperPosition, price: number, at: number): Promise<void> {
    const fee = this.fee(a)(p.qty * price);
    await this.db.run('DELETE FROM paper_positions WHERE id = ?', [p.id]);
    await this.book(a.account_id, { market: p.market, symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, exit: price, pnl: -p.margin - p.fees - fee, fees: p.fees + fee, leverage: effectiveLeverage(p), sl: p.sl, tp: p.tp, openedAt: p.openedAt, closedAt: at, reason: 'liquidation' });
    await this.db.run('UPDATE paper_accounts SET cash = cash - ? WHERE account_id = ?', [p.margin + fee, a.account_id]);
    await this.db.run('DELETE FROM paper_orders WHERE account_id = ? AND market = ? AND symbol = ? AND reduce_only = 1', [a.account_id, p.market, p.symbol]);
  }

  // ------------------------------------------------------------------ trading (the Trader's calls)

  /** What the order form needs (prices, what is free, the position). */
  async instrument(id: number, market: TradeMarket, symbol: string): Promise<InstrumentInfo> {
    const a = await this.mustAccount(id);
    const sym = ownSymbol(market, symbol);
    const bad = symbolCheck(a.kind, market, sym);
    if (bad) throw new TradingError('INVALID', bad);
    const last = await this.lastOrNull(a.user_id, market, sym);
    const [positions, orders] = [await this.positions(id), await this.orders(id)];
    const pos = positions.find((p) => p.market === market && p.symbol === sym) ?? null;
    return {
      market,
      symbol: sym,
      ref: null,
      name: null,
      currency: a.kind === 'stocks' ? 'USD' : 'USDT',
      base: market === 'stock' ? sym : (sym.split('/')[0] as string),
      last,
      amountStep: STEP[market as PaperMarket],
      minAmount: null,
      minCost: MIN_VALUE,
      priceStep: null,
      contractSize: null,
      // FIX-PAPERLEV: every market with leverage, long and short, either margin.
      maxLeverage: MAX_LEVERAGE,
      availableQuote: Math.max(0, available(a.cash, positions, orders)),
      availableBase: null,
      position: pos ? { side: pos.side, amount: pos.qty, entryPrice: pos.entry } : null,
      positionMode: 'one-way',
      marginModes: ['isolated', 'cross'] as const,
    } as InstrumentInfo;
  }

  private async lastOrNull(userId: number, market: TradeMarket, symbol: string): Promise<number | null> {
    try {
      const p = await this.prices.last(userId, market as PaperMarket, symbol, false);
      return p === 'closed' ? null : p;
    } catch {
      return null;
    }
  }

  /** The order checked (FD-PAPER §8): the symbol, the price, the amount, the levels, the money. Nothing is written. */
  async normalize(id: number, t: OrderTicket): Promise<OrderPreview> {
    const a = await this.mustAccount(id);
    const symbol = ownSymbol(t.market, t.symbol);
    const market = t.market as PaperMarket;
    const warnings: string[] = ['Paper Trading: niciun ordin real.'];
    const errors: string[] = [];
    const base: Omit<OrderPreview, 'amount' | 'price' | 'triggerPrice' | 'last' | 'value' | 'margin' | 'available' | 'warnings' | 'errors'> = {
      ticket: { ...t, symbol },
      displaySymbol: symbol,
      contracts: null,
      currency: a.kind === 'stocks' ? 'USD' : 'USDT',
      env: 'paper',
      positionMode: 'one-way' as const,
    };
    const fail = (message: string): OrderPreview => ({ ...base, amount: t.amount, price: t.price ?? null, triggerPrice: t.triggerPrice ?? null, last: null, value: null, margin: null, available: null, warnings, errors: [message] });
    const bad = symbolCheck(a.kind, market, symbol);
    if (bad) return fail(bad);
    if (t.kind === 'mit' || t.kind === 'limit_ioc') return fail('Paper Trading primește ordine market, limită, stop și stop-limită.');
    if (t.close) return fail('Paper Trading închide o poziție cu un ordin în direcția opusă.');
    let last: number;
    try {
      const p = await this.prices.last(a.user_id, market, symbol, t.kind === 'market' && market === 'stock');
      if (p === 'closed') return fail('Bursa e închisă acum: pune un ordin limită sau stop.');
      last = p;
    } catch {
      return fail(market === 'stock' ? 'Prețul acțiunii nu se poate citi acum.' : 'Prețul nu se poate citi acum (perechea nu există pe exchange-ul graficelor sau acesta nu răspunde).');
    }
    const [positions, orders] = [await this.positions(id), await this.orders(id)];
    const pos = positions.find((p) => p.market === market && p.symbol === symbol) ?? null;
    const ref = t.kind === 'limit' || t.kind === 'stop_limit' ? (t.price as number) : t.kind === 'stop' ? (t.triggerPrice as number) : last;
    const step = STEP[market];
    const qty = round(t.amountIn === 'quote' ? t.amount / ref : t.amount, step);
    // FIX-PAPERLEV: the leverage and the margin of the order, on every market.
    const leverage = t.leverage ?? 1;
    const marginMode: MarginMode = t.marginMode ?? pos?.marginMode ?? 'isolated';
    const fee = this.fee(a);
    const free = available(a.cash, positions, orders);
    const digits = fmtPlain;
    commonChecks({ ...t, symbol }, { last, entry: null }, { warnings, errors }, digits);
    if (!(qty > 0)) errors.push('Cantitatea e prea mică.');
    else if (qty * ref < MIN_VALUE) errors.push(`Valoarea minimă a unui ordin: ${MIN_VALUE} ${base.currency}.`);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) errors.push(`Levierul: între 1 și ${MAX_LEVERAGE}.`);
    if (t.reduceOnly && (t.takeProfit !== undefined || t.stopLoss !== undefined)) errors.push('Un ordin reduce-only nu are TP / SL.');
    let opposite = 0;
    let closesQty = 0;
    {
      const side = sideOf(t.side);
      if (pos && pos.side !== side) {
        opposite = pos.qty;
        closesQty = Math.min(qty, pos.qty);
      }
      if (t.reduceOnly && !(pos && pos.side !== side)) errors.push('Nicio poziție de micșorat pe simbol (reduce-only).');
      if (pos && pos.marginMode !== marginMode) errors.push(`Poziția e ${pos.marginMode === 'isolated' ? 'Isolated' : 'Cross'}: un ordin pe ea are aceeași marjă.`);
      if (pos && pos.side === side) warnings.push(`Mărește poziția ${pos.side} (${digits(pos.qty)} → ${digits(pos.qty + qty)}).`);
      if (closesQty > 0 && !t.reduceOnly && qty > pos!.qty) warnings.push(`Închide poziția ${pos!.side} (${digits(pos!.qty)}) și deschide un ${side} de ${digits(qty - pos!.qty)}.`);
      else if (closesQty > 0) warnings.push(qty >= pos!.qty ? `Închide poziția ${pos!.side}.` : `Micșorează poziția ${pos!.side} (${digits(pos!.qty)} → ${digits(pos!.qty - qty)}).`);
      if (t.reduceOnly && pos && qty > pos.qty) warnings.push(`Reduce-only: doar cât poziția (${digits(pos.qty)}).`);
      // A sale without a position is a short (spot and shares too, FIX-PAPERLEV).
      if (!pos && market !== 'futures' && t.side === 'sell' && !t.reduceOnly) warnings.push('Deschide un short.');
    }
    const reserve = reserveFor({ qty, kind: t.kind as PaperOrderKind, price: t.price ?? null, triggerPrice: t.triggerPrice ?? null, leverage, reduceOnly: Boolean(t.reduceOnly) }, last, fee, opposite);
    const needs = t.kind === 'market' ? (t.reduceOnly ? 0 : (Math.max(0, qty - opposite) * last) / leverage + fee(qty * last)) : reserve;
    if (needs > 0 && a.cash <= 0) errors.push('Banii profilului s-au terminat: resetează-l (Tranzacții → Resetează).');
    else if (needs > free + 1e-9) errors.push(`Disponibil ${digits(Math.max(0, free))} ${base.currency}; ordinul cere ${digits(needs)} ${base.currency} (cu comisionul).`);
    const value = qty * ref;
    warnings.push(`Comision: ${commissionText(a.commission_type, a.commission_value)} (≈ ${digits(fee(value))} ${base.currency}).`);
    return {
      ...base,
      ticket: { ...t, symbol, leverage, marginMode },
      amount: qty,
      price: t.price ?? null,
      triggerPrice: t.triggerPrice ?? null,
      last,
      value,
      margin: t.reduceOnly ? null : (Math.max(0, qty - opposite) * ref) / leverage,
      available: Math.max(0, free),
      warnings,
      errors,
    };
  }

  /**
   * Places what `normalize` returned: a market order (or a limit already reached) fills now, at the price now; the others
   * wait with what they hold back. The money and the position are checked again under the write lock.
   */
  async place(id: number, p: OrderPreview): Promise<OrderResult> {
    const t = p.ticket;
    const market = t.market as PaperMarket;
    const a0 = await this.mustAccount(id);
    let last: number;
    try {
      const v = await this.prices.last(a0.user_id, market, t.symbol, t.kind === 'market' && market === 'stock');
      if (v === 'closed') throw new TradingError('MARKET_CLOSED', 'Bursa e închisă acum: pune un ordin limită sau stop.');
      last = v;
    } catch (err) {
      if (err instanceof TradingError) throw err;
      throw new TradingError('REJECTED', 'Prețul nu se poate citi acum.');
    }
    const now = this.now();
    const kind = t.kind as PaperOrderKind;
    const order: PaperOrder = {
      id: 0,
      market,
      symbol: t.symbol,
      side: t.side,
      kind,
      qty: p.amount,
      price: t.price ?? null,
      triggerPrice: t.triggerPrice ?? null,
      leverage: t.leverage ?? 1,
      marginMode: t.marginMode ?? 'isolated',
      reduceOnly: Boolean(t.reduceOnly),
      sl: t.stopLoss ?? null,
      tp: t.takeProfit ?? null,
      triggered: false,
      reserved: 0,
      createdAt: now,
      checkedAt: now,
    };
    const fillNow = kind === 'market' || (kind === 'limit' && (t.side === 'buy' ? last <= (t.price as number) : last >= (t.price as number)));
    return this.db.tx(async () => {
      const a = await this.mustAccount(id);
      const positions = await this.positions(id);
      const orders = await this.orders(id);
      const pos = positions.find((x) => x.market === market && x.symbol === t.symbol) ?? null;
      const free = available(a.cash, positions, orders);
      const fee = this.fee(a);
      const opposite = pos && pos.side !== sideOf(t.side) ? pos.qty : 0;
      if (order.reduceOnly && !opposite) throw new TradingError('REJECTED', 'Nicio poziție de micșorat pe simbol (reduce-only).');
      if (fillNow) {
        const price = last;
        const qty = order.reduceOnly ? Math.min(order.qty, opposite) : order.qty;
        const need = order.reduceOnly ? 0 : (Math.max(0, qty - opposite) * price) / (order.leverage ?? 1) + fee(qty * price);
        if (need > 0 && need > free + 1e-9) throw new TradingError('INSUFFICIENT', `Disponibil ${fmtPlain(Math.max(0, free))}; ordinul cere ${fmtPlain(need)} (cu comisionul).`);
        const done = await this.execute(a, { market, symbol: t.symbol, side: t.side, qty, price, leverage: order.leverage ?? 1, marginMode: pos?.marginMode ?? order.marginMode ?? 'isolated', reduceOnly: order.reduceOnly, sl: order.sl, tp: order.tp, at: now, reason: 'order' });
        return { status: 'filled', orderId: null, message: `Executat la ${fmtPlain(price)} (Paper Trading).`, followUps: [], fill: { price, qty, fee: done.fee } };
      }
      const reserved = reserveFor(order, last, fee, opposite);
      if (reserved > free + 1e-9) throw new TradingError('INSUFFICIENT', `Disponibil ${fmtPlain(Math.max(0, free))}; ordinul ține ${fmtPlain(reserved)} (cu comisionul).`);
      const newId = (
        await this.db.run(
          'INSERT INTO paper_orders(account_id, market, symbol, side, kind, qty, price, trigger_price, leverage, margin_mode, reduce_only, sl, tp, triggered, reserved, created_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
          [id, market, t.symbol, t.side, kind, order.qty, order.price, order.triggerPrice, order.leverage, order.marginMode, order.reduceOnly ? 1 : 0, order.sl, order.tp, reserved, now, now],
        )
      ).lastInsertRowid;
      return { status: 'open', orderId: orderId(newId), message: 'Ordinul așteaptă prețul (Paper Trading).', followUps: [] };
    });
  }

  /** An order cancelled; a position's stop loss / take profit (`sl-` / `tp-`) taken off it. */
  async cancel(id: number, input: CancelInput): Promise<OrderResult> {
    const ref = parseOrderId(input.orderId);
    if (!ref) throw new TradingError('NOT_FOUND', 'Ordinul nu mai există.');
    await this.db.tx(async () => {
      if (ref.kind === 'order') {
        const gone = await this.db.run('DELETE FROM paper_orders WHERE id = ? AND account_id = ?', [ref.id, id]);
        if (!gone.changes) throw new TradingError('NOT_FOUND', 'Ordinul nu mai există (s-a executat sau a fost anulat).');
        return;
      }
      const col = ref.kind === 'sl' ? 'sl' : 'tp';
      const done = await this.db.run(`UPDATE paper_positions SET ${col} = NULL, updated_at = ? WHERE id = ? AND account_id = ?`, [this.now(), ref.id, id]);
      if (!done.changes) throw new TradingError('NOT_FOUND', 'Poziția nu mai există.');
    });
    return { status: 'cancelled', orderId: input.orderId, message: ref.kind === 'order' ? 'Ordin anulat.' : `${ref.kind === 'sl' ? 'Stop loss-ul' : 'Take profit-ul'} a fost scos.`, followUps: [] };
  }

  /**
   * FD-ORDEREDIT on paper: a position's stop loss / take profit set, moved or taken off (`position`), an order's price,
   * trigger, amount or attached TP / SL changed in place (`amend`). Checked against the price now.
   */
  async normalizeModify(id: number, t: ModifyTicket): Promise<ModifyPlan> {
    const a = await this.mustAccount(id);
    const symbol = ownSymbol(t.market, t.symbol);
    const market = t.market as PaperMarket;
    const errors: string[] = [];
    const warnings: string[] = ['Paper Trading: niciun ordin real.'];
    const last = await this.lastOrNull(a.user_id, market, symbol);
    const positions = await this.positions(id);
    const orders = await this.orders(id);
    const steps: ModifyStepPlan[] = [];
    const none: ModifyValues = { price: null, triggerPrice: null, amount: null, takeProfit: null, stopLoss: null };
    for (const [i, c] of t.changes.entries()) {
      if (c.what === 'order') {
        const ref = parseOrderId(c.orderId);
        const o = ref?.kind === 'order' ? orders.find((x) => x.id === ref.id) : undefined;
        if (!o) {
          errors.push('Ordinul nu mai există (s-a executat sau a fost anulat).');
          continue;
        }
        const after: ModifyValues = {
          price: c.price ?? o.price,
          triggerPrice: c.triggerPrice ?? o.triggerPrice,
          amount: c.amount !== undefined ? round(c.amount, STEP[o.market]) : o.qty,
          takeProfit: c.takeProfit === undefined ? o.tp : c.takeProfit,
          stopLoss: c.stopLoss === undefined ? o.sl : c.stopLoss,
        };
        const long = o.side === 'buy';
        const entry = after.price ?? after.triggerPrice ?? last;
        if (!o.reduceOnly && entry !== null) {
          if (after.takeProfit !== null && (long ? after.takeProfit <= entry : after.takeProfit >= entry)) errors.push(`Take profit-ul trebuie să fie ${long ? 'peste' : 'sub'} prețul ordinului (${fmtPlain(entry)}).`);
          if (after.stopLoss !== null && (long ? after.stopLoss >= entry : after.stopLoss <= entry)) errors.push(`Stop loss-ul trebuie să fie ${long ? 'sub' : 'peste'} prețul ordinului (${fmtPlain(entry)}).`);
        }
        if (last !== null && after.triggerPrice !== null && (o.kind === 'stop' || (o.kind === 'stop_limit' && !o.triggered))) {
          if (long && after.triggerPrice <= last) errors.push(`Un stop de cumpărare se declanșează peste prețul de acum (${fmtPlain(last)}).`);
          if (!long && after.triggerPrice >= last) errors.push(`Un stop de vânzare se declanșează sub prețul de acum (${fmtPlain(last)}).`);
        }
        steps.push({ change: i, how: 'amend', orderId: c.orderId, side: o.side, kind: o.kind, before: { price: o.price, triggerPrice: o.triggerPrice, amount: o.qty, takeProfit: o.tp, stopLoss: o.sl }, after, removes: false });
        continue;
      }
      const side = t.position?.side;
      const pos = positions.find((p) => p.market === market && p.symbol === symbol && p.side === side);
      if (!pos) {
        errors.push('Poziția nu mai există.');
        continue;
      }
      const long = pos.side === 'long';
      const before = c.what === 'sl' ? pos.sl : pos.tp;
      if (c.level !== null && last !== null) {
        const below = (c.what === 'sl') === long;
        if (below && c.level >= last) errors.push(`${c.what === 'sl' ? 'Stop loss-ul' : 'Take profit-ul'} unui ${pos.side} trebuie să fie sub prețul de acum (${fmtPlain(last)}): altfel s-ar executa imediat.`);
        if (!below && c.level <= last) errors.push(`${c.what === 'sl' ? 'Stop loss-ul' : 'Take profit-ul'} unui ${pos.side} trebuie să fie peste prețul de acum (${fmtPlain(last)}): altfel s-ar executa imediat.`);
      }
      const value = (v: number | null): ModifyValues => (c.what === 'sl' ? { ...none, stopLoss: v } : { ...none, takeProfit: v });
      steps.push({ change: i, how: 'position', orderId: before !== null ? `${c.what}-${pos.id}` : null, side: closingSide(pos.side), kind: c.what === 'sl' ? 'stop' : 'limit', before: value(before), after: value(c.level), removes: c.level === null });
    }
    const preview: ModifyPreview = { ticket: { ...t, symbol }, displaySymbol: symbol, last, currency: a.kind === 'stocks' ? 'USD' : 'USDT', env: 'paper', steps, warnings, errors };
    return { preview, internal: { positions: positions.map((p) => p.id) } };
  }

  async modify(id: number, plan: ModifyPlan): Promise<ModifyResult> {
    const t = plan.preview.ticket;
    const steps: ModifyStepResult[] = [];
    const now = this.now();
    await this.db.tx(async () => {
      const a = await this.mustAccount(id);
      const fee = this.fee(a);
      for (const s of plan.preview.steps) {
        const c = t.changes[s.change] as ModifyChange;
        if (c.what === 'order') {
          const ref = parseOrderId(c.orderId);
          const row = ref ? await this.db.get<OrderDb>('SELECT * FROM paper_orders WHERE id = ? AND account_id = ?', [ref.id, id]) : undefined;
          if (!row) {
            steps.push({ change: s.change, what: 'ordinul nu mai există', ok: false, orderId: c.orderId, message: 'S-a executat sau a fost anulat.' });
            continue;
          }
          const o = toOrder(row);
          const next: PaperOrder = { ...o, price: s.after.price, triggerPrice: s.after.triggerPrice, qty: s.after.amount ?? o.qty, tp: s.after.takeProfit, sl: s.after.stopLoss };
          const positions = await this.positions(id);
          const orders = (await this.orders(id)).filter((x) => x.id !== o.id);
          const pos = positions.find((p) => p.market === o.market && p.symbol === o.symbol);
          const opposite = pos && pos.side !== sideOf(o.side) ? pos.qty : 0;
          const last = next.price ?? next.triggerPrice ?? 0;
          const reserved = reserveFor(next, last, fee, opposite);
          if (reserved > available(a.cash, positions, orders) + 1e-9) {
            steps.push({ change: s.change, what: 'nemodificat', ok: false, orderId: c.orderId, message: 'Nu sunt destui bani disponibili pentru ordinul schimbat.' });
            continue;
          }
          await this.db.run('UPDATE paper_orders SET price = ?, trigger_price = ?, qty = ?, tp = ?, sl = ?, reserved = ?, checked_at = ? WHERE id = ?', [next.price, next.triggerPrice, next.qty, next.tp, next.sl, reserved, now, o.id]);
          steps.push({ change: s.change, what: 'modificat', ok: true, orderId: c.orderId, message: null });
          continue;
        }
        const pos = await this.db.get<PositionDb>('SELECT * FROM paper_positions WHERE account_id = ? AND market = ? AND symbol = ? AND side = ?', [id, t.market, t.symbol, t.position?.side ?? '']);
        if (!pos) {
          steps.push({ change: s.change, what: 'poziția nu mai există', ok: false, orderId: null, message: null });
          continue;
        }
        const col = c.what === 'sl' ? 'sl' : 'tp';
        await this.db.run(`UPDATE paper_positions SET ${col} = ?, updated_at = ? WHERE id = ?`, [c.level, now, pos.id]);
        steps.push({ change: s.change, what: c.level === null ? `${col.toUpperCase()} scos` : `${col.toUpperCase()} pus la ${fmtPlain(c.level)}`, ok: true, orderId: c.level === null ? null : `${col}-${pos.id}`, message: null, ...(c.level === null && c.orderId ? { cancelled: c.orderId } : {}) });
      }
    });
    const ok = steps.filter((x) => x.ok).length;
    return { status: ok === steps.length ? 'done' : ok ? 'partial' : 'failed', steps };
  }

  /** FD-REVERSE on paper: the same size the other way, at the price now; its stop loss / take profit go. Any market. */
  async normalizeReverse(id: number, t: ReverseTicket): Promise<ReversePlan> {
    const a = await this.mustAccount(id);
    // FIX-PAPERLEV: a spot position turns too (a pair without the perpetual's settlement).
    const market: PaperMarket = a.kind === 'stocks' ? 'stock' : t.symbol.includes(':') ? 'futures' : 'spot';
    const symbol = ownSymbol(market, t.symbol);
    const positions = await this.positions(id);
    const pos = positions.find((p) => p.market === market && p.symbol === symbol && p.side === t.side);
    const last = await this.lastOrNull(a.user_id, market, symbol);
    const errors: string[] = [];
    if (!pos) errors.push('Poziția nu mai există.');
    if (last === null) errors.push('Prețul nu se poate citi acum.');
    if (pos && last !== null) {
      const short = reverseShortfall(a, pos, positions, await this.orders(id), last, this.fee(a));
      if (short > 0) errors.push(`Nu sunt destui bani pentru poziția întoarsă (lipsesc ${fmtPlain(short)} ${a.kind === 'stocks' ? 'USD' : 'USDT'}).`);
    }
    const to = t.side === 'long' ? 'short' : 'long';
    const preview: ReversePreview = {
      ticket: { ...t, symbol },
      displaySymbol: symbol,
      base: market === 'stock' ? symbol : (symbol.split('/')[0] as string),
      from: { side: t.side, amount: pos?.qty ?? 0 },
      to: { side: to, amount: pos?.qty ?? 0 },
      leverage: pos ? Math.round(effectiveLeverage(pos)) : null,
      marginMode: pos?.marginMode ?? null,
      last,
      cancels: pos ? Number(pos.sl !== null) + Number(pos.tp !== null) : 0,
      hedged: false,
      warnings: ['Paper Trading: niciun ordin real.'],
      errors,
      env: 'paper',
    };
    return { preview, internal: { market } };
  }

  async reverse(id: number, plan: ReversePlan): Promise<ModifyResult> {
    const t = plan.preview.ticket;
    const { market } = plan.internal as { market: PaperMarket };
    const a0 = await this.mustAccount(id);
    const last = await this.prices.last(a0.user_id, market, t.symbol, market === 'stock');
    if (last === 'closed') throw new TradingError('MARKET_CLOSED', 'Bursa e închisă acum.');
    const now = this.now();
    return this.db.tx(async () => {
      const a = await this.mustAccount(id);
      const row = await this.db.get<PositionDb>('SELECT * FROM paper_positions WHERE account_id = ? AND market = ? AND symbol = ? AND side = ?', [id, market, t.symbol, t.side]);
      if (!row) return { status: 'failed', steps: [{ change: 0, what: 'poziția nu mai există', ok: false, orderId: null, message: null }] };
      const pos = toPosition(row);
      if (reverseShortfall(a, pos, await this.positions(id), await this.orders(id), last, this.fee(a)) > 0) throw new TradingError('INSUFFICIENT', 'Nu sunt destui bani pentru poziția întoarsă.');
      const lev = Math.max(1, Math.round(effectiveLeverage(pos)));
      await this.execute(a, { market, symbol: t.symbol, side: closingSide(pos.side), qty: pos.qty * 2, price: last, leverage: lev, marginMode: pos.marginMode, reduceOnly: false, sl: null, tp: null, at: now, reason: 'reverse' });
      return { status: 'done', steps: [{ change: 0, what: `întoarsă la ${fmtPlain(last)}`, ok: true, orderId: null, message: null }] };
    });
  }

  // ------------------------------------------------------------------ the engine (FD-PAPER §5)

  /**
   * One look at every profile with something to watch: waiting orders, futures / share positions. Each profile on its
   * own (one failing never stops the others); its executions in one transaction, after its prices were read.
   */
  async match(now: number = this.now()): Promise<number> {
    // FIX-PAPERLEV: spot positions too (their SL / TP and liquidation).
    const ids = await this.db.all<{ account_id: number }>('SELECT account_id FROM paper_orders UNION SELECT account_id FROM paper_positions');
    let filled = 0;
    for (const { account_id } of ids) {
      try {
        filled += await this.matchAccount(account_id, now);
      } catch (err) {
        this.log.warn(`paper ${account_id}: ${(err as Error).message}`);
      }
    }
    return filled;
  }

  private async matchAccount(id: number, now: number): Promise<number> {
    const a0 = await this.account(id);
    if (!a0) return 0;
    const positions0 = await this.positions(id);
    const orders0 = await this.orders(id);
    const watched = [...orders0.map((o) => ({ market: o.market, symbol: o.symbol, since: o.checkedAt })), ...positions0.map((p) => ({ market: p.market, symbol: p.symbol, since: p.updatedAt }))];
    const reads = new Map<string, Prices | 'closed' | null>();
    for (const w of watched) {
      const key = `${w.market}|${w.symbol}`;
      if (reads.has(key)) continue;
      const since = Math.min(...watched.filter((x) => x.market === w.market && x.symbol === w.symbol).map((x) => x.since), a0.checked_at ?? now);
      reads.set(key, await this.prices.read(a0.user_id, w.market, w.symbol, since, now).catch(() => null));
    }
    const priceOf = (market: PaperMarket, symbol: string) => {
      const r = reads.get(`${market}|${symbol}`);
      return r && r !== 'closed' ? r : null;
    };
    let filled = 0;
    await this.db.tx(async () => {
      const a = await this.mustAccount(id);
      // The waiting orders, oldest first.
      for (const o of await this.orders(id)) {
        const p = priceOf(o.market, o.symbol);
        if (!p) continue;
        const w = this.prices.windowFor(a.user_id, o.symbol, p, o.checkedAt);
        const touch = orderTouch(o, w);
        if (!touch) {
          await this.db.run('UPDATE paper_orders SET checked_at = ? WHERE id = ?', [now, o.id]);
          continue;
        }
        if ('triggered' in touch) {
          await this.db.run('UPDATE paper_orders SET triggered = 1, checked_at = ? WHERE id = ?', [now, o.id]);
          continue;
        }
        if (await this.fillOrder(id, o, touch.price, now)) filled++;
      }
      // The positions' stop losses, take profits and isolated liquidations.
      for (const pos of await this.positions(id)) {
        const p = priceOf(pos.market, pos.symbol);
        if (!p) continue;
        const w = this.prices.windowFor(a.user_id, pos.symbol, p, pos.updatedAt);
        const liq = pos.marginMode === 'isolated' ? liquidationPrice(pos) : null;
        const touch = protectionTouch(pos, w, liq);
        if (!touch) continue;
        const acc = await this.mustAccount(id);
        if (touch.reason === 'liquidation') await this.liquidate(acc, pos, touch.price, now);
        else await this.execute(acc, { market: pos.market, symbol: pos.symbol, side: closingSide(pos.side), qty: pos.qty, price: touch.price, leverage: pos.leverage, marginMode: pos.marginMode, reduceOnly: true, sl: null, tp: null, at: now, reason: touch.reason });
        filled++;
      }
      // Cross: all its positions together.
      const acc = await this.mustAccount(id);
      const positions = await this.positions(id);
      const lastPrices = new Map<string, number>();
      for (const pos of positions) {
        const p = priceOf(pos.market, pos.symbol);
        if (p) lastPrices.set(pos.symbol, p.last);
      }
      if (crossBreached(acc.cash, positions, await this.orders(id), lastPrices)) {
        for (const pos of positions.filter((x) => x.marginMode === 'cross')) {
          await this.execute(await this.mustAccount(id), { market: pos.market, symbol: pos.symbol, side: closingSide(pos.side), qty: pos.qty, price: lastPrices.get(pos.symbol) as number, leverage: pos.leverage, marginMode: 'cross', reduceOnly: true, sl: null, tp: null, at: now, reason: 'liquidation' });
          filled++;
        }
      }
      await this.db.run('UPDATE paper_accounts SET checked_at = ? WHERE account_id = ?', [now, id]);
    });
    for (const [key, p] of reads) if (p && p !== 'closed') this.prices.remember(a0.user_id, key.split('|')[1] as string, p);
    return filled;
  }

  /** A waiting order reached: filled (its reservation let go); a spot sale beyond what is held, or a reduce-only without its position, cancelled. */
  private async fillOrder(id: number, o: PaperOrder, price: number, now: number): Promise<boolean> {
    const a = await this.mustAccount(id);
    await this.db.run('DELETE FROM paper_orders WHERE id = ?', [o.id]);
    const pos = (await this.positions(id)).find((p) => p.market === o.market && p.symbol === o.symbol) ?? null;
    let qty = o.qty;
    if (o.reduceOnly) qty = pos && pos.side !== sideOf(o.side) ? Math.min(qty, pos.qty) : 0;
    if (!(qty > 0)) return false;
    await this.execute(a, { market: o.market, symbol: o.symbol, side: o.side, qty, price, leverage: o.leverage ?? 1, marginMode: pos?.marginMode ?? o.marginMode ?? 'isolated', reduceOnly: o.reduceOnly, sl: o.sl, tp: o.tp, at: now, reason: 'order' });
    return true;
  }

  // ------------------------------------------------------------------ reading (FD-PAPER §6)

  /** The profile as a platform's portfolio: the money, the coins / positions, the orders (and the positions' SL / TP). */
  async portfolio(id: number): Promise<Portfolio> {
    const a = await this.mustAccount(id);
    const positions = await this.positions(id);
    const orders = await this.orders(id);
    const prices = new Map<string, number | null>();
    for (const p of positions) if (!prices.has(p.symbol)) prices.set(p.symbol, await this.lastOrNull(a.user_id, p.market, p.symbol));
    const free = available(a.cash, positions, orders);
    const crypto = a.kind === 'crypto';
    const currency = crypto ? 'USDT' : 'USD';
    const balances: BalanceRow[] = [];
    if (crypto) balances.push({ asset: 'USDT', account: 'paper', total: a.cash, free: Math.max(0, free), used: Math.max(0, a.cash - free), price: 1, value: a.cash, avgPrice: null, avgSource: null, pnl: null, pnlPct: null, currency });
    const rows: PositionRow[] = [];
    const orderRows: OrderRow[] = [];
    const isolated = positions.reduce((s, p) => s + (p.marginMode === 'isolated' ? p.margin : 0), 0);
    const crossBase = a.cash - isolated - orders.reduce((s, o) => s + o.reserved, 0);
    let unrealizedTotal = 0;
    // FIX-PAPERLEV: every position (spot too) with its leverage and margin, as on futures.
    for (const p of positions) {
      const last = prices.get(p.symbol) ?? null;
      const pnl = last !== null ? unrealized(p, last) : null;
      if (pnl !== null) unrealizedTotal += pnl;
      const others = positions.filter((x) => x.id !== p.id && x.marginMode === 'cross').reduce((s, x) => s + (prices.get(x.symbol) != null ? unrealized(x, prices.get(x.symbol) as number) : 0), 0);
      const liq = p.marginMode === 'isolated' ? liquidationPrice(p) : crossLiquidationPrice(p, crossBase + others);
      const symbol = shownSymbol(p.market, p.symbol);
      rows.push({
        symbol,
        side: p.side,
        contracts: p.qty,
        size: p.qty,
        entryPrice: p.entry,
        markPrice: last,
        unrealizedPnl: pnl,
        percentage: pnl !== null && p.margin > 0 ? (pnl / p.margin) * 100 : null,
        liquidationPrice: liq,
        leverage: Math.round(effectiveLeverage(p) * 100) / 100,
        marginMode: p.marginMode,
        notional: last !== null ? last * p.qty : null,
        margin: p.margin,
      });
      const closing = closingSide(p.side);
      if (p.sl !== null) orderRows.push({ id: `sl-${p.id}`, market: 'futures', symbol, type: 'stop', side: closing, price: null, triggerPrice: p.sl, amount: p.qty, filled: null, status: 'open', timestamp: p.updatedAt, reduceOnly: true, stop: p.side === 'long' ? 'down' : 'up', cancellable: true });
      if (p.tp !== null) orderRows.push({ id: `tp-${p.id}`, market: 'futures', symbol, type: 'limit', side: closing, price: p.tp, triggerPrice: null, amount: p.qty, filled: null, status: 'open', timestamp: p.updatedAt, reduceOnly: true, stop: null, cancellable: true });
    }
    for (const o of orders) {
      orderRows.push({
        id: orderId(o.id),
        market: o.market === 'spot' ? 'spot' : 'futures',
        symbol: shownSymbol(o.market, o.symbol),
        type: o.kind === 'stop_limit' ? (o.triggered ? 'limit' : 'stop_limit') : o.kind,
        side: o.side,
        price: o.price,
        triggerPrice: o.kind === 'stop' || (o.kind === 'stop_limit' && !o.triggered) ? o.triggerPrice : null,
        amount: o.qty,
        filled: 0,
        status: 'open',
        timestamp: o.createdAt,
        reduceOnly: o.reduceOnly,
        stop: o.kind === 'stop' || (o.kind === 'stop_limit' && !o.triggered) ? (o.side === 'buy' ? 'up' : 'down') : null,
        cancellable: true,
        stopLoss: o.sl,
        takeProfit: o.tp,
        positionSide: null,
      });
    }
    return {
      accountId: id,
      exchange: 'paper',
      kind: a.kind,
      currency,
      cash: crypto ? null : Math.max(0, free),
      asOf: null,
      mode: 'classic',
      balances,
      positions: rows,
      orders: orderRows,
      fills: [],
      // The account's value: the money and the positions' result (FIX-PAPERLEV: no coins held apart).
      totals: { spotValue: a.cash + unrealizedTotal, unrealizedPnl: unrealizedTotal, futuresAvailable: Math.max(0, free) },
      errors: {},
      stale: {},
      fetchedAt: this.now(),
    };
  }

  /** The closed trades of a period, as the history's rows (newest first). */
  async history(id: number, period: StatsPeriod, tz: string): Promise<AccountHistory> {
    const a = await this.mustAccount(id);
    const now = this.now();
    const from = periodStart(period, now, tz);
    const rows = await this.db.all<TradeDb>('SELECT TOP (2000) * FROM paper_trades WHERE account_id = ? AND closed_at >= ? ORDER BY closed_at DESC, id DESC', [id, from]);
    const currency = a.kind === 'stocks' ? 'USD' : 'USDT';
    const out: TradeHistoryRow[] = rows.map((r) => ({
      key: `p|${r.id}`,
      source: 'account',
      bot: null,
      open: false,
      symbol: r.market === 'stock' ? r.symbol : priceSymbol(r.symbol),
      market: r.market,
      side: r.side,
      qty: r.qty,
      leverage: r.leverage,
      entry: r.entry,
      exit: r.exit,
      sl: r.sl,
      tp: r.tp,
      pnl: r.pnl,
      pnlPct: pnlPercent(r.pnl, r.qty, r.entry, r.leverage),
      // FIX-HISTAMOUNT: the value at entry over the trade's leverage.
      margin: marginOf(r.qty, r.entry, r.leverage),
      currency,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      reason: REASON_RO[r.reason] ?? null,
    }));
    return { exchange: 'paper', broker: a.kind === 'stocks', period, from, to: now, rows: out, supported: true, error: null, limited: false, asOf: null, fetchedAt: now };
  }

  async stats(id: number, period: StatsPeriod, tz: string): Promise<TradeStats> {
    const a = await this.mustAccount(id);
    const now = this.now();
    const from = periodStart(period, now, tz);
    const rows = await this.db.all<{ pnl: number }>('SELECT pnl FROM paper_trades WHERE account_id = ? AND closed_at >= ?', [id, from]);
    const s = summarizeResults(rows.map((r) => ({ pnl: r.pnl, net: r.pnl })));
    return { period, from, to: now, supported: true, ...s, currency: a.kind === 'stocks' ? 'USD' : 'USDT', asOf: null, limited: false, unknownResults: 0, error: null, fetchedAt: now };
  }
}

/**
 * What a reversal lacks (0: nothing): the new position's margin and both commissions, against the money free once the
 * position closes (its margin back, its result at the price now).
 */
function reverseShortfall(a: PaperAccountRow, pos: PaperPosition, positions: PaperPosition[], orders: PaperOrder[], last: number, fee: (n: number) => number): number {
  const lev = Math.max(1, Math.round(effectiveLeverage(pos)));
  const free = available(a.cash, positions, orders) + pos.margin + unrealized(pos, last);
  const need = (pos.qty * last) / lev + 2 * fee(pos.qty * last);
  return Math.max(0, need - free);
}

