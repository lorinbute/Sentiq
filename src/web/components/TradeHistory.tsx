// FD-TRADES: „Istoric tranzacții”: a row per trade of the account (a position from its entry to its exit), the bots'
// with their SL / TP, the platform's not made by a bot; the trades closed in the page's period, and the bots' open ones.
import { useState } from 'react';
import { clsx } from 'clsx';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import type { AccountView, HistoryMarket, StatsPeriod, TradeHistory, TradeHistoryRow } from '../../shared/api-types.ts';
import { providerById } from '../../shared/providers.ts';
import { api, ApiError, qs } from '../api.ts';
import { amountIn, autoDigits, fmtDateTime, fmtNum, fmtPrice, fmtWeekday } from '../format.ts';
import { useTz } from '../hooks.ts';
import { codeRo, SHOW_RAW, tradesRo } from './account-text.ts';
import { Pnl } from './bots/bot-ui.tsx';
import { CoinLogo } from './icons.tsx';
import { ErrorNote, Loading, Panel } from './ui.tsx';

export const historyKey = (id: number, period: StatsPeriod) => ['portfolio-history', id, period] as const;
export const historyUrl = (id: number, period: StatsPeriod, force = false) => `/api/portfolio/${id}/history${qs({ period, force: force ? '1' : undefined })}`;

/** Rows shown at first, and added by „Arată încă”. */
export const HISTORY_PAGE = 50;

const MARKET_RO: Record<HistoryMarket, string> = { spot: 'Spot', futures: 'Futures', stock: 'Acțiuni', cfd: 'CFD', crypto: 'Crypto', other: 'Derivat' };

/** „Futures 3×”, „CFD 5×”, „Spot”: the leverage where it counts (futures always, a CFD above 1×). */
export function marketText(r: Pick<TradeHistoryRow, 'market' | 'leverage'>): string {
  const lev = r.leverage;
  const show = lev !== null && lev > 0 && (r.market === 'futures' || ((r.market === 'cfd' || r.market === 'other') && lev > 1));
  return show ? `${MARKET_RO[r.market]} ${fmtNum(lev, 1)}×` : MARKET_RO[r.market];
}

const PERIOD_RO: Record<StatsPeriod, string> = { today: 'ziua de azi', '7d': 'ultimele 7 zile', '30d': 'ultimele 30 de zile', '90d': 'ultimele 90 de zile' };

/** A percent with the PnL's signs (+ and the minus sign, as `Pnl` writes the amount next to it). */
const signedPct = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v), 2, 2)}%`;

/** IBKR's reports follow the New York trading day. */
const ET = 'America/New_York';

/** The panel's notes (FD-TRADES §5): what is missing from the list, and why. */
export function historyNotes(h: TradeHistory, account: Pick<AccountView, 'exchange' | 'kind'>): string[] {
  const name = providerById(account.exchange)?.name ?? account.exchange;
  const who = account.kind === 'stocks' ? 'brokerul' : 'exchange-ul';
  const out: string[] = [];
  if (!h.supported) out.push(`${name} nu dă prin API istoricul pozițiilor închise: aici apar doar tranzacțiile boților Sentiq.`);
  if (h.error) out.push(`Istoricul contului nu s-a putut citi (${codeRo(h.error.code, who)}${SHOW_RAW.has(h.error.code) ? `: ${h.error.message}` : ''}): se văd doar tranzacțiile boților.`);
  if (h.asOf !== null && !h.error) {
    out.push(
      h.asOf < h.from
        ? `${name} trimite tranzacțiile unei zile după închiderea ei: cele de azi apar după raportul de mâine.`
        : `Datele contului: până la închiderea bursei de ${fmtWeekday(h.asOf, ET)}.`,
    );
  }
  if (h.limited && !h.error) out.push('Istoricul contului e prea lung: Sentiq a citit doar o parte din el.');
  if (h.truncated) out.push('Sunt mai multe tranzacții decât se pot afișa: se văd cele mai recente.');
  return out;
}

/** Where the trade's symbol opens on the chart (a share, a coin's USDT pair, a crypto pair); none for an unknown one. */
function chartOf(r: TradeHistoryRow, share: boolean): string | null {
  const [base, quote] = r.symbol.split('/');
  if (!base || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(base)) return null;
  if (share) return `/charts/s/${encodeURIComponent(base)}`;
  return `/charts/${base}/${quote ?? 'USDT'}`;
}

/** FIX-TRADESOLD: where a level taken from the orders sent from Sentiq comes from. */
export const FROM_JOURNAL = 'Din ordinele trimise din Sentiq: o schimbare făcută direct pe platformă nu se vede aici.';

/** The SL / TP cell: the level (with where it comes from, when not the platform's), or a dash that says why. */
function Level({ value, digits, tone, missing, title }: { value: number | null; digits: number; tone: string; missing: string; title?: string }) {
  if (value === null) {
    return (
      <span className="text-faint" title={missing}>
        —
      </span>
    );
  }
  return (
    <span className={tone} title={title}>
      {fmtPrice(value, digits)}
    </span>
  );
}

/** What a row shows the same way in the table and on a phone's card. */
function rowView(r: TradeHistoryRow, stocks: boolean) {
  // Shares in cents (as on their chart); coins with the finer steps they need.
  const share = stocks && r.market !== 'crypto';
  const ref = r.entry ?? r.exit ?? r.sl ?? r.tp ?? 1;
  const d = share ? (Math.abs(ref) < 1 ? 4 : 2) : autoDigits(ref);
  const base = r.symbol.split('/')[0] ?? r.symbol;
  const to = chartOf(r, share);
  const name = (
    <>
      <CoinLogo coin={base} size={18} badge={share} square={share} />
      {r.symbol}
    </>
  );
  const symbol = to ? (
    <Link to={to} className="flex w-fit items-center gap-2 font-semibold whitespace-nowrap text-text">
      {name}
    </Link>
  ) : (
    <span className="flex items-center gap-2 font-semibold whitespace-nowrap">{name}</span>
  );
  const unknown = r.source === 'bot' ? 'Nu a avut, sau nu se știe (o tranzacție mai veche).' : stocks ? 'Brokerul nu îl dă în istoric.' : 'Exchange-ul nu păstrează SL / TP în istoricul pozițiilor.';
  const source = r.bot ? `Bot ${r.bot.name}` : 'din cont';
  const sourceTitle = r.bot ? `Făcută de botul „${r.bot.name}”` : 'Din istoricul contului: făcută de mână, din Sentiq sau de altă aplicație';
  const sideTone = r.side === 'long' ? 'text-bull' : r.side === 'short' ? 'text-bear' : 'text-faint';
  const sideText = r.side === 'long' ? 'Long' : r.side === 'short' ? 'Short' : '—';
  const pnlNote =
    r.pnlPct !== null || r.open ? (
      <div className="text-[11.5px] text-faint">
        {r.pnlPct !== null && <span className="num">{signedPct(r.pnlPct)}</span>}
        {r.pnlPct !== null && r.open && ' · '}
        {r.open && 'nerealizat'}
      </div>
    ) : null;
  const exit = (
    <>
      {r.open ? <span className="text-muted">deschisă</span> : <span className="num">{fmtPrice(r.exit, d)}</span>}
      {!r.open && r.reason && <div className="text-[11.5px] text-faint">{r.reason}</div>}
    </>
  );
  const journal = (k: 'leverage' | 'sl' | 'tp') => (r.fromJournal?.includes(k) ? FROM_JOURNAL : undefined);
  return { d, symbol, unknown, source, sourceTitle, sideTone, sideText, pnlNote, exit, journal };
}

/**
 * FIX-HISTAMOUNT: a crypto account's trades show what they took from the account, without leverage („Sumă”, as the
 * open futures positions do); a broker's keep the number of shares („Mărime”).
 */
const AMOUNT_TITLE = 'Banii luați din disponibil de tranzacție: marja, fără levier.';
function SizeOrAmount({ r, stocks }: { r: TradeHistoryRow; stocks: boolean }) {
  return stocks ? (
    <span className="num">{fmtNum(r.qty, 6)}</span>
  ) : (
    <span className="num" title={AMOUNT_TITLE}>
      {amountIn(r.margin, r.currency)}
    </span>
  );
}

export function HistoryTable({ rows, account, tz }: { rows: TradeHistoryRow[]; account: Pick<AccountView, 'kind'>; tz: string }) {
  const stocks = account.kind === 'stocks';
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Simbol</th>
          <th>Piață</th>
          <th>Direcție</th>
          <th className="text-right">{stocks ? 'Mărime' : 'Sumă'}</th>
          <th className="text-right">Intrare</th>
          <th className="text-right">SL</th>
          <th className="text-right">TP</th>
          <th className="text-right">Ieșire</th>
          <th className="text-right">PnL</th>
          <th>Intrat</th>
          <th>Ieșit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const v = rowView(r, stocks);
          return (
            <tr key={r.key}>
              <td>
                {v.symbol}
                <div className="mt-0.5 max-w-[24ch] truncate text-[11.5px] text-faint" title={v.sourceTitle}>
                  {v.source}
                </div>
              </td>
              <td className="whitespace-nowrap text-muted" title={v.journal('leverage')}>
                {marketText(r)}
              </td>
              <td className={v.sideTone}>{v.sideText}</td>
              <td className="text-right">
                <SizeOrAmount r={r} stocks={stocks} />
              </td>
              <td className="num text-right">{fmtPrice(r.entry, v.d)}</td>
              <td className="num text-right">
                <Level value={r.sl} digits={v.d} tone="text-bear" missing={v.unknown} title={v.journal('sl')} />
              </td>
              <td className="num text-right">
                <Level value={r.tp} digits={v.d} tone="text-bull" missing={v.unknown} title={v.journal('tp')} />
              </td>
              <td className="text-right whitespace-nowrap">{v.exit}</td>
              <td className="text-right whitespace-nowrap">
                <Pnl value={r.pnl} currency={r.currency} />
                {v.pnlNote}
              </td>
              <td className="num text-[12px] whitespace-nowrap text-muted">{r.openedAt ? fmtDateTime(r.openedAt, tz) : '—'}</td>
              <td className="num text-[12px] whitespace-nowrap text-muted">{r.closedAt ? fmtDateTime(r.closedAt, tz) : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** One value of a phone's card: its name above it; `end`: the right column, aligned to the right (FD-TRADESMOBILE). */
function Cell({ label, children, end }: { label: string; children: React.ReactNode; end?: boolean }) {
  return (
    <div className={clsx('min-w-0', end && 'text-right')}>
      <dt className="text-[11.5px] text-faint">{label}</dt>
      <dd className="text-[13px]">{children}</dd>
    </div>
  );
}

/**
 * On a phone (under 640 px), a card per trade instead of the table's eleven columns: the same values, none of them off
 * to the side.
 */
export function HistoryCards({ rows, account, tz }: { rows: TradeHistoryRow[]; account: Pick<AccountView, 'kind'>; tz: string }) {
  const stocks = account.kind === 'stocks';
  return (
    <ul className="rows border-t border-line">
      {rows.map((r) => {
        const v = rowView(r, stocks);
        return (
          <li key={r.key} className="px-5 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {v.symbol}
                <div className="mt-0.5 text-[12px]">
                  <span className={v.sideTone}>{v.sideText}</span>
                  <span className="text-muted" title={v.journal('leverage')}>
                    {' '}
                    · {marketText(r)}
                  </span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <Pnl value={r.pnl} currency={r.currency} />
                {v.pnlNote}
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
              <Cell label="Intrare">
                <span className="num">{fmtPrice(r.entry, v.d)}</span>
              </Cell>
              <Cell label="Ieșire" end>{v.exit}</Cell>
              <Cell label="SL">
                <Level value={r.sl} digits={v.d} tone="num text-bear" missing={v.unknown} title={v.journal('sl')} />
              </Cell>
              <Cell label="TP" end>
                <Level value={r.tp} digits={v.d} tone="num text-bull" missing={v.unknown} title={v.journal('tp')} />
              </Cell>
              <Cell label="Intrat">
                <span className="num text-[12px] text-muted">{r.openedAt ? fmtDateTime(r.openedAt, tz) : '—'}</span>
              </Cell>
              <Cell label="Ieșit" end>
                <span className="num text-[12px] text-muted">{r.closedAt ? fmtDateTime(r.closedAt, tz) : '—'}</span>
              </Cell>
              <Cell label={stocks ? 'Mărime' : 'Sumă'}>
                <SizeOrAmount r={r} stocks={stocks} />
              </Cell>
              <Cell label="Făcută de" end>
                <span className="block truncate text-muted" title={v.sourceTitle}>
                  {v.source}
                </span>
              </Cell>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

/** FD-TRADES: the panel, after „Ordine deschise”. */
export function TradeHistoryPanel({ account, period }: { account: AccountView; period: StatsPeriod }) {
  const tz = useTz();
  const q = useQuery({
    queryKey: historyKey(account.id, period),
    queryFn: () => api.get<TradeHistory>(historyUrl(account.id, period)),
    staleTime: 60_000,
    refetchInterval: 60_000,
    // A server from before FD-TRADES answers 404: asking again does not help.
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 1,
  });
  const h = q.data;
  const count = h ? <span className="text-[12.5px] text-faint">{tradesRo(h.rows.length)}</span> : null;
  return (
    <Panel title="Istoric tranzacții" icon={History} actions={count} flush>
      {!h ? (
        q.isError ? (
          q.error instanceof ApiError && q.error.status === 404 ? (
            <div className="py-4 text-[13.5px] text-muted">Serverul Sentiq nu are încă istoricul tranzacțiilor.</div>
          ) : (
            <div className="py-3">
              <ErrorNote error={q.error} onRetry={() => q.refetch()} />
            </div>
          )
        ) : (
          <div>
            <Loading label="Se citește istoricul tranzacțiilor…" />
          </div>
        )
      ) : (
        // A new period or account starts again from the first rows.
        <HistoryBody key={`${account.id}|${period}`} h={h} account={account} period={period} tz={tz} />
      )}
    </Panel>
  );
}

function HistoryBody({ h, account, period, tz }: { h: TradeHistory; account: AccountView; period: StatsPeriod; tz: string }) {
  const [shown, setShown] = useState(HISTORY_PAGE);
  const notes = historyNotes(h, account);
  const more = h.rows.length - shown;
  return (
    <>
      {notes.length > 0 && (
        <div className="flex flex-col gap-1 pb-2.5 text-[12.5px] text-muted">
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      {h.rows.length === 0 ? (
        <div className="py-4 text-[14px] text-muted">Nicio tranzacție închisă în {PERIOD_RO[period]}.</div>
      ) : (
        <>
          <div className="table-wrap hidden sm:block">
            <HistoryTable rows={h.rows.slice(0, shown)} account={account} tz={tz} />
          </div>
          <div className="table-wrap sm:hidden">
            <HistoryCards rows={h.rows.slice(0, shown)} account={account} tz={tz} />
          </div>
        </>
      )}
      {more > 0 && (
        <div className="pt-2.5">
          <button type="button" className="btn" onClick={() => setShown((n) => n + HISTORY_PAGE)}>
            Arată încă {Math.min(more, HISTORY_PAGE)}
          </button>
        </div>
      )}
      {/* FD-PAPER: a Paper Trading profile keeps its spot sales too. */}
      {account.kind !== 'stocks' && account.exchange !== 'paper' && <p className="pt-2.5 text-[12px] text-faint">Pe spot apar doar tranzacțiile boților: exchange-ul ține execuțiile, nu pozițiile.</p>}
    </>
  );
}
