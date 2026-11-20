// Trading from Sentiq (FD-TRADING, TD-TRADING §4): switching it on per account (both factors again, the key's rights
// read again), checking an order, sending it once (the form's key in the journal makes a second send return the first
// result, on either instance), cancelling, and the journal itself. Only the account's owner, only where it is on.
import { FX_ACCOUNT_TEXT, fxKindOf } from '../../../shared/fx.ts';
import { readPrice, type QuoteDeps } from '../../market/quote.ts';
import type { Db } from '../../db/database.ts';
import type { Logger } from '../../log.ts';
import type { StepUp } from '../../auth/users.ts';
import type { AccountsService, AccountView } from '../accounts.ts';
import { providerById } from '../../../shared/providers.ts';
import { ticketRules, TRADING, type InstrumentInfo, type ModifyPreview, type ModifyResult, type ModifyTicket, type OrderPreview, type OrderResult, type OrderTicket, type ReversePreview, type ReverseTicket, type TradeLogRow, type TradeMarket, type TradeSymbol, type TradingCaps } from '../../../shared/trading.ts';
import { AlpacaTrader } from './alpaca.ts';
import { CcxtTrader } from './crypto.ts';
import { EtoroTrader } from './etoro.ts';
import { tradeRights } from './rights.ts';
import { journalEntry, type JournalEntry, type JournalRow } from '../trade-history.ts';
import { Trading212Trader } from './trading212.ts';
import { TradingError, type CancelInput, type Trader } from './types.ts';
import { isPaperExchange } from '../../../shared/providers.ts';
import type { PaperService } from '../../paper/service.ts';
import { PaperTrader } from '../../paper/trader.ts';

/** Actions (orders, cancellations) one user may send per minute: a stuck tab or a loop cannot send dozens. */
export const TRADE_ACTIONS_PER_MINUTE = 20;
const LOG_LIMIT = 50;
/** A journal row still "sending" after this long was cut off (a restart mid-send): its outcome is unknown. */
const PENDING_STALE_MS = 2 * 60_000;

export type TradingAccess = NonNullable<Awaited<ReturnType<AccountsService['tradingAccess']>>>;
/** FIX-ETOROSTALE: a symbol's price from the market data, for a platform whose own is not fresh (eToro). */
export type PriceFallback = (symbol: string) => Promise<number | null>;
export type TraderFactory = (a: TradingAccess, log: Logger, fallback?: PriceFallback) => Trader;

export const defaultTraderFactory: TraderFactory = (a, log, fallback) => {
  if (a.clients) return new CcxtTrader(a.exchange, a.clients, log);
  const creds = a.creds ?? {};
  switch (a.exchange) {
    case 'trading212':
      return new Trading212Trader(creds, a.env);
    case 'etoro':
      return new EtoroTrader(creds, a.env, undefined, fallback);
    case 'alpaca':
      return new AlpacaTrader(creds, a.env);
    default:
      throw new TradingError('UNSUPPORTED', TRADING[a.exchange as keyof typeof TRADING]?.reason ?? 'Platforma nu primește ordine prin Sentiq.');
  }
};

interface LogRow {
  id: number;
  account_id: number | null;
  exchange: string;
  env: string;
  account_label: string;
  action: TradeLogRow['action'];
  market: string | null;
  symbol: string | null;
  side: string | null;
  kind: string | null;
  amount: number | null;
  price: number | null;
  trigger_price: number | null;
  leverage: number | null;
  status: TradeLogRow['status'];
  order_id: string | null;
  message: string | null;
  detail: string | null;
  created_at: number;
}

const toLogRow = (r: LogRow): TradeLogRow => ({
  id: r.id,
  accountId: r.account_id,
  exchange: r.exchange,
  env: r.env,
  accountLabel: r.account_label,
  action: r.action,
  market: r.market,
  symbol: r.symbol,
  side: r.side,
  kind: r.kind,
  amount: r.amount,
  price: r.price,
  triggerPrice: r.trigger_price,
  leverage: r.leverage,
  status: r.status,
  orderId: r.order_id,
  message: r.message,
  createdAt: r.created_at,
});

/** The orders a change took off the platform (FIX-SLTPDUP). */
const cancelledBy = (r: ModifyResult): string[] => r.steps.flatMap((s) => (s.ok && s.cancelled ? [s.cancelled] : []));

export interface TradingDeps {
  db: Db;
  accounts: AccountsService;
  log: Logger;
  traderFactory?: TraderFactory;
  /** FD-PAPER: the Paper Trading engine (a profile's orders go there). */
  paper?: PaperService;
  /** FIX-ETOROSTALE: the market data, for a price when eToro's is not fresh. */
  quotes?: QuoteDeps;
  now?: () => number;
}

/** The market an action on an existing order or position is on: a broker's or a stocks profile's one market, a perpetual's futures. */
function actionMarket(a: TradingAccess, symbol: string, market: TradeMarket): TradeMarket {
  // FIX-PAPERLEV: a profile's spot positions and orders are on spot (a pair without settlement), whatever row they show in.
  if (isPaperExchange(a.exchange)) return a.kind === 'stocks' ? 'stock' : symbol.includes(':') ? 'futures' : 'spot';
  return !a.clients ? 'stock' : symbol.includes(':') ? 'futures' : market;
}

export class TradingService {
  private readonly db: Db;
  private readonly accounts: AccountsService;
  private readonly log: Logger;
  private readonly factory: TraderFactory;
  private readonly paper: PaperService | null;
  private readonly quotes: QuoteDeps | null;
  private readonly now: () => number;
  /** One trader per account, rebuilt when the account's clients are (they hold the exchange's market list). */
  private readonly traders = new Map<number, { trader: Trader; clients: unknown; creds: unknown }>();
  private readonly recent = new Map<number, number[]>();

  constructor(deps: TradingDeps) {
    this.db = deps.db;
    this.accounts = deps.accounts;
    this.log = deps.log;
    this.factory = deps.traderFactory ?? defaultTraderFactory;
    this.paper = deps.paper ?? null;
    this.quotes = deps.quotes ?? null;
    this.now = deps.now ?? Date.now;
  }

  /** What each of the user's accounts can trade now. */
  async caps(userId: number): Promise<TradingCaps[]> {
    return (await this.accounts.list(userId)).map((v: AccountView) => ({
      accountId: v.id,
      exchange: v.exchange,
      label: v.label,
      env: v.env,
      kind: v.kind,
      supported: v.trading.supported,
      enabled: v.trading.enabled,
      markets: v.trading.markets,
      reason: v.trading.reason,
    }));
  }

  /** The account, if it is the user's (anybody else's is "not found"); `enabled` also asks for trading to be on. */
  private async access(userId: number, accountId: number, enabled: boolean, market?: TradeMarket): Promise<TradingAccess> {
    const a = await this.accounts.tradingAccess(accountId);
    if (!a || a.userId !== userId) throw new TradingError('NO_ACCOUNT', 'Contul nu există.');
    if (enabled && !a.enabled) throw new TradingError('DISABLED', 'Tranzacționarea e oprită pe acest cont. Pornește-o din pagina Tranzacții.');
    // A key that has since been allowed to move funds (read again by "Testează") never trades: the switch goes off.
    if (enabled && tradeRights(a.exchange, a.permissions).funds === true) {
      await this.accounts.setTrading(accountId, null);
      throw new TradingError('PERMISSION', `Cheia poate acum retrage sau transfera fonduri (${a.permissions}); tranzacționarea a fost oprită. Fă o cheie fără retrageri și transferuri.`);
    }
    if (market && enabled && !a.markets.includes(market)) {
      throw new TradingError('DISABLED', market === 'futures' ? 'Cheia acestui cont nu poate tranzacționa futures (sau tranzacționarea a fost pornită doar pentru spot).' : 'Cheia acestui cont nu poate tranzacționa spot.');
    }
    return a;
  }

  private trader(a: TradingAccess): Trader {
    // FD-PAPER: a profile's orders go to the paper engine, never to a platform.
    if (isPaperExchange(a.exchange)) {
      if (!this.paper) throw new TradingError('UNSUPPORTED', 'Paper Trading nu e disponibil.');
      return new PaperTrader(this.paper, a.id);
    }
    const cached = this.traders.get(a.id);
    if (cached && cached.clients === a.clients && JSON.stringify(cached.creds) === JSON.stringify(a.creds)) return cached.trader;
    const quotes = this.quotes;
    // A share's Nasdaq quote or a pair's Twelve Data one (FD-FXCOMMODITIES), at any hour.
    const fallback: PriceFallback | undefined = quotes ? (symbol) => readPrice(quotes, a.userId, 'stock', symbol, false).then((p) => (p === 'closed' ? null : p)) : undefined;
    const trader = this.factory(a, this.log, fallback);
    this.traders.set(a.id, { trader, clients: a.clients, creds: a.creds });
    return trader;
  }

  /** Forgets an account's trader (the account was deleted or its key changed). */
  forget(accountId: number): void {
    this.traders.delete(accountId);
  }

  private throttle(userId: number): void {
    const now = this.now();
    const list = (this.recent.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= TRADE_ACTIONS_PER_MINUTE) {
      const wait = Math.ceil((60_000 - (now - (list[0] as number))) / 1000);
      throw new TradingError('RATE_LIMIT', `Prea multe acțiuni de tranzacționare într-un minut. Mai încearcă peste ${wait} secunde.`);
    }
    list.push(now);
    this.recent.set(userId, list);
  }

  private async journal(userId: number, a: TradingAccess, row: Partial<Omit<LogRow, 'id'>> & Pick<LogRow, 'action' | 'status'>, idemKey: string | null = null): Promise<number> {
    const now = this.now();
    return (
      await this.db.run(
        `INSERT INTO trade_log(user_id, account_id, exchange, env, account_label, idem_key, action, market, symbol, side, kind, amount, price, trigger_price, leverage, status, order_id, message, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          a.id,
          a.exchange,
          a.env,
          a.label.slice(0, 200),
          idemKey,
          row.action,
          row.market ?? null,
          row.symbol?.slice(0, 80) ?? null,
          row.side ?? null,
          row.kind ?? null,
          row.amount ?? null,
          row.price ?? null,
          row.trigger_price ?? null,
          row.leverage ?? null,
          row.status,
          row.order_id?.slice(0, 120) ?? null,
          row.message?.slice(0, 500) ?? null,
          row.detail ?? null,
          now,
          now,
        ],
      )
    ).lastInsertRowid;
  }

  /**
   * The outcome of a journal row. A refused order never reached the platform's book: its form key is let go, so the
   * same form can be sent again (after a deposit, say); only a sent or unknown order keeps the key.
   */
  private async settle(
    id: number,
    status: LogRow['status'],
    fields: { order_id?: string | null; message?: string | null; detail?: string | null; preview?: OrderPreview },
  ): Promise<void> {
    const release = status === 'rejected' || status === 'error';
    // What left, as checked: the amount in the asset (a value typed in USDT becomes BTC), the rounded prices.
    const p = fields.preview;
    await this.db.run(
      `UPDATE trade_log SET status = ?, order_id = COALESCE(?, order_id), message = ?, detail = COALESCE(?, detail), amount = COALESCE(?, amount), price = COALESCE(?, price),
       trigger_price = COALESCE(?, trigger_price), updated_at = ?${release ? ', idem_key = NULL' : ''} WHERE id = ?`,
      [status, fields.order_id?.slice(0, 120) ?? null, fields.message?.slice(0, 500) ?? null, fields.detail ?? null, p?.amount ?? null, p?.price ?? null, p?.triggerPrice ?? null, this.now(), id],
    );
  }

  /**
   * Switches trading on (FD-TRADING §1, FD-TRADEUNLOCK): the key's rights read again first (a key that cannot trade
   * costs no attempt), then both factors again through `confirm` (password and code, or a passkey).
   */
  async enable(userId: number, accountId: number, confirm: () => Promise<StepUp>): Promise<AccountView> {
    const a = await this.access(userId, accountId, false);
    if (isPaperExchange(a.exchange)) throw new TradingError('UNSUPPORTED', 'Tranzacționarea unui profil Paper Trading e mereu pornită.');
    const platform = TRADING[a.exchange as keyof typeof TRADING];
    if (!platform?.supported) throw new TradingError('UNSUPPORTED', platform?.reason ?? 'Platforma nu primește ordine prin Sentiq.');
    let markets: TradeMarket[] = [...platform.markets];
    if (a.clients) {
      let permissions: string | null = a.permissions;
      try {
        permissions = await this.accounts.refreshPermissions(accountId);
      } catch {
        // The stored list stands.
      }
      const rights = tradeRights(a.exchange, permissions);
      // A key that no longer qualifies also switches off a trading switched on earlier.
      const refuse = async (message: string): Promise<never> => {
        if (a.enabled) await this.accounts.setTrading(accountId, null);
        throw new TradingError('PERMISSION', message);
      };
      if (rights.funds === true) await refuse(`Cheia poate retrage sau transfera fonduri (${permissions}). Fă o cheie fără retrageri și transferuri: Sentiq nu pornește tranzacționarea cu ea.`);
      if (rights.spot === false && rights.futures === false) await refuse(`Cheia nu are permisiunea de tranzacționare (${permissions ?? 'doar citire'}). ${platform.tradeSteps.join(' ')}`);
      markets = markets.filter((m) => (m === 'spot' ? rights.spot !== false : m === 'futures' ? rights.futures !== false : true));
      // E.g. a futures-only key on an exchange Sentiq trades only spot on (Kraken, Coinbase).
      if (markets.length === 0) await refuse(`Cheia nu poate tranzacționa nimic din ce Sentiq trimite pe acest exchange (${permissions ?? 'necunoscut'}).`);
    }
    const verdict = await confirm();
    if (verdict !== 'ok') {
      this.log.warn(`trading: user ${userId} switching trading on for account ${accountId} refused: wrong ${verdict}`);
      const name = providerById(a.exchange)?.name ?? a.exchange;
      throw new TradingError(
        'BAD_FACTORS',
        verdict === 'password'
          ? `Parola nu e corectă: e parola cu care intri în Sentiq, nu cea a ${name}.`
          : `Codul 2FA nu e corect sau a fost deja folosit: e codul Sentiq din aplicația de autentificare, nu cel al ${name}. Așteaptă codul următor.`,
      );
    }
    const view = await this.accounts.setTrading(accountId, markets);
    await this.journal(userId, a, { action: 'enable', status: 'sent', message: `Tranzacționare pornită: ${markets.join(', ')}` });
    this.log.info(`trading: user ${userId} switched trading on for account ${accountId} (${a.exchange}: ${markets.join(',')})`);
    return view;
  }

  async disable(userId: number, accountId: number): Promise<AccountView> {
    const a = await this.access(userId, accountId, false);
    if (isPaperExchange(a.exchange)) throw new TradingError('UNSUPPORTED', 'Tranzacționarea unui profil Paper Trading e mereu pornită.');
    const view = await this.accounts.setTrading(accountId, null);
    await this.journal(userId, a, { action: 'disable', status: 'sent', message: 'Tranzacționare oprită' });
    this.log.info(`trading: user ${userId} switched trading off for account ${accountId}`);
    return view;
  }

  async symbols(userId: number, accountId: number, market: TradeMarket): Promise<TradeSymbol[]> {
    const a = await this.access(userId, accountId, true, market);
    return this.trader(a).symbols(market);
  }

  async instrument(userId: number, accountId: number, market: TradeMarket, symbol: string): Promise<InstrumentInfo> {
    const a = await this.access(userId, accountId, true, market);
    return this.trader(a).instrument(market, symbol);
  }

  /** FIX-PAPERLEV: a platform's account takes leverage, margin and reduce-only as before; a profile on every market. */
  private rules(a: TradingAccess, t: OrderTicket): void {
    const bad = isPaperExchange(a.exchange) ? null : ticketRules(t);
    if (bad) throw new TradingError('INVALID', bad);
    // FD-FXCOMMODITIES: a pair or a commodity of the charts only on eToro (forex) or a stocks Paper Trading profile.
    if (fxKindOf(t.symbol)) {
      if (a.kind !== 'stocks') throw new TradingError('INVALID', FX_ACCOUNT_TEXT);
      if (!isPaperExchange(a.exchange) && a.exchange !== 'etoro') throw new TradingError('INVALID', FX_ACCOUNT_TEXT);
    }
  }

  async preview(userId: number, ticket: OrderTicket): Promise<OrderPreview> {
    const a = await this.access(userId, ticket.accountId, true, ticket.market);
    this.rules(a, ticket);
    const p = await this.trader(a).normalize(ticket);
    return { ...p, env: a.env };
  }

  /** The journal row of a form already sent, if any (claimed in a transaction: two sends at once, one order). */
  private async claim(userId: number, a: TradingAccess, t: OrderTicket): Promise<{ existing: LogRow } | { id: number }> {
    const select = () => this.db.get<LogRow>('SELECT * FROM trade_log WITH (UPDLOCK, HOLDLOCK) WHERE user_id = ? AND idem_key = ?', [userId, t.idemKey]);
    try {
      return await this.db.tx(async () => {
        const existing = await select();
        if (existing) return { existing };
        const id = await this.journal(
          userId,
          a,
          { action: 'order', status: 'pending', market: t.market, symbol: t.symbol, side: t.side, kind: t.kind, amount: t.amount, price: t.price ?? null, trigger_price: t.triggerPrice ?? null, leverage: t.leverage ?? null },
          t.idemKey,
        );
        return { id };
      });
    } catch (err) {
      // The unique index caught a send that raced past the check: that one is the order.
      const existing = await this.db.get<LogRow>('SELECT * FROM trade_log WHERE user_id = ? AND idem_key = ?', [userId, t.idemKey]);
      if (existing) return { existing };
      throw err;
    }
  }

  /** The answer to a form sent again: the first one's result (it stays bound to the key only when sent or unknown). */
  private fromLog(r: LogRow): OrderResult {
    if (r.status === 'pending') {
      // Cut off mid-send (a restart): nobody knows whether it reached the platform.
      if (this.now() - r.created_at > PENDING_STALE_MS) throw new TradingError('UNKNOWN_OUTCOME', 'Trimiterea acestui ordin a fost întreruptă: nu știm sigur dacă a ajuns. Verifică ordinele deschise înainte să-l trimiți din nou.');
      throw new TradingError('IN_PROGRESS', 'Ordinul acesta e deja în curs de trimitere.');
    }
    if (r.status === 'unknown') throw new TradingError('UNKNOWN_OUTCOME', r.message ?? 'Nu știm sigur dacă ordinul a ajuns.');
    let result: OrderResult | undefined;
    try {
      result = (JSON.parse(r.detail ?? '{}') as { result?: OrderResult }).result;
    } catch {
      result = undefined;
    }
    return { status: result?.status ?? 'sent', orderId: r.order_id, message: 'Ordinul fusese deja trimis (o a doua trimitere a aceluiași formular nu face alt ordin).', followUps: result?.followUps ?? [] };
  }

  /** Sends an order once (FD-TRADING §3, §6). */
  async place(userId: number, ticket: OrderTicket): Promise<OrderResult> {
    const a = await this.access(userId, ticket.accountId, true, ticket.market);
    this.rules(a, ticket);
    this.throttle(userId);
    const claimed = await this.claim(userId, a, ticket);
    if ('existing' in claimed) return this.fromLog(claimed.existing);
    const logId = claimed.id;
    const trader = this.trader(a);
    let preview: OrderPreview;
    try {
      preview = await trader.normalize(ticket);
    } catch (err) {
      await this.settle(logId, 'error', { message: (err as Error).message });
      throw err;
    }
    if (preview.errors.length) {
      await this.settle(logId, 'rejected', { message: preview.errors.join(' '), preview });
      throw new TradingError('INVALID', preview.errors.join(' '));
    }
    try {
      const result = await trader.place(preview);
      const status = result.status === 'rejected' ? 'rejected' : 'sent';
      await this.settle(logId, status, { order_id: result.orderId, message: result.message, detail: JSON.stringify({ ticket: preview.ticket, amount: preview.amount, contracts: preview.contracts, result }), preview });
      return result;
    } catch (caught) {
      // A key without the right: the platform's own steps to add it (FD-TRADING §7).
      const steps = TRADING[a.exchange as keyof typeof TRADING]?.tradeSteps ?? [];
      const err = caught instanceof TradingError && caught.code === 'PERMISSION' && steps.length ? new TradingError('PERMISSION', `${caught.message} ${steps.join(' ')}`) : caught;
      const unknown = err instanceof TradingError && err.code === 'UNKNOWN_OUTCOME';
      await this.settle(logId, unknown ? 'unknown' : 'error', { message: (err as Error).message, detail: JSON.stringify({ ticket: preview.ticket, amount: preview.amount }), preview });
      throw err;
    } finally {
      this.accounts.invalidate(a.id);
    }
  }

  /** FIX-BOT24: an instrument's price now at the platform (eToro); null where the platform cannot give it. */
  /** FIX-ETOROLIMIT: whether the account's platform has a symbol (a bot's check); the instrument read where it cannot tell. */
  async known(userId: number, accountId: number, market: TradeMarket, symbol: string): Promise<void> {
    const a = await this.access(userId, accountId, true, market);
    const t = this.trader(a);
    if (t.known) await t.known(symbol);
    else await t.instrument(market, symbol);
  }

  async price(userId: number, accountId: number, symbol: string): Promise<number | null> {
    const a = await this.access(userId, accountId, false);
    const t = this.trader(a);
    return t.price ? t.price(symbol) : null;
  }

  /** FIX-ETOROPENDING: an order's state now at the platform (eToro); null where the platform cannot be asked. */
  async orderState(userId: number, accountId: number, orderId: string): Promise<{ status: OrderResult['status']; message: string | null } | null> {
    const a = await this.access(userId, accountId, false);
    const t = this.trader(a);
    return t.lookup ? t.lookup(orderId) : null;
  }

  /**
   * FIX-ETOROPENDING: the last opening sent from Sentiq on an account's symbol and side since a moment, as its log keeps
   * it (a bot's wait from before the order's id was kept).
   */
  async openingSince(userId: number, accountId: number, symbol: string, side: 'buy' | 'sell', since: number): Promise<{ status: string; orderId: string | null; message: string | null } | null> {
    const rows = await this.db.all<{ status: string; order_id: string | null; message: string | null; detail: string | null }>(
      "SELECT TOP (5) status, order_id, message, CAST(detail AS NVARCHAR(MAX)) AS detail FROM trade_log WHERE user_id = ? AND account_id = ? AND symbol = ? AND side = ? AND action = N'order' AND created_at >= ? ORDER BY id DESC",
      [userId, accountId, symbol, side, since],
    );
    for (const r of rows) {
      const closes = (() => {
        try {
          return Boolean((JSON.parse(r.detail ?? 'null') as { ticket?: { close?: unknown } } | null)?.ticket?.close);
        } catch {
          return false;
        }
      })();
      if (!closes) return { status: r.status, orderId: r.order_id, message: r.message };
    }
    return null;
  }

  async cancel(userId: number, accountId: number, input: CancelInput): Promise<OrderResult> {
    const probe = await this.access(userId, accountId, false);
    // A broker's orders are on its one market (`stock`), whatever row they show in; a perpetual's (BTC/USDT:USDT) are
    // futures, even where the account lists them with the spot ones (KuCoin's unified account).
    const market: TradeMarket = actionMarket(probe, input.symbol, input.market);
    const a = await this.access(userId, accountId, true, market);
    input = { ...input, market };
    this.throttle(userId);
    const logId = await this.journal(userId, a, { action: 'cancel', status: 'pending', market: input.market, symbol: input.symbol, order_id: input.orderId });
    try {
      const r = await this.trader(a).cancel(input);
      await this.settle(logId, 'sent', { message: r.message });
      // FIX-SLTPDUP: gone from the chart now, even while the platform still lists it for a moment.
      if (r.status !== 'rejected') this.accounts.forgetOrders(a.id, [input.orderId]);
      return r;
    } catch (err) {
      await this.settle(logId, 'error', { message: (err as Error).message });
      throw err;
    } finally {
      this.accounts.invalidate(a.id);
    }
  }

  // ---------------- FD-ORDEREDIT ----------------

  /** A broker's orders are on its one market (`stock`); a perpetual's are futures wherever it is listed. */
  private async modifyAccess(userId: number, t: ModifyTicket): Promise<{ a: TradingAccess; ticket: ModifyTicket }> {
    const probe = await this.access(userId, t.accountId, false);
    const market: TradeMarket = actionMarket(probe, t.symbol, t.market);
    return { a: await this.access(userId, t.accountId, true, market), ticket: { ...t, market } };
  }

  /** The changes checked and planned (nothing sent). */
  async previewModify(userId: number, t: ModifyTicket): Promise<ModifyPreview> {
    const { a, ticket } = await this.modifyAccess(userId, t);
    const plan = await this.trader(a).normalizeModify(ticket);
    return { ...plan.preview, env: a.env };
  }

  /**
   * One action of several orders (FD-ORDEREDIT, FD-REVERSE) claimed by its form key: a new journal row, or the first
   * sending's answer (its result; in progress; cut off: unknown).
   */
  private async claimAction(userId: number, a: TradingAccess, idemKey: string, row: Partial<Omit<LogRow, 'id'>> & Pick<LogRow, 'action'>): Promise<{ result: ModifyResult } | { id: number }> {
    const select = () => this.db.get<LogRow>('SELECT * FROM trade_log WITH (UPDLOCK, HOLDLOCK) WHERE user_id = ? AND idem_key = ?', [userId, idemKey]);
    let claimed: { existing: LogRow } | { id: number };
    try {
      claimed = await this.db.tx(async () => {
        const existing = await select();
        if (existing) return { existing };
        return { id: await this.journal(userId, a, { ...row, status: 'pending' }, idemKey) };
      });
    } catch (err) {
      const existing = await this.db.get<LogRow>('SELECT * FROM trade_log WHERE user_id = ? AND idem_key = ?', [userId, idemKey]);
      if (!existing) throw err;
      claimed = { existing };
    }
    if ('id' in claimed) return claimed;
    const r = claimed.existing;
    if (r.status === 'pending') {
      if (this.now() - r.created_at > PENDING_STALE_MS) throw new TradingError('UNKNOWN_OUTCOME', 'Trimiterea a fost întreruptă: nu știm sigur ce a ajuns. Verifică pozițiile și ordinele deschise înainte să trimiți din nou.');
      throw new TradingError('IN_PROGRESS', 'Acțiunea aceasta e deja în curs de trimitere.');
    }
    try {
      const prev = (JSON.parse(r.detail ?? '{}') as { result?: ModifyResult }).result;
      if (prev) return { result: prev };
    } catch {
      // fall through
    }
    throw new TradingError('UNKNOWN_OUTCOME', r.message ?? 'Nu știm sigur ce a ajuns.');
  }

  /** Sends the changes once (the form's key in the journal), checked again first. */
  async modify(userId: number, t: ModifyTicket): Promise<ModifyResult> {
    const { a, ticket } = await this.modifyAccess(userId, t);
    this.throttle(userId);
    const claimed = await this.claimAction(userId, a, ticket.idemKey, { action: 'modify', market: ticket.market, symbol: ticket.symbol, message: `${ticket.changes.length} schimbări` });
    if ('result' in claimed) return claimed.result;
    const logId = claimed.id;
    const trader = this.trader(a);
    let plan;
    try {
      plan = await trader.normalizeModify(ticket);
    } catch (err) {
      await this.settle(logId, 'error', { message: (err as Error).message });
      throw err;
    }
    if (plan.preview.errors.length) {
      await this.settle(logId, 'rejected', { message: plan.preview.errors.join(' ') });
      throw new TradingError('INVALID', plan.preview.errors.join(' '));
    }
    try {
      const result = await trader.modify(plan);
      this.accounts.forgetOrders(a.id, cancelledBy(result));
      const status = result.status === 'unknown' ? 'unknown' : result.status === 'failed' ? 'error' : 'sent';
      const message = result.steps.map((s) => `${s.what}${s.ok ? '' : ` (${s.message ?? 'eșuat'})`}`).join('; ');
      await this.settle(logId, status, { order_id: result.steps.find((s) => s.ok && s.orderId)?.orderId ?? null, message, detail: JSON.stringify({ steps: plan.preview.steps, result }) });
      return result;
    } catch (err) {
      const unknown = err instanceof TradingError && err.code === 'UNKNOWN_OUTCOME';
      await this.settle(logId, unknown ? 'unknown' : 'error', { message: (err as Error).message, detail: JSON.stringify({ steps: plan.preview.steps }) });
      throw err;
    } finally {
      this.accounts.invalidate(a.id);
    }
  }

  // ---------------- FD-REVERSE ----------------

  /** A reversal is of a futures position, where the platform can (crypto). */
  private async reverseAccess(userId: number, t: ReverseTicket): Promise<{ a: TradingAccess; trader: Trader & Required<Pick<Trader, 'normalizeReverse' | 'reverse'>> }> {
    // FD-PAPER: a profile turns its positions on every market (FIX-PAPERLEV: spot too).
    const probe = await this.access(userId, t.accountId, false);
    const market: TradeMarket = isPaperExchange(probe.exchange) ? actionMarket(probe, t.symbol, 'spot') : 'futures';
    const a = await this.access(userId, t.accountId, true, market);
    const trader = this.trader(a);
    if (!trader.normalizeReverse || !trader.reverse) throw new TradingError('UNSUPPORTED', 'Întoarcerea poziției se face doar pe futures crypto.');
    return { a, trader: trader as Trader & Required<Pick<Trader, 'normalizeReverse' | 'reverse'>> };
  }

  /** The reversal checked and planned (nothing sent). */
  async previewReverse(userId: number, t: ReverseTicket): Promise<ReversePreview> {
    const { a, trader } = await this.reverseAccess(userId, t);
    const plan = await trader.normalizeReverse(t);
    return { ...plan.preview, env: a.env };
  }

  /** Turns the position once (the confirmation's key in the journal), checked again first. */
  async reverse(userId: number, t: ReverseTicket): Promise<ModifyResult> {
    const { a, trader } = await this.reverseAccess(userId, t);
    this.throttle(userId);
    const claimed = await this.claimAction(userId, a, t.idemKey, { action: 'reverse', market: 'futures', symbol: t.symbol, side: t.side === 'long' ? 'sell' : 'buy', message: `${t.side} → ${t.side === 'long' ? 'short' : 'long'}` });
    if ('result' in claimed) return claimed.result;
    const logId = claimed.id;
    let plan;
    try {
      plan = await trader.normalizeReverse(t);
    } catch (err) {
      await this.settle(logId, 'error', { message: (err as Error).message });
      throw err;
    }
    if (plan.preview.errors.length) {
      await this.settle(logId, 'rejected', { message: plan.preview.errors.join(' ') });
      throw new TradingError('INVALID', plan.preview.errors.join(' '));
    }
    try {
      const result = await trader.reverse(plan);
      this.accounts.forgetOrders(a.id, cancelledBy(result));
      const status = result.status === 'unknown' ? 'unknown' : result.status === 'failed' ? 'error' : 'sent';
      const message = result.steps.map((s) => `${s.what}${s.ok ? '' : ` (${s.message ?? 'eșuat'})`}`).join('; ');
      await this.settle(logId, status, { order_id: result.steps.find((s) => s.ok && s.orderId)?.orderId ?? null, message, detail: JSON.stringify({ preview: plan.preview, result }) });
      return result;
    } catch (err) {
      const unknown = err instanceof TradingError && err.code === 'UNKNOWN_OUTCOME';
      await this.settle(logId, unknown ? 'unknown' : 'error', { message: (err as Error).message });
      throw err;
    } finally {
      this.accounts.invalidate(a.id);
    }
  }

  async journalOf(userId: number): Promise<TradeLogRow[]> {
    return (await this.db.all<LogRow>(`SELECT TOP (${LOG_LIMIT}) * FROM trade_log WHERE user_id = ? ORDER BY created_at DESC, id DESC`, [userId])).map(toLogRow);
  }

  /**
   * FIX-TRADESOLD: the orders and the SL / TP changes sent from Sentiq on one of the user's accounts since `since` and
   * accepted, oldest first (at most 5000), for the trade history.
   */
  async sentFor(userId: number, accountId: number, since: number): Promise<JournalEntry[]> {
    const rows = await this.db.all<JournalRow>(
      "SELECT TOP (5000) action, created_at, symbol, market, side, leverage, detail FROM trade_log WHERE user_id = ? AND account_id = ? AND status = N'sent' AND action IN (N'order', N'modify') AND created_at >= ? ORDER BY created_at, id",
      [userId, accountId, since],
    );
    return rows.map(journalEntry).filter((e): e is JournalEntry => e !== null);
  }
}
