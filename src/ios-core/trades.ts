// Sentiq.iOS TD-V4-S2 §2: the trades on the chart as the chart page has them (useTradeLines, FD-PNL, FD-TRADEUI,
// FD-ORDEREDIT, FIX-BOTLEVELS, FIX-BOTDRAG, FIX-SLTPDUP): each line with its box, which can be dragged, what its ×
// does, the groups with lines dragged (the change they make), the levels just sent. The levels sent are kept here
// (the engine lives as long as the app) until the platform lists them, at most a minute.
import { fxCompact } from '../shared/fx.ts';
import type { AccountView, Portfolio } from '../shared/api-types.ts';
import type { BotLevel } from '../shared/bot.ts';
import type { ModifyResult, ModifyTicket } from '../shared/trading.ts';
import { PNL_COLORS, tradeLinesOf, type PnlBasis } from '../web/chart/pnl.ts';
import { botLinesOf, onChart, stillHeld, withoutDuplicates } from '../web/chart/bot-lines.ts';
import { anchorOf, botDraftOf, draftGroups, draftTicket, isDraggable, lineActionOf, lineCloses, liveDrafts, sentLevels, withDrafts, withSent, type AccountLine, type Drafts, type SentLevel } from '../web/chart/trade-drafts.ts';
import { chartLineOf, labelText, TRADE_COLORS } from '../web/chart/trade-labels.ts';
import { canReverse } from '../web/chart/reverse.ts';

export interface TradesInput {
  /** "BTC/USDT", or a share's ticker. */
  symbol: string;
  stock: boolean;
  lastPrice: number | null;
  accounts: AccountView[];
  /** By account id. */
  portfolios: Record<string, Portfolio>;
  botLevels: BotLevel[];
  drafts: Drafts;
  now: number;
}

export type TradesArgs = TradesInput &
  (
    | { op: 'lines' }
    | { op: 'action'; id: string }
    | { op: 'sent'; group: string; ticket: Omit<ModifyTicket, 'idemKey'>; result: ModifyResult }
    | { op: 'clearSent' }
  );

let sent: SentLevel[] = [];
let sentSymbol = '';

/** The lines of the accounts that can hold this asset (useTradeLines). */
function linesOf(a: TradesInput): AccountLine[] {
  // FD-FXCOMMODITIES: a pair or a commodity by its compact form on the accounts (EUR/USD → EURUSD, as eToro's).
  const [base = '', quote = 'USDT'] = a.stock ? [fxCompact(a.symbol), 'USD'] : a.symbol.split('/');
  const relevant = a.accounts.filter((x) => (x.kind === 'stocks') === a.stock);
  const several = relevant.length > 1;
  const lines: AccountLine[] = [];
  for (const account of relevant) {
    const d = a.portfolios[String(account.id)];
    if (!d || (d.kind === 'stocks') !== a.stock) continue;
    const r = tradeLinesOf({ base, quote, lastPrice: a.lastPrice, positions: d.positions, balances: d.balances, orders: d.orders, account: several ? account.label : undefined, accountId: account.id, stock: a.stock }, PNL_COLORS);
    for (const l of r.lines) if (l.role !== 'pnl') lines.push({ ...l, account });
  }
  // FIX-BOTLEVELGONE: only while the account still holds the bot's position (a close shows at once).
  const levels = a.botLevels.filter((l) => onChart(l, { base, quote, stock: a.stock }) && relevant.some((x) => x.id === l.accountId) && stillHeld(l, a.portfolios[String(l.accountId)]));
  const named = new Set(levels.map((l) => l.bot.id)).size > 1;
  const botLines: AccountLine[] = [];
  for (const account of relevant) {
    for (const l of botLinesOf(levels, { base, quote, stock: a.stock, accountId: account.id, account: several ? account.label : undefined }, PNL_COLORS, named)) botLines.push({ ...l, account });
  }
  lines.push(...withoutDuplicates(botLines, lines));
  return lines;
}

export interface LineOut {
  id: string;
  group: string;
  role: string;
  accountId: number;
  accountLabel: string;
  price: number;
  color: string;
  axisLabelColor?: string;
  style: 'solid' | 'dashed' | 'dotted';
  draggable: boolean;
  /** A position's SL / TP from its entry (the shaded zone while dragged). */
  zoneFrom?: number;
  label: { qty: string | null; text: string; textColor: string; close: boolean; fill: boolean; pending?: boolean };
  /** For the PnL at another level (the app's `Pnl.atLevel`): the box's text while the line is dragged. */
  basis?: PnlBasis;
  /** What the box adds after the PnL: a bot's tag, the account (several accounts). */
  suffix: string;
  /** An order's own TP / SL count from the order's new price when that one is dragged. */
  entryDraft?: number;
  kind: 'liquidation' | 'order' | 'level';
  orderText?: string;
}

export interface GroupOut {
  group: string;
  /** The line the group's buttons sit on (its entry or order), and its price as shown. */
  anchorId: string | null;
  price: number | null;
  /** ⇅: the position can be turned. */
  reverse: { accountId: number; symbol: string; side: 'long' | 'short' } | null;
  /** The change its dragged lines make (a position's SL / TP, an order). */
  ticket: Omit<ModifyTicket, 'idemKey'> | null;
  /** FIX-BOTDRAG: a bot's levels (the bot changes them). */
  botDraft: ReturnType<typeof botDraftOf>;
  accountId: number | null;
}

export function tradesCall(a: TradesArgs): unknown {
  if (sentSymbol !== `${a.stock}|${a.symbol}`) {
    sentSymbol = `${a.stock}|${a.symbol}`;
    sent = [];
  }
  const raw = linesOf(a);
  if (a.op === 'clearSent') {
    sent = [];
    return null;
  }
  if (a.op === 'sent') {
    const live = liveDrafts(raw, a.drafts);
    sent = [...sent, ...sentLevels(raw, live, a.group, a.ticket, a.result, a.now)];
    return null;
  }
  const settled = withSent(raw, sent, a.now);
  sent = settled.waiting;
  const live = liveDrafts(settled.lines, a.drafts);
  if (a.op === 'action') {
    const l = settled.lines.find((x) => x.id === a.id);
    if (!l) return null;
    const act = lineActionOf(l, a.portfolios[String(l.account.id)]);
    if (!act) return null;
    if (act.kind === 'ticket') return { kind: 'ticket', seed: act.seed };
    const x = act.action as unknown as Record<string, unknown> & { account: AccountView };
    // Without the function (`impact`): the app's own sheets work it out; the account by id.
    const { impact: _impact, account, ...rest } = x;
    return { kind: x.kind, accountId: account.id, ...rest };
  }
  const shown = withDrafts(settled.lines, live);
  const several = new Set(raw.map((l) => l.account.id)).size > 1;
  const lines: LineOut[] = shown.map((l) => {
    const entryDraft = l.role === 'order-sl' || l.role === 'order-tp' ? live[`${l.group}|line`] : undefined;
    const spec = chartLineOf(l, { last: a.lastPrice, drafted: live[l.id] !== undefined, entryDraft, several, palette: TRADE_COLORS, close: lineCloses(l, a.portfolios[String(l.account.id)]), draggable: isDraggable(l, l.account) });
    const label = spec.label as LineOut['label'];
    const { text } = labelText(l, l.price, a.lastPrice, entryDraft);
    const suffix = `${l.bot ? ` · ${l.bot.tag}` : ''}${several ? ` · ${l.account.label}` : ''}`;
    return {
      id: l.id,
      group: l.group,
      role: l.role,
      accountId: l.account.id,
      accountLabel: l.account.label,
      price: l.price,
      color: spec.color,
      ...(spec.axisLabelColor ? { axisLabelColor: spec.axisLabelColor } : {}),
      style: spec.style,
      draggable: spec.draggable ?? false,
      ...(spec.zoneFrom !== undefined ? { zoneFrom: spec.zoneFrom } : {}),
      label,
      ...(l.basis ? { basis: l.basis } : {}),
      suffix,
      ...(entryDraft !== undefined ? { entryDraft } : {}),
      kind: l.role === 'liquidation' ? 'liquidation' : l.role === 'order' ? 'order' : 'level',
      ...(l.role === 'order' ? { orderText: text } : {}),
    };
  });
  // The groups with a ⇅ or with lines dragged.
  const reversible = shown.filter((l) => l.role === 'entry' && l.position?.market === 'futures' && canReverse(l.account, l.position.symbol));
  const groups = [...new Set([...reversible.map((l) => l.group), ...draftGroups(raw, live)])];
  const out: GroupOut[] = groups.map((group) => {
    const anchor = anchorOf(group, shown, live);
    const pos = anchor?.role === 'entry' ? anchor.position : undefined;
    return {
      group,
      anchorId: anchor?.id ?? null,
      price: anchor?.price ?? null,
      reverse: anchor && pos && reversible.includes(anchor) ? { accountId: anchor.account.id, symbol: pos.symbol, side: pos.side } : null,
      ticket: draftTicket(raw, live, group),
      botDraft: botDraftOf(raw, live, group),
      accountId: anchor?.account.id ?? null,
    };
  });
  return { lines, groups: out, drafts: live };
}
