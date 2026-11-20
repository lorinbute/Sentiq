// FD-PUSH, TD-PUSH: notifications on the user's iPhone / iPad (APNs): a bot's trades opened and closed (each bot's bell),
// and an order's position closed by its own stop loss / take profit (or a liquidation; the order form's bell). The
// devices are the user's (every device signed in to the account gets them).
import type { Db } from '../db/database.ts';
import type { Logger } from '../log.ts';
import type { AccountsService } from '../exchange/accounts.ts';
import type { BotEventDetail, BotEventKind, BotTradeReason } from '../../shared/bot.ts';
import type { ClosedTrade } from '../bots/state.ts';
import type { BotRow } from '../bots/engine.ts';
import type { OrderResult, OrderTicket } from '../../shared/trading.ts';
import { symbolKey } from '../exchange/trade-history.ts';
import { HISTORY } from '../exchange/trade-stats.ts';
import { isPaperExchange } from '../../shared/providers.ts';
import { BROKER_IDS } from '../exchange/brokers.ts';
import { num, price as fmtPrice, signed } from '../bots/format.ts';
import { fxSymbolOf } from '../../shared/fx.ts';
import { Apns, type ApnsEnv } from './apns.ts';
import { ValidationError } from '../settings.ts';

export interface PushNote {
  title: string;
  body: string;
  /** The site's path the app opens on a tap (/bots/12, /trades). */
  link: string;
  /** The coin or share whose logo the notification shows (BTC, NVDA); the app's extension fetches it. */
  logo: string | null;
  /** FD-STOCKLOGOS: the logo is a company's (a share): the extension asks for its logo, not a coin's with the ticker. */
  logoKind?: 'stock';
  /** Notifications of one thread are grouped on the device (a bot's, an account's). */
  thread: string;
}

interface WatchRow {
  id: number;
  user_id: number;
  account_id: number;
  market: string;
  symbol: string;
  side: 'long' | 'short';
  sl: number | null;
  tp: number | null;
  created_at: number;
  checked_at: number | null;
  seen_open: boolean | number;
}

/** A closed position as the platform's history (or the profile's book) tells it. */
interface Close {
  exit: number | null;
  pnl: number | null;
  pnlPct: number | null;
  currency: string;
  closedAt: number;
  /** What the history says it was: a stop loss / take profit (Paper knows), a liquidation, or nothing. */
  reason: 'sl' | 'tp' | 'liquidation' | 'manual' | null;
}

const MIN = 60_000;
/** A watch nobody's position closed in this long ends (a limit order never filled, a position kept for months). */
const WATCH_DAYS = 45;
/** How far from its level an exit still counts as that level's (a stop loss slips more than a take profit). */
const TP_SLACK = 0.01;
const SL_SLACK = 0.03;
/** A broker's history is read again at most this often per account (its position list says nothing of the levels). */
const BROKER_EVERY_MS = 2 * MIN;

const REASONS: Record<BotTradeReason, string> = {
  tp: 'take profit',
  sl: 'stop loss',
  tp_signal: 'semnal de ieșire',
  flip: 'semnal opus',
  opposite: 'semnal opus',
  grid: 'grilă',
  end: 'botul s-a încheiat',
  stop: 'botul a fost oprit',
  liquidation: 'lichidare',
  external: 'închisă din afara botului',
  loss_limit: 'limita de pierdere',
  grid_stop: 'stop-ul grilei',
  edit: 'setări schimbate',
};

/** BTC/USDT:USDT → BTC/USDT; a share stays itself. */
const shown = (symbol: string) => symbol.split(':')[0] ?? symbol;
/** The coin or share of a symbol (BTC/USDT → BTC, NVDA → NVDA). */
const baseOf = (symbol: string) => (shown(symbol).split('/')[0] ?? symbol).toUpperCase();
/** The money of a pair (BTC/USDT → USDT); a share's: USD. */
const quoteOf = (symbol: string) => shown(symbol).split('/')[1]?.toUpperCase() ?? 'USD';

const sideWord = (s: string | null | undefined) => (s === 'short' || s === 'sell' ? 'SHORT' : 'LONG');
const isBroker = (exchange: string) => (BROKER_IDS as readonly string[]).includes(exchange);

/** FD-PUSH: where a closed position's notification leads: its account's history of trades (the app opens it). */
export const tradeHistoryLink = (accountId: number): string => `/trades#history-${accountId}`;
const pct = (v: number) => `${v >= 0 ? '+' : '−'}${num(Math.abs(v), 2, 1)}%`;

export class PushService {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly apns: Apns | null;
  private readonly accounts: AccountsService;
  private readonly now: () => number;
  private warnedOff = false;
  private readonly brokerReadAt = new Map<number, number>();

  constructor(deps: { db: Db; log: Logger; apns: Apns | null; accounts: AccountsService; now?: () => number }) {
    this.db = deps.db;
    this.log = deps.log;
    this.apns = deps.apns;
    this.accounts = deps.accounts;
    this.now = deps.now ?? Date.now;
  }

  // ── Devices ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The device's token, for the signed-in user (a device that changed accounts gets the new one's only). */
  async register(userId: number, token: string, env: ApnsEnv): Promise<void> {
    const t = token.trim().toLowerCase();
    if (!/^[0-9a-f]{32,200}$/.test(t)) throw new ValidationError('Tokenul dispozitivului e invalid.');
    const now = this.now();
    await this.db.tx(async () => {
      const had = await this.db.get<{ id: number }>('SELECT id FROM push_devices WITH (UPDLOCK, HOLDLOCK) WHERE token = ?', [t]);
      if (had) await this.db.run('UPDATE push_devices SET user_id = ?, env = ?, updated_at = ? WHERE id = ?', [userId, env, now, had.id]);
      else await this.db.run('INSERT INTO push_devices(user_id, token, env, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [userId, t, env, now, now]);
    });
  }

  /** Signed out on the device: it gets nothing more. */
  async unregister(userId: number, token: string): Promise<void> {
    await this.db.run('DELETE FROM push_devices WHERE user_id = ? AND token = ?', [userId, token.trim().toLowerCase()]);
  }

  /** One notification on every device of the user. */
  async send(userId: number, note: PushNote): Promise<void> {
    if (!this.apns) {
      if (!this.warnedOff) this.log.warn('push: APNS_KEY_ID / APNS_KEY are not set; notifications are not sent');
      this.warnedOff = true;
      return;
    }
    const devices = await this.db.all<{ id: number; token: string; env: ApnsEnv }>('SELECT id, token, env FROM push_devices WHERE user_id = ?', [userId]);
    const payload = {
      aps: { alert: { title: note.title, body: note.body }, sound: 'default', 'mutable-content': 1, 'thread-id': note.thread },
      link: note.link,
      ...(note.logo ? { logo: note.logo } : {}),
      ...(note.logo && note.logoKind ? { logoKind: note.logoKind } : {}),
    };
    for (const d of devices) {
      let r = await this.apns.send(d.env, d.token, payload);
      if (!r.ok && r.wrongEnv) {
        // A token of the other service (a development build, or one from the App Store): tried there, then kept there.
        const other: ApnsEnv = d.env === 'production' ? 'sandbox' : 'production';
        r = await this.apns.send(other, d.token, payload);
        if (r.ok) await this.db.run('UPDATE push_devices SET env = ? WHERE id = ?', [other, d.id]);
      }
      if (r.ok) continue;
      if (r.gone || r.wrongEnv) {
        await this.db.run('DELETE FROM push_devices WHERE id = ?', [d.id]);
        this.log.info(`push: device ${d.id} of user ${userId} forgotten (${r.reason || r.status})`);
      } else {
        this.log.warn(`push: not delivered to device ${d.id} of user ${userId}: ${r.status} ${r.reason}`);
      }
    }
  }

  // ── Bots ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The bot's bell (its owner's only). */
  async setBotNotify(userId: number, botId: number, on: boolean): Promise<{ notify: boolean }> {
    const r = await this.db.run('UPDATE bots SET notify = ? WHERE id = ? AND user_id = ?', [on ? 1 : 0, botId, userId]);
    if (!r.changes) throw new ValidationError('Botul nu există.');
    return { notify: on };
  }

  /**
   * After a bot's look: what it opened (its `enter` notes) and closed (its trades), on its owner's devices when its bell
   * is on. More than three of a kind in one look become one notification (a grid filling several lines).
   */
  async botRan(row: BotRow & { notify?: boolean | number | null }, events: { kind: BotEventKind; symbol: string | null; message: string; detail: BotEventDetail | null }[], trades: ClosedTrade[]): Promise<void> {
    if (!row.notify) return;
    const opens = events.filter((e) => e.kind === 'enter' && e.symbol);
    const notes: PushNote[] = [];
    const base = { link: `/bots/${row.id}`, thread: `bot-${row.id}`, ...(row.area === 'stocks' ? { logoKind: 'stock' as const } : {}) };
    const name = `„${row.name}”`;
    if (opens.length > 3) {
      notes.push({ ...base, title: `${name} a deschis ${opens.length} poziții`, body: [...new Set(opens.map((e) => shown(e.symbol!)))].join(', '), logo: baseOf(opens[0]!.symbol!) });
    } else {
      for (const e of opens) {
        const d = e.detail ?? {};
        const sym = e.symbol!;
        // FIX-PUSHMARGIN (the user: „pe mine mă interesează la un trade ce sumă din bugetul meu e cheltuită, nu valoarea
        // tranzacției… notificarea trebuie să pună valoarea din buget, suma folosită la trade și levierul”): the sum taken
        // from the budget (the margin) and the leverage; never the position's value. Not the budget itself (the user: „nu
        // e loc de ea”).
        const lev = d.leverage !== undefined && d.leverage > 0 ? d.leverage : 1;
        const used = d.margin !== undefined ? d.margin : d.qty !== undefined && d.price !== undefined ? (d.qty * d.price) / lev : null;
        const cur = quoteOf(sym);
        const parts = [
          `${d.side ? `${sideWord(d.side)} ` : ''}${shown(sym)}`,
          used !== null ? `${num(used, 2, 2)} ${cur}` : null,
          `levier ${num(lev, 0)}×`,
          d.price !== undefined ? `la ${fmtPrice(d.price, fxSymbolOf(sym) !== null)}` : null,
        ];
        notes.push({ ...base, title: `${name} a deschis o poziție`, body: parts.filter(Boolean).join(' · '), logo: baseOf(sym) });
      }
    }
    if (trades.length > 3) {
      const total = trades.reduce((s, t) => s + t.pnl, 0);
      notes.push({ ...base, title: `${name} a închis ${trades.length} poziții`, body: `P&L total ${signed(total)} ${quoteOf(trades[0]!.symbol)}`, logo: baseOf(trades[0]!.symbol) });
    } else {
      for (const t of trades) {
        const margin = t.lev > 0 ? (t.entry * t.qty) / t.lev : 0;
        const parts = [
          `${sideWord(t.side)} ${shown(t.symbol)}`,
          `P&L ${signed(t.pnl)} ${quoteOf(t.symbol)}${margin > 0 ? ` (${pct((t.pnl / margin) * 100)})` : ''}`,
          REASONS[t.reason] ?? null,
        ];
        notes.push({ ...base, title: `${name} a închis o poziție`, body: parts.filter(Boolean).join(' · '), logo: baseOf(t.symbol) });
      }
    }
    for (const n of notes) await this.send(row.user_id, n);
  }

  // ── Orders: a position closed by its stop loss / take profit ────────────────────────────────────────────────────

  /**
   * An order just placed with the form's bell on: its position is watched until it closes. Only an opening order with a
   * stop loss or a take profit (nothing to tell otherwise).
   */
  async watch(userId: number, ticket: OrderTicket & { notify?: boolean }, result: OrderResult): Promise<boolean> {
    if (!ticket.notify || ticket.reduceOnly || ticket.close) return false;
    if (result.status === 'rejected' || result.status === 'cancelled') return false;
    const sl = ticket.stopLoss ?? null;
    const tp = ticket.takeProfit ?? null;
    if (sl === null && tp === null) return false;
    await this.keep(userId, { accountId: ticket.accountId, market: ticket.market, symbol: ticket.symbol, side: ticket.side === 'sell' ? 'short' : 'long', sl, tp, idemKey: ticket.idemKey, seenOpen: false });
    return true;
  }

  /** One open watch per position (account, pair, side): a new bell on a watched position takes its levels. */
  private async keep(userId: number, w: { accountId: number; market: string; symbol: string; side: 'long' | 'short'; sl: number | null; tp: number | null; idemKey: string | null; seenOpen: boolean }): Promise<void> {
    const open = await this.db.all<{ id: number; symbol: string }>("SELECT id, symbol FROM trade_watches WHERE user_id = ? AND account_id = ? AND side = ? AND state = N'open'", [userId, w.accountId, w.side]);
    const same = open.find((x) => symbolKey(x.symbol) === symbolKey(w.symbol));
    if (same) {
      await this.db.run('UPDATE trade_watches SET sl = ?, tp = ?, seen_open = CASE WHEN ? = 1 THEN 1 ELSE seen_open END WHERE id = ?', [w.sl, w.tp, w.seenOpen ? 1 : 0, same.id]);
      return;
    }
    await this.db.run(
      "INSERT INTO trade_watches(user_id, account_id, idem_key, market, symbol, side, sl, tp, state, seen_open, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, N'open', ?, ?)",
      [userId, w.accountId, w.idemKey, w.market, w.symbol, w.side, w.sl, w.tp, w.seenOpen ? 1 : 0, this.now()],
    );
  }

  /** The positions of an account watched now (the app's bells on its positions). */
  async watches(userId: number, accountId: number): Promise<{ symbol: string; side: 'long' | 'short'; sl: number | null; tp: number | null }[]> {
    return this.db.all("SELECT symbol, side, sl, tp FROM trade_watches WHERE user_id = ? AND account_id = ? AND state = N'open' ORDER BY id", [userId, accountId]);
  }

  /**
   * An open position's bell (FD-PUSH, after the order): watched from now with the levels it has, until its stop loss /
   * take profit closes it. Nothing to tell without one.
   */
  async watchPosition(userId: number, w: { accountId: number; market: string; symbol: string; side: 'long' | 'short'; sl: number | null; tp: number | null }): Promise<void> {
    if (w.sl === null && w.tp === null) throw new ValidationError('Poziția nu are stop loss sau take profit: nu e nimic de anunțat.');
    await this.keep(userId, { ...w, idemKey: null, seenOpen: true });
  }

  /** The bell turned off: the position is no longer watched. */
  async unwatchPosition(userId: number, accountId: number, symbol: string, side: 'long' | 'short'): Promise<void> {
    const open = await this.db.all<{ id: number; symbol: string }>("SELECT id, symbol FROM trade_watches WHERE user_id = ? AND account_id = ? AND side = ? AND state = N'open'", [userId, accountId, side]);
    for (const x of open.filter((o) => symbolKey(o.symbol) === symbolKey(symbol))) {
      await this.db.run("UPDATE trade_watches SET state = N'cancelled', ended_at = ? WHERE id = ?", [this.now(), x.id]);
    }
  }

  /** The position's stop loss / take profit changed from Sentiq: the watch compares the exit with the new levels. */
  async levelsChanged(userId: number, accountId: number, symbol: string, change: { sl?: number | null; tp?: number | null }): Promise<void> {
    const sets: string[] = [];
    const args: (number | null)[] = [];
    if (change.sl !== undefined) {
      sets.push('sl = ?');
      args.push(change.sl);
    }
    if (change.tp !== undefined) {
      sets.push('tp = ?');
      args.push(change.tp);
    }
    if (!sets.length) return;
    const rows = await this.db.all<{ id: number; symbol: string }>("SELECT id, symbol FROM trade_watches WHERE user_id = ? AND account_id = ? AND state = N'open'", [userId, accountId]);
    for (const r of rows.filter((w) => symbolKey(w.symbol) === symbolKey(symbol))) {
      await this.db.run(`UPDATE trade_watches SET ${sets.join(', ')} WHERE id = ?`, [...args, r.id]);
    }
  }

  /** The `push.watches` job: every open watch looked at (a position still open waits; a closed one tells or ends). */
  async checkWatches(signal?: AbortSignal): Promise<void> {
    const rows = await this.db.all<WatchRow>("SELECT * FROM trade_watches WHERE state = N'open' ORDER BY account_id, id");
    const byAccount = new Map<number, WatchRow[]>();
    for (const w of rows) byAccount.set(w.account_id, [...(byAccount.get(w.account_id) ?? []), w]);
    for (const [accountId, list] of byAccount) {
      if (signal?.aborted) return;
      try {
        await this.checkAccount(accountId, list);
      } catch (err) {
        this.log.warn(`push: watches of account ${accountId}: ${(err as Error).message}`);
      }
    }
  }

  private async end(w: WatchRow, state: 'done' | 'manual' | 'expired' | 'gone', result: unknown = null): Promise<void> {
    await this.db.run('UPDATE trade_watches SET state = ?, ended_at = ?, result = ? WHERE id = ?', [state, this.now(), result === null ? null : JSON.stringify(result).slice(0, 2000), w.id]);
  }

  private async checkAccount(accountId: number, list: WatchRow[]): Promise<void> {
    const now = this.now();
    const acc = await this.db.get<{ id: number; exchange: string }>('SELECT id, exchange FROM exchange_accounts WHERE id = ?', [accountId]);
    for (const w of list) {
      if (!acc) await this.end(w, 'gone');
      else if (now - w.created_at > WATCH_DAYS * 86_400_000) await this.end(w, 'expired');
    }
    if (!acc) return;
    const open = list.filter((w) => now - w.created_at <= WATCH_DAYS * 86_400_000);
    if (!open.length) return;
    if (isPaperExchange(acc.exchange)) {
      for (const w of open) await this.checkPaper(w);
      return;
    }
    if (isBroker(acc.exchange)) {
      // A broker: its history of closed trades (read at most every two minutes per account).
      if (now - (this.brokerReadAt.get(accountId) ?? 0) < BROKER_EVERY_MS) return;
      this.brokerReadAt.set(accountId, now);
      const h = await this.accounts.tradeHistory(accountId, '7d', 'UTC', true);
      if (h.error || !h.supported) return;
      for (const w of open) {
        const row = h.rows
          .filter((r) => !r.open && r.source === 'account' && r.closedAt !== null && r.closedAt >= w.created_at - MIN && symbolKey(r.symbol, true) === symbolKey(w.symbol, true))
          .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))[0];
        if (row) await this.closed(w, { exit: row.exit, pnl: row.pnl, pnlPct: row.pnlPct, currency: row.currency, closedAt: row.closedAt!, reason: liquidation(row.reason) });
      }
      return;
    }
    // A crypto exchange: the position still open waits; gone, its close is read from the history (or the fills).
    const p = await this.accounts.portfolio(accountId);
    if (p.errors.positions) return;
    const gone: WatchRow[] = [];
    for (const w of open) {
      const still = p.positions.some((x) => symbolKey(x.symbol) === symbolKey(w.symbol) && sideOf(x.side) === w.side && Math.abs(x.contracts || x.size || 0) > 0);
      if (still) {
        if (!w.seen_open) await this.db.run('UPDATE trade_watches SET seen_open = 1, checked_at = ? WHERE id = ?', [now, w.id]);
        continue;
      }
      // Never seen open: an order still waiting to fill (its order is listed) waits too.
      if (!w.seen_open && p.orders.some((o) => symbolKey(o.symbol) === symbolKey(w.symbol))) continue;
      gone.push(w);
    }
    if (!gone.length) return;
    if (HISTORY[acc.exchange]) {
      const h = await this.accounts.tradeHistory(accountId, '7d', 'UTC', true);
      if (h.error) return;
      for (const w of gone) {
        const row = h.rows
          .filter((r) => !r.open && r.closedAt !== null && r.closedAt >= w.created_at - MIN && symbolKey(r.symbol) === symbolKey(w.symbol) && (r.side === null || r.side === w.side))
          .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))[0];
        if (row) await this.closed(w, { exit: row.exit, pnl: row.pnl, pnlPct: row.pnlPct, currency: row.currency, closedAt: row.closedAt!, reason: liquidation(row.reason) });
        else if (now - w.created_at > 30 * MIN && !w.seen_open) await this.end(w, 'manual', { why: 'never filled' });
      }
      return;
    }
    // Binance (no history of closed positions): the closing fills since the order, with the result they realized.
    for (const w of gone) {
      const fills = await this.accounts.closingFills(accountId, w.symbol, w.side, w.created_at - MIN);
      if (!fills.length) {
        if (now - w.created_at > 30 * MIN && !w.seen_open) await this.end(w, 'manual', { why: 'never filled' });
        continue;
      }
      const qty = fills.reduce((s, f) => s + f.qty, 0);
      const exit = qty > 0 ? fills.reduce((s, f) => s + f.price * f.qty, 0) / qty : null;
      const known = fills.filter((f) => f.pnl !== null);
      const pnl = known.length ? known.reduce((s, f) => s + (f.pnl ?? 0) - f.fee, 0) : null;
      await this.closed(w, { exit, pnl, pnlPct: null, currency: quoteOf(w.symbol), closedAt: Math.max(...fills.map((f) => f.at)), reason: null });
    }
  }

  /** A Paper profile: its book says why each position closed. */
  private async checkPaper(w: WatchRow): Promise<void> {
    const t = await this.db.get<{ exit: number; pnl: number; qty: number; entry: number; leverage: number; reason: string; closed_at: number }>(
      'SELECT TOP (1) [exit], pnl, qty, entry, leverage, reason, closed_at FROM paper_trades WHERE account_id = ? AND symbol = ? AND side = ? AND closed_at >= ? ORDER BY closed_at, id',
      [w.account_id, w.symbol, w.side, w.created_at - MIN],
    );
    if (!t) return;
    const margin = t.leverage > 0 ? (t.entry * t.qty) / t.leverage : 0;
    const reason = t.reason === 'sl' || t.reason === 'tp' || t.reason === 'liquidation' ? t.reason : 'manual';
    await this.closed(w, { exit: t.exit, pnl: t.pnl, pnlPct: margin > 0 ? (t.pnl / margin) * 100 : null, currency: quoteOf(w.symbol), closedAt: t.closed_at, reason });
  }

  /**
   * A watched position closed: by its stop loss, take profit or a liquidation, its owner is told; closed by the user
   * (from Sentiq, or anywhere else at another price), the watch ends quietly.
   */
  private async closed(w: WatchRow, c: Close): Promise<void> {
    let kind = c.reason;
    if (kind === null) {
      // Closed from Sentiq's own forms after the order (the opposite side, or a reversal): the user's own close.
      const byHand = await this.db.get<{ id: number }>(
        "SELECT TOP (1) id FROM trade_log WHERE user_id = ? AND account_id = ? AND created_at > ? AND status IN (N'sent', N'unknown') AND ((action = N'order' AND side = ?) OR action = N'reverse') AND symbol = ?",
        [w.user_id, w.account_id, w.created_at, w.side === 'long' ? 'sell' : 'buy', w.symbol],
      );
      kind = byHand ? 'manual' : levelOf(c.exit, w.sl, w.tp);
    }
    if (kind === 'manual' || kind === null) {
      await this.end(w, 'manual', c);
      return;
    }
    const title = `${kind === 'tp' ? 'Take profit' : kind === 'sl' ? 'Stop loss' : 'Lichidare'} · ${shown(w.symbol)}`;
    const body = [
      `${sideWord(w.side)} închis${c.exit !== null ? ` la ${fmtPrice(c.exit, fxSymbolOf(w.symbol) !== null)}` : ''}`,
      c.pnl !== null ? `P&L ${signed(c.pnl)} ${c.currency}${c.pnlPct !== null ? ` (${pct(c.pnlPct)})` : ''}` : null,
    ];
    await this.end(w, 'done', { ...c, kind });
    // A tap opens the trade: the account's history, where it is the newest (18 Nov 2026: „/trades” opened Tranzacții on
    // whichever account was chosen last, often another one).
    await this.send(w.user_id, {
      title,
      body: body.filter(Boolean).join(' · '),
      link: tradeHistoryLink(w.account_id),
      logo: baseOf(w.symbol),
      ...(w.market === 'stock' ? { logoKind: 'stock' as const } : {}),
      thread: `account-${w.account_id}`,
    });
  }
}

/** A history's reason in words (lichidare, ADL) → a liquidation; anything else is not known. */
function liquidation(reason: string | null): 'liquidation' | null {
  return reason && /lichid|adl/i.test(reason) ? 'liquidation' : null;
}

/** ccxt's sides of a position (long / short; a few say buy / sell). */
function sideOf(s: string): 'long' | 'short' {
  return s === 'short' || s === 'sell' ? 'short' : 'long';
}

/** Which level an exit price was: the nearer of the two, within its slack; null: neither (closed by hand elsewhere). */
export function levelOf(exit: number | null, sl: number | null, tp: number | null): 'sl' | 'tp' | null {
  if (exit === null || !(exit > 0)) return null;
  const dTp = tp !== null && tp > 0 ? Math.abs(exit - tp) / tp : Infinity;
  const dSl = sl !== null && sl > 0 ? Math.abs(exit - sl) / sl : Infinity;
  if (dTp <= TP_SLACK && dTp <= dSl) return 'tp';
  if (dSl <= SL_SLACK) return 'sl';
  if (dTp <= TP_SLACK) return 'tp';
  return null;
}
