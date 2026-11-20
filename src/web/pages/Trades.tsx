import { Children, isValidElement, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowRightLeft, ChartCandlestick, Coins, ListChecks, Plus, Power, RefreshCw, RotateCcw, Settings2, Wallet } from 'lucide-react';
import { PaperBadge, PaperResetDialog, PaperSettingsDialog } from '../components/PaperDialogs.tsx';
import type { AccountView, BalanceRow, OrderRow, Portfolio, StatsPeriod, TradeHistory, TradeStats } from '../../shared/api-types.ts';
import { api, errorMessage, qs } from '../api.ts';
import { isFxRate } from '../../shared/fx.ts';
import { autoDigits, breakableUnit, fmtAgo, fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtUsd, fmtWeekday, positionAmount } from '../format.ts';
import { useRevealInRow, useTz } from '../hooks.ts';
import { Empty, ErrorNote, Loading, Panel, Warning } from '../components/ui.tsx';
import { CoinLogo } from '../components/icons.tsx';
import { AccountWizard } from '../components/AccountWizard.tsx';
import { ProviderLogo } from '../components/ProviderLogo.tsx';
import { providerById } from '../../shared/providers.ts';
import { OrderTicket, type TicketSeed } from '../components/OrderTicket.tsx';
import { CancelOrderButton, EnableTradingDialog, FundsRiskNote, useDisableTrading } from '../components/TradingControls.tsx';
import { ModifyTicket } from '../components/ModifyTicket.tsx';
import { holdingSeed, orderSeed, positionSeed, type ModifySeed } from '../components/modify-seeds.ts';
import { closeSeed, sellSeed } from '../components/trade-seeds.ts';
import { canReverse, ReverseDialog } from '../components/ReverseDialog.tsx';
import { portfolioInterval } from '../portfolio-settle.ts';
import { codeRo, SHOW_RAW, tradesRo } from '../components/account-text.ts';
import { historyKey, historyUrl, TradeHistoryPanel } from '../components/TradeHistory.tsx';

// FD-TRADES: the fills are no longer listed; they still give the holdings' average price.
const SECTION_RO: Record<string, string> = { balances: 'Solduri', positions: 'Poziții', orders: 'Ordine', fills: 'Execuțiile (pentru prețul mediu)', prices: 'Prețuri', mode: 'Tip cont', futures: 'Cont futures' };

const STABLE_ASSETS = new Set(['USDT', 'USDC', 'USD', 'DAI', 'FDUSD']);

const pnlClass = (v: number | null) => (v === null ? 'text-muted' : v >= 0 ? 'text-bull' : 'text-bear');

/** FD-TRADESTATS §2: the period of the closed-position cards, kept in this browser. */
const PERIODS: { id: StatsPeriod; label: string }[] = [
  { id: 'today', label: 'Azi' },
  { id: '7d', label: '7z' },
  { id: '30d', label: '30z' },
  { id: '90d', label: '90z' },
];
const PERIOD_KEY = 'sentiq:trades-period';
function readPeriod(): StatsPeriod {
  try {
    const v = localStorage.getItem(PERIOD_KEY);
    return PERIODS.some((p) => p.id === v) ? (v as StatsPeriod) : '30d';
  } catch {
    return '30d';
  }
}
function writePeriod(v: StatsPeriod): void {
  try {
    localStorage.setItem(PERIOD_KEY, v);
  } catch {
    // private window: the choice lasts this visit
  }
}
const statsKey = (id: number, period: StatsPeriod) => ['portfolio-stats', id, period] as const;
const statsUrl = (id: number, period: StatsPeriod, force = false) => `/api/portfolio/${id}/stats${qs({ period, force: force ? '1' : undefined })}`;

/** FD-TRADESMOBILE: on a phone (two cards a row), an odd last card takes the whole row. */
const ODD_LAST_FULL = 'max-sm:[&>:last-child:nth-child(odd)]:col-span-2';

/** One summary card; `title` explains it (or why it shows a dash). */
function Stat({ label, value, tone, title, hint }: { label: string; value: string; tone?: string; title?: string; hint?: string }) {
  return (
    <div className="panel min-w-0 px-4 py-3 sm:@container" title={title}>
      <div className="truncate text-[12.5px] text-muted">{label}</div>
      {/* FIX-FITWIDTH (`stat-fit`): the size at which the grid's longest value fits, at most 22 px, cut only below 14 px;
          on a phone (FD-TRADESMOBILE) at most 18 px, the currency on the next line, the sum smaller only when it alone
          does not fit (never under 12 px). */}
      <div className={clsx('num stat-fit mt-0.5 tracking-[-0.02em] max-sm:whitespace-normal sm:truncate', tone)}>{breakableUnit(value)}</div>
      {hint && <div className="truncate text-[11.5px] text-faint">{hint}</div>}
    </div>
  );
}

/**
 * FIX-FITWIDTH: the cards' grid, with the length of its longest value (`--stat-chars`) and of its longest sum without
 * its currency (`--stat-num-chars`, a phone wraps the currency): all its values at one size, the largest that fits.
 */
function StatGrid({ className, children }: { className: string; children: React.ReactNode }) {
  const values = Children.toArray(children).map((c) => (isValidElement<{ value?: unknown }>(c) && typeof c.props.value === 'string' ? c.props.value : ''));
  const chars = Math.max(1, ...values.map((v) => v.length));
  const numChars = Math.max(1, ...values.map((v) => v.replace(/[\s\u00a0][^\s\u00a0\d.,−+-]+$/, '').length));
  return (
    // A phone sizes the values from the grid (two columns), so the odd last card, a whole row, has the others' size.
    <div className={clsx(className, 'max-sm:@container')} style={{ '--stat-chars': chars, '--stat-num-chars': numChars } as React.CSSProperties}>
      {children}
    </div>
  );
}

/**
 * „Reîmprospătează” in the page's top row (FD-TRADESTATS §2, FD-BROKERSTATS): the account's portfolio and its stats for
 * the period; FD-TRADES: and its trade history.
 */
function useRefreshAccount(account: AccountView, period: StatsPeriod) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const [p, st, h] = await Promise.all([
        api.get<Portfolio>(`/api/portfolio/${account.id}?force=1`),
        api.get<TradeStats>(statsUrl(account.id, period, true)).catch(() => null),
        api.get<TradeHistory>(historyUrl(account.id, period, true)).catch(() => null),
      ]);
      qc.setQueryData(['portfolio', account.id], p);
      if (st) qc.setQueryData(statsKey(account.id, period), st);
      if (h) qc.setQueryData(historyKey(account.id, period), h);
    },
  });
}

function CostBasisEditor({ accountId, row }: { accountId: number; row: BalanceRow }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.avgPrice ? String(row.avgPrice) : '');
  const [invalid, setInvalid] = useState(false);
  const save = useMutation({
    mutationFn: (avgPrice: number | null) => api.put(`/api/portfolio/${accountId}/cost-basis/${encodeURIComponent(row.asset)}`, { avgPrice }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['portfolio', accountId] });
    },
  });
  if (!editing) {
    return (
      <button type="button" className="text-[12px] text-link" onClick={() => setEditing(true)}>
        {row.avgSource === 'manual' ? 'editează' : row.avgPrice === null ? 'setează manual' : 'corectează'}
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        // Empty = remove the manual price; anything else must be a positive number.
        if (value.trim() === '') return save.mutate(null);
        const n = Number(value.trim().replace(',', '.'));
        setInvalid(!(Number.isFinite(n) && n > 0));
        if (Number.isFinite(n) && n > 0) save.mutate(n);
      }}
    >
      <input aria-label={`Preț mediu ${row.asset}`} value={value} onChange={(e) => setValue(e.target.value)} className="w-24 text-right" inputMode="decimal" />
      <button className="btn px-2 py-1">OK</button>
      <button type="button" className="btn px-2 py-1" onClick={() => setEditing(false)}>
        Renunță
      </button>
      {invalid && <span className="text-[12px] text-bear">Introdu un preț pozitiv, sau lasă gol ca să ștergi prețul manual.</span>}
      {save.isError && <span className="text-[12px] text-bear">{errorMessage(save.error)}</span>}
    </form>
  );
}

/** FD-TRADESTATS §2: the seven cards of a crypto account, the period of the last four, and when it was read. */
function CryptoCards({
  p,
  account,
  stats,
  period,
  updated,
}: {
  p: Portfolio;
  account: AccountView;
  stats: { data?: TradeStats; isPending: boolean; isError: boolean };
  period: StatsPeriod;
  updated: React.ReactNode;
}) {
  const name = providerById(account.exchange)?.name ?? account.exchange;
  const paper = account.exchange === 'paper';
  // A server from before FD-TRADESTATS sends no `futuresAvailable`.
  const futures = p.totals.futuresAvailable ?? null;
  const futuresErr = p.errors.futures;
  const futuresTitle = futuresErr
    ? `Contul futures: ${codeRo(futuresErr.code, 'exchange-ul')}${SHOW_RAW.has(futuresErr.code) ? ` (${futuresErr.message})` : ''}`
    : futures === null
      ? `${name}: fără cont futures în Sentiq.`
      : 'Suma liberă în contul futures, în USDT: cât poți folosi pentru poziții noi.';
  const st = stats.data;
  const statDash = (): string | undefined => {
    if (stats.isPending) return undefined;
    if (stats.isError || !st) return 'Statisticile nu s-au putut citi.';
    if (!st.supported) return futures === null && !futuresErr ? `${name}: fără futures în Sentiq.` : `${name} nu dă prin API istoricul pozițiilor închise.`;
    if (st.error) return `Istoricul pozițiilor: ${codeRo(st.error.code, 'exchange-ul')}`;
    return undefined;
  };
  const why = statDash();
  const count = (v: number | null | undefined) => (stats.isPending ? '…' : v === null || v === undefined ? '—' : fmtNum(v, 0));
  const periodLabel = PERIODS.find((x) => x.id === period)?.label ?? period;
  const closedTitle = (what: string) =>
    why ?? (paper ? `${what}: pozițiile închise în perioada aleasă (${periodLabel}), spot și futures, după rezultatul net (cu comisioanele).` : `${what}: pozițiile futures închise în perioada aleasă (${periodLabel}), după rezultatul lor net (cu comisioane și funding).`);
  return (
    <div className="flex flex-col gap-2.5">
      <StatGrid className={clsx('grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7', ODD_LAST_FULL)}>
        {/* FD-PAPER §6: a profile has one wallet: what is free for new orders, and its money with its coins. */}
        <Stat label={paper ? 'Disponibil' : 'Disponibil în futures'} value={fmtUsd(futures)} title={paper ? 'Banii profilului liberi pentru ordine noi: fără marja pozițiilor și fără ce țin ordinele care așteaptă.' : futuresTitle} />
        <Stat
          label={paper ? 'Valoarea contului' : 'Valoare în contul spot'}
          value={fmtUsd(p.totals.spotValue)}
          title={
            paper
              ? 'Banii profilului plus rezultatul pozițiilor deschise (spot și futures), la prețul de acum.'
              : 'Tot ce ai în conturile spot (la KuCoin: Trading și Funding): monedele la prețul de acum, plus stablecoins. Contul futures nu e inclus.'
          }
        />
        <Stat
          label={paper ? 'PnL nerealizat (poziții)' : 'PnL nerealizat (futures)'}
          value={fmtUsd(p.totals.unrealizedPnl)}
          tone={pnlClass(p.totals.unrealizedPnl)}
          title={paper ? 'Profitul sau pierderea pozițiilor deschise (spot și futures), la prețul de acum.' : 'Profitul sau pierderea pozițiilor futures încă deschise, la prețul de acum.'}
        />
        <Stat label="Tranzacții profitabile" value={count(st?.wins)} tone={st?.wins ? 'text-bull' : undefined} title={closedTitle('Profitabile')} />
        <Stat label="Tranzacții cu pierdere" value={count(st?.losses)} tone={st?.losses ? 'text-bear' : undefined} title={closedTitle('Cu pierdere')} />
        <Stat
          label="Rata de succes"
          value={stats.isPending ? '…' : st?.successRate === null || st?.successRate === undefined ? '—' : `${fmtNum(st.successRate, 1)} %`}
          title={why ?? 'Profitabile din profitabile + cu pierdere; pozițiile închise pe zero nu intră.'}
        />
        <Stat
          label="Câștig net"
          value={stats.isPending ? '…' : fmtUsd(st?.net)}
          tone={pnlClass(st?.net ?? null)}
          title={why ?? 'Suma rezultatelor nete ale pozițiilor futures închise în perioadă.'}
          hint={st?.netPartial ? 'parțial: o monedă fără preț' : undefined}
        />
      </StatGrid>
      {/* The period is chosen in the page's top row (FD-UIPOLISH); here only what was read and when. */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        {st?.error && <span className="text-[12px] text-bear">{why}</span>}
        <div className="ml-auto">{updated}</div>
      </div>
    </div>
  );
}

/** FD-BROKERSTATS §2: what a closed trade is at each broker, and its result. */
const BROKER_STATS_NOTE: Record<string, string> = {
  etoro: 'pozițiile închise (o închidere parțială e o tranzacție separată), după profitul net dat de eToro',
  trading212: 'vânzările executate (un ordin e o tranzacție), după profitul realizat dat de Trading 212',
  ibkr: 'ordinele care au închis sau redus o poziție, după Realized P/L (FIFO, cu comisioane) din raportul Flex',
  alpaca: 'ordinele care au închis sau redus o poziție; rezultatul e calculat de Sentiq din execuții (FIFO), fără taxele regulatorii',
  paper: 'pozițiile închise (o închidere parțială e o tranzacție separată), după rezultatul net, cu comisioanele',
};

/** FD-BROKERSTATS §3: why a closed trade can have no known result. */
const UNKNOWN_WHY: Record<string, string> = {
  etoro: 'eToro nu a dat profitul net',
  trading212: 'Trading 212 nu a dat profitul realizat',
  alpaca: 'cumpărarea e mai veche decât istoricul citit, acțiunile au venit prin transfer sau split, ori contul nu permite short',
};

/** IBKR's reports follow the New York trading day. */
const ET = 'America/New_York';

const BROKER_GRID: Record<number, string> = { 5: 'xl:grid-cols-5', 6: 'xl:grid-cols-6', 7: 'xl:grid-cols-7' };

/** FD-BROKERSTATS §1: a broker's cards (holdings, cash, open positions' PnL, then the closed trades of the period). */
function BrokerCards({
  p,
  account,
  stats,
  period,
  updated,
}: {
  p: Portfolio;
  account: AccountView;
  stats: { data?: TradeStats; isPending: boolean; isError: boolean };
  period: StatsPeriod;
  updated: React.ReactNode;
}) {
  const name = providerById(account.exchange)?.name ?? account.exchange;
  const st = stats.data;
  // IBKR's report has finished days only: before today's, „Azi” cannot be counted.
  const notYet = !!st && !st.error && st.asOf != null && st.asOf < st.from;
  const statDash = (): string | undefined => {
    if (stats.isPending) return undefined;
    if (stats.isError || !st) return 'Statisticile nu s-au putut citi.';
    // A server from before FD-BROKERSTATS sends no `currency` and no broker stats.
    if (!st.supported) return st.currency === undefined ? 'Serverul Sentiq nu are încă statisticile pentru brokeri.' : `${name} nu dă prin API istoricul tranzacțiilor închise.`;
    if (st.error) return `Istoricul tranzacțiilor: ${codeRo(st.error.code, 'brokerul')}`;
    if (notYet) return `${name} trimite tranzacțiile unei zile după închiderea ei (raportul Flex are datele până la închiderea bursei de ${fmtWeekday(st.asOf as number, ET)}). Alege 7z, 30z sau 90z.`;
    return undefined;
  };
  const why = statDash();
  const count = (v: number | null | undefined) => (stats.isPending ? '…' : v === null || v === undefined ? '—' : fmtNum(v, 0));
  const periodLabel = PERIODS.find((x) => x.id === period)?.label ?? period;
  // The New York day, in full („vineri, 16 octombrie”): a short month („oct.”) would end the sentence with two dots.
  const through = st?.asOf != null && !notYet ? ` Datele: până la închiderea bursei de ${fmtWeekday(st.asOf, ET)}.` : '';
  const what = BROKER_STATS_NOTE[account.exchange] ?? 'tranzacțiile închise';
  const closedTitle = (label: string) => why ?? `${label}: ${what}, în perioada aleasă (${periodLabel}).${through}`;
  const counted = st && st.wins !== null && !why;
  const partial = !counted
    ? undefined
    : st.netPartial
      ? 'parțial: fără curs valutar'
      : st.limited
        ? 'parțial: istoric prea lung'
        : st.unknownResults
          ? `${tradesRo(st.unknownResults)} fără rezultat`
          : undefined;
  const partialTitle = !counted
    ? ''
    : [
        st.netPartial ? ' Unele rezultate sunt în altă monedă, fără curs de schimb: sunt numărate, dar nu intră în sumă.' : '',
        st.limited ? ` ${name} dă istoricul pe pagini; Sentiq citește un număr limitat, iar perioada are mai multe tranzacții decât au încăput.` : '',
        st.unknownResults
          ? ` Fără rezultat cunoscut, deci nenumărate: ${tradesRo(st.unknownResults)}${UNKNOWN_WHY[account.exchange] ? ` (${UNKNOWN_WHY[account.exchange]})` : ''}.`
          : '',
      ].join('');
  const paper = account.exchange === 'paper';
  const cards: React.ReactNode[] = [
    <Stat
      key="value"
      label={paper ? 'Valoarea contului' : 'Valoare dețineri'}
      value={fmtMoney(p.totals.spotValue, p.currency)}
      title={paper ? 'Banii profilului plus rezultatul pozițiilor deschise, la prețul de acum.' : undefined}
    />,
    p.cash !== null && <Stat key="cash" label={paper ? 'Disponibil' : 'Numerar disponibil'} value={fmtMoney(p.cash, p.currency)} title={paper ? 'Banii liberi pentru ordine noi: fără marja pozițiilor și fără ce țin ordinele care așteaptă.' : undefined} />,
    p.positions.length > 0 && (
      <Stat key="upnl" label="PnL nerealizat (poziții)" value={fmtMoney(p.totals.unrealizedPnl, p.currency)} tone={pnlClass(p.totals.unrealizedPnl)} title={paper ? 'Profitul sau pierderea pozițiilor deschise, la prețul de acum.' : 'Profitul sau pierderea pozițiilor cu levier sau short încă deschise.'} />
    ),
    <Stat key="wins" label="Tranzacții profitabile" value={count(st?.wins)} tone={st?.wins ? 'text-bull' : undefined} title={closedTitle('Profitabile')} />,
    <Stat key="losses" label="Tranzacții cu pierdere" value={count(st?.losses)} tone={st?.losses ? 'text-bear' : undefined} title={closedTitle('Cu pierdere')} />,
    <Stat
      key="rate"
      label="Rata de succes"
      value={stats.isPending ? '…' : st?.successRate === null || st?.successRate === undefined ? '—' : `${fmtNum(st.successRate, 1)} %`}
      title={why ?? 'Profitabile din profitabile + cu pierdere; tranzacțiile închise pe zero nu intră.'}
    />,
    <Stat
      key="net"
      label="Câștig net"
      value={stats.isPending ? '…' : why ? '—' : fmtMoney(st?.net, st?.currency ?? p.currency)}
      tone={why ? undefined : pnlClass(st?.net ?? null)}
      title={why ?? `Suma rezultatelor: ${what}, în moneda contului.${through}${partialTitle}`}
      hint={partial}
    />,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-2.5">
      <StatGrid className={clsx('grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4', BROKER_GRID[cards.length], ODD_LAST_FULL)}>{cards}</StatGrid>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        {st?.error && <span className="text-[12px] text-bear">{why}</span>}
        <div className="ml-auto">{updated}</div>
      </div>
    </div>
  );
}

/** Whether "Anulează" can go out: the order's market (as the server reads it) is one trading was switched on for. */
function cancellable(account: AccountView, o: OrderRow): boolean {
  if (o.cancellable === false) return false;
  // A perpetual's order (BTC/USDT:USDT) is futures wherever it is listed (KuCoin's unified account lists it with spot).
  const market = account.kind === 'stocks' ? 'stock' : o.symbol.includes(':') ? 'futures' : o.market;
  return account.trading.markets.includes(market);
}

function PortfolioView({
  account,
  period,
  onTicket,
  onModify,
  onReverse,
}: {
  account: AccountView;
  period: StatsPeriod;
  onTicket: (seed: TicketSeed) => void;
  onModify: (seed: ModifySeed) => void;
  onReverse: (r: { symbol: string; side: 'long' | 'short' }) => void;
}) {
  const trades = account.trading.enabled;
  const tz = useTz();
  const q = useQuery({ queryKey: ['portfolio', account.id], queryFn: () => api.get<Portfolio>(`/api/portfolio/${account.id}`), refetchInterval: () => portfolioInterval(account.id, 30_000) });
  const statsQ = useQuery({
    queryKey: statsKey(account.id, period),
    queryFn: () => api.get<TradeStats>(statsUrl(account.id, period)),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
  if (!q.data && !q.isError) return <Loading label={account.exchange === 'paper' ? 'Se citește profilul Paper Trading…' : account.kind === 'stocks' ? 'Se citesc datele de la broker…' : 'Se citesc datele de pe exchange…'} />;
  if (!q.data) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;
  const stocks = p.kind === 'stocks';
  // FD-PAPER, FIX-PAPERLEV: a profile holds positions only (spot too: long or short, with leverage), the money in the cards.
  const paperAcc = account.exchange === 'paper';
  // Crypto values are in USDT and shown as dollars, as before; a broker's are in the account's currency.
  const money = (v: number | null | undefined, currency = p.currency) => (stocks ? fmtMoney(v, currency) : fmtUsd(v));
  const errs = Object.entries(p.errors);
  // Shares are quoted in cents (as on their chart); coins keep the finer steps they need (FIX-DECIMALS: at most two from 1
  // on, four under 1); a forex / commodity rate four under 10.
  const digits = (v: number | null | undefined, crypto = false, symbol = '') => (isFxRate(symbol) ? autoDigits(v ?? 1, true) : stocks && !crypto ? (Math.abs(v ?? 1) < 1 ? 4 : 2) : autoDigits(v ?? 1));
  const chartOf = (asset: string, crypto = false) => (stocks && !crypto ? `/charts/s/${encodeURIComponent(asset)}` : `/charts/${asset}/USDT`);
  const updated = (
    <div className="text-[12px] text-faint">
      {p.exchange === 'kucoin' ? `Cont ${p.mode === 'unified' ? 'unificat (UTA)' : p.mode === 'classic' ? 'clasic' : 'necunoscut'}, ` : ''}
      {p.asOf ? `date la închiderea din ${fmtDateTime(p.asOf, tz)} (raport Flex), citit ${fmtAgo(p.fetchedAt)}` : `actualizat ${fmtAgo(p.fetchedAt)}`}
    </div>
  );
  return (
    <div className="flex flex-col gap-3.5">
      {stocks ? (
        <BrokerCards p={p} account={account} stats={statsQ} period={period} updated={updated} />
      ) : (
        <CryptoCards p={p} account={account} stats={statsQ} period={period} updated={updated} />
      )}
      {errs.length > 0 && (
        <Warning>
          {errs.filter(([k]) => k !== 'futures').map(([k, v]) => {
            const staleAt = p.stale[k as keyof Portfolio['stale']];
            const code = v?.code ?? 'EXCHANGE';
            return (
              <div key={k} title={v?.message}>
                {SECTION_RO[k] ?? k}: {codeRo(code, stocks ? 'brokerul' : 'exchange-ul')}
                {SHOW_RAW.has(code) && v?.message ? ` (${v.message})` : ''}
                {staleAt ? `; se afișează datele din ${fmtDateTime(staleAt, tz)}` : ''}
              </div>
            );
          })}
        </Warning>
      )}

      <Panel title={paperAcc ? 'Poziții deschise' : stocks ? 'Poziții cu levier sau short' : 'Poziții futures deschise'} icon={ChartCandlestick} flush>
        {p.positions.length === 0 ? (
          <div>
            <Empty>{paperAcc ? 'Nicio poziție deschisă.' : stocks ? 'Nicio poziție cu levier sau short.' : 'Nicio poziție futures deschisă.'}</Empty>
          </div>
        ) : (
          // Rows with buttons: every cell on the row's middle, as the buttons (the text never sits above them).
          <table className={clsx('table', trades && '[&_td]:align-middle')}>
            <thead>
              <tr>
                <th>Simbol</th>
                <th>Direcție</th>
                {/* FIX-POSAMOUNT: on futures (a crypto profile too) the money the position took, without leverage. */}
                <th className="text-right">{stocks ? 'Mărime' : 'Sumă'}</th>
                <th className="text-right">Intrare</th>
                <th className="text-right">Mark</th>
                <th className="text-right">PnL</th>
                <th className="text-right">Lichidare</th>
                <th className="text-right">Levier</th>
                {trades && (
                  <th className="relative text-right">
                    <span className="sr-only">Acțiuni</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {p.positions.map((pos, i) => {
                const d = digits(pos.entryPrice ?? pos.markPrice, false, pos.symbol);
                const [base, quoteFull] = pos.symbol.split('/');
                return (
                  // eToro keeps every position apart (FD-HEDGEALL): two shorts on one instrument are two rows.
                  <tr key={`${pos.symbol}-${pos.side}-${pos.ref?.positionIds?.join(',') ?? i}`}>
                    <td>
                      {/* The margin mode centred on the symbol's row, as the logo and the name (FD-ORDEREDIT); a block flex, so
                          the cell's middle is the text's (an inline one sits on the logo's baseline). */}
                      {/* FIX-POSMARGIN: WebKit counts a logo image with `max-width: 100%` (the base styles) as 0 px wide in a
                          table cell's minimum width, so the column came out 18 px too narrow and a futures symbol ran over the
                          margin mode: the logo keeps its size (`max-w-none`) and neither part shrinks or breaks. */}
                      <span className="flex items-center gap-x-1.5">
                        <Link to={stocks ? chartOf(base ?? '') : `/charts/${base}/${(quoteFull ?? 'USDT').split(':')[0]}`} className="inline-flex shrink-0 items-center gap-2 font-semibold whitespace-nowrap text-text">
                          {base && <CoinLogo coin={base} size={18} badge={stocks} square={stocks} className="max-w-none" />}
                          {stocks ? base : pos.symbol}
                        </Link>
                        {pos.marginMode && <span className="shrink-0 text-[12px] leading-none whitespace-nowrap text-faint">{pos.marginMode}</span>}
                      </span>
                    </td>
                    <td className={pos.side === 'long' ? 'text-bull' : 'text-bear'}>{pos.side === 'long' ? 'Long' : pos.side === 'short' ? 'Short' : pos.side}</td>
                    {stocks ? (
                      <td className="num text-right">{fmtNum(pos.size ?? pos.contracts, 6)}</td>
                    ) : (
                      <td className="num text-right" title="Banii luați din disponibil pentru poziție: marja, fără levier.">
                        {positionAmount(pos)}
                      </td>
                    )}
                    <td className="num text-right">{fmtPrice(pos.entryPrice, d)}</td>
                    <td className="num text-right">{fmtPrice(pos.markPrice, d)}</td>
                    <td className={clsx('num text-right', pnlClass(pos.unrealizedPnl))}>
                      {stocks ? money(pos.unrealizedPnl) : fmtNum(pos.unrealizedPnl, 2)} <span className="text-[12px]">{fmtPct(pos.percentage)}</span>
                    </td>
                    <td className="num text-right text-warn">{fmtPrice(pos.liquidationPrice, d)}</td>
                    <td className="num text-right">{pos.leverage ? `${fmtNum(pos.leverage, 1)}×` : '—'}</td>
                    {trades && (
                      <td className="text-right">
                        {(() => {
                          const seed = closeSeed(account, pos);
                          const protect = positionSeed(account, p, pos);
                          return (
                            <span className="inline-flex items-center justify-end gap-1.5">
                              {protect && (
                                <button className="btn h-8 px-2 text-[12px] whitespace-nowrap" onClick={() => onModify(protect)} aria-label={protect.title}>
                                  SL / TP
                                </button>
                              )}
                              {/* FD-REVERSE: closed, then opened the other way (TradingView's ⇅). */}
                              {(pos.side === 'long' || pos.side === 'short') && canReverse(account, pos.symbol) && (
                                <button className="btn h-8 px-2 text-[12px]" onClick={() => onReverse({ symbol: pos.symbol, side: pos.side as 'long' | 'short' })} aria-label={`Întoarce poziția ${pos.side} ${pos.symbol}`}>
                                  Întoarce
                                </button>
                              )}
                              {seed && (
                                <button className="btn h-8 px-2 text-[12px]" onClick={() => onTicket(seed)}>
                                  Închide
                                </button>
                              )}
                            </span>
                          );
                        })()}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {/* FD-PAPER: a profile has no holdings apart (its trades are positions): no panel of coins. */}
      {!paperAcc && (
        <Panel title={stocks ? 'Dețineri' : 'Dețineri spot'} icon={Coins} flush>
          {p.balances.length === 0 ? (
            <div>
              <Empty>Niciun sold.</Empty>
            </div>
          ) : (
            <table className={clsx('table', trades && '[&_td]:align-middle')}>
              <thead>
                <tr>
                  <th>Activ</th>
                  <th>Cont</th>
                  <th className="text-right">Cantitate</th>
                  <th className="text-right">Preț</th>
                  <th className="text-right">Valoare</th>
                  <th className="text-right">Preț mediu</th>
                  <th className="text-right">{stocks ? 'PnL' : 'PnL estimat'}</th>
                  {trades && (
                    <th className="relative text-right">
                      <span className="sr-only">Acțiuni</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {p.balances.map((b) => {
                  const d = digits(b.price, b.crypto, b.asset);
                  return (
                    <tr key={`${b.account}-${b.asset}`}>
                      <td className="font-semibold">
                        {/* Block flex: the logo and the name on one middle (an inline one sits on the logo's baseline). */}
                        {STABLE_ASSETS.has(b.asset) || b.asset.startsWith('#') ? (
                          <span className="flex items-center gap-2">
                            <CoinLogo coin={b.asset} size={18} badge={stocks} square={stocks} />
                            {b.asset}
                          </span>
                        ) : (
                          <Link to={chartOf(b.asset, b.crypto)} className="flex w-fit items-center gap-2 text-text">
                            <CoinLogo coin={b.asset} size={18} badge={stocks && !b.crypto} square={stocks && !b.crypto} />
                            {b.asset}
                          </Link>
                        )}
                        {b.name && <div className="max-w-[24ch] truncate text-[11.5px] font-normal text-faint">{b.name}</div>}
                        {b.note && <div className="text-[11.5px] font-normal text-link">{b.note}</div>}
                      </td>
                      <td className="text-[12px] text-muted">{b.account}</td>
                      <td className="num text-right">
                        {fmtNum(b.total, 8)}
                        {b.used > 0 && <div className="text-[11.5px] text-faint">{fmtNum(b.used, 8)} în ordine</div>}
                      </td>
                      <td className="num text-right">
                        {fmtPrice(b.price, d)}
                        {stocks && b.priceCurrency && b.priceCurrency !== b.currency && <span className="ml-1 text-[11px] text-faint">{b.priceCurrency}</span>}
                      </td>
                      <td className="num text-right">{money(b.value, b.currency ?? p.currency)}</td>
                      <td className="num text-right">
                        {b.avgPrice !== null ? fmtPrice(b.avgPrice, d) : <span className="text-faint">necunoscut</span>}
                        {b.avgSource === 'manual' && <div className="text-[11px] text-faint">setat manual</div>}
                        {b.avgSource === 'broker' && <div className="text-[11px] text-faint">de la broker</div>}
                        {/* An eToro instrument without a symbol ("#1234") has nothing to attach a price to; FD-PAPER: a profile's is
                            its own fills', exact. */}
                        {!STABLE_ASSETS.has(b.asset) && account.exchange !== 'paper' && /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(b.asset) && (
                          <div>
                            <CostBasisEditor accountId={account.id} row={b} />
                          </div>
                        )}
                      </td>
                      <td className={clsx('num text-right', pnlClass(b.pnl))}>
                        {b.pnl !== null ? (
                          <>
                            {money(b.pnl, b.currency ?? p.currency)} <span className="text-[12px]">{fmtPct(b.pnlPct)}</span>
                          </>
                        ) : b.pnlPct !== null ? (
                          <span className="text-[12px]">{fmtPct(b.pnlPct)}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      {trades && (
                        <td className="text-right">
                          {(() => {
                            // Stablecoins and instruments without a symbol are not sold from here; nor a KuCoin "main" balance
                            // (it trades only once moved to the trading account, and Sentiq never moves funds).
                            const seed = STABLE_ASSETS.has(b.asset) || b.asset.startsWith('#') || b.free <= 0 || b.account === 'main' ? null : sellSeed(account, b);
                            // A holding's SL / TP once per asset (KuCoin's "main" row is the same holding).
                            const protect = STABLE_ASSETS.has(b.asset) || b.asset.startsWith('#') || b.account === 'main' ? null : holdingSeed(account, p, b);
                            return (
                              <span className="inline-flex items-center justify-end gap-1.5">
                                {protect && (
                                  <button className="btn h-8 px-2 text-[12px] whitespace-nowrap" onClick={() => onModify(protect)} aria-label={protect.title}>
                                    SL / TP
                                  </button>
                                )}
                                {seed && (
                                  <button className="btn h-8 px-2 text-[12px]" onClick={() => onTicket(seed)}>
                                    Vinde
                                  </button>
                                )}
                              </span>
                            );
                          })()}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      <Panel title="Ordine deschise" icon={ListChecks} flush>
        {p.orders.length === 0 ? (
          <div>
            <Empty>Niciun ordin deschis.</Empty>
          </div>
        ) : (
          <table className={clsx('table', trades && '[&_td]:align-middle')}>
            <thead>
              <tr>
                <th>Simbol</th>
                <th>Piață</th>
                <th>Tip</th>
                <th>Direcție</th>
                <th className="text-right">Preț</th>
                <th className="text-right">Declanșare</th>
                <th className="text-right">Cantitate</th>
                <th>Plasat</th>
                {trades && (
                  <th className="relative text-right">
                    <span className="sr-only">Acțiuni</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {p.orders.map((o) => (
                <tr key={`${o.market}-${o.id}`}>
                  <td className="font-semibold">
                    <span className="flex items-center gap-2">
                      <CoinLogo coin={o.symbol.split('/')[0] ?? o.symbol} size={18} badge={stocks} square={stocks} />
                      {stocks ? o.symbol.split('/')[0] : o.symbol}
                    </span>
                  </td>
                  <td className="text-muted">{stocks ? (o.market === 'spot' || paperAcc ? 'Acțiuni' : 'Levier / short') : paperAcc ? (o.symbol.includes(':') ? 'Futures' : 'Spot') : o.market === 'spot' ? 'Spot' : 'Futures'}</td>
                  <td>
                    {o.type}
                    {o.reduceOnly && <span className="ml-1 text-[12px] text-faint">reduce-only</span>}
                  </td>
                  <td className={o.side === 'buy' ? 'text-bull' : 'text-bear'}>
                    {o.side === 'buy' ? 'Cumpărare' : 'Vânzare'}
                    {/* FD-KUCOINHEDGE: in hedge mode, the position the order opens or closes. */}
                    {o.positionSide && <span className="ml-1 text-[12px] text-faint">{o.positionSide}</span>}
                  </td>
                  <td className="num text-right">{fmtPrice(o.price, digits(o.price, false, o.symbol))}</td>
                  <td className="num text-right">{o.triggerPrice ? fmtPrice(o.triggerPrice, digits(o.triggerPrice, false, o.symbol)) : '—'}</td>
                  <td className="num text-right">
                    {fmtNum(o.amount, 8)}
                    {o.filled ? <div className="text-[11.5px] text-faint">{fmtNum(o.filled, 8)} executat</div> : null}
                  </td>
                  <td className="num text-[12px] text-muted">{o.timestamp ? fmtDateTime(o.timestamp, tz) : '—'}</td>
                  {trades && (
                    <td className="text-right">
                      {(() => {
                        const edit = orderSeed(account, p, o);
                        const cancel = cancellable(account, o);
                        return (
                          <span className="inline-flex items-start justify-end gap-1.5">
                            {edit && (
                              <button className="btn h-8 px-2 text-[12px]" onClick={() => onModify(edit)} aria-label={`Modifică ordinul ${o.symbol}`}>
                                Modifică
                              </button>
                            )}
                            {cancel && <CancelOrderButton account={account} order={o} />}
                          </span>
                        );
                      })()}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

    </div>
  );
}

export default function TradesPage() {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<AccountView[]>('/api/accounts') });
  const [selected, setSelected] = useState<number | null>(null);
  const [wizard, setWizard] = useState(false);
  const closeWizard = useCallback(() => setWizard(false), []);
  if (!accounts.data && !accounts.isError) return <Loading />;
  if (!accounts.data) return <ErrorNote error={accounts.error} onRetry={() => accounts.refetch()} />;
  const list = accounts.data;
  const wizardEl = wizard && <AccountWizard onClose={closeWizard} onDone={(a) => setSelected(a.id)} />;
  if (list.length === 0) {
    return (
      <div className="flex w-full flex-col gap-3.5">
        <h1 className="page-title">Tranzacții</h1>
        <Panel title="Tranzacțiile tale" icon={Wallet}>
          <div className="max-w-[70ch] space-y-3 text-[14px]">
            <p>
              Conectează un exchange crypto sau un broker de acțiuni ca să vezi deținerile, pozițiile și ordinele deschise. Implicit Sentiq doar citește; poți porni tranzacționarea pe un
              cont (cu passkey-ul sau cu parola și codul 2FA), apoi trimite ordine din Sentiq, fiecare cu o confirmare.
            </p>
            <p className="text-muted">
              Crypto: KuCoin, Binance, Bybit, OKX, Kraken, Coinbase, Bitget. Acțiuni: Trading 212, eToro, Interactive Brokers, Alpaca. Pentru fiecare, wizard-ul arată cum creezi
              cheia: pentru citire și, dacă vrei să tranzacționezi din Sentiq, cu tranzacționare; niciodată cu retrageri. Restricționează cheia la IP-urile serverului Sentiq,
              afișate acolo.
            </p>
            <button className="btn btn-primary" onClick={() => setWizard(true)}>
              <Plus size={15} aria-hidden /> Adaugă un cont
            </button>
          </div>
        </Panel>
        {wizardEl}
      </div>
    );
  }
  const current = list.find((a) => a.id === selected) ?? list[0]!;
  return <AccountsView list={list} current={current} onSelect={setSelected} onAdd={() => setWizard(true)} wizardEl={wizardEl} />;
}

/** FD-TRADESMOBILE: an account's button; on a phone a little smaller, its text over two lines when it must. */
const ACCOUNT_BTN = 'btn max-sm:min-h-[44px] max-sm:px-2.5 max-sm:text-[12.5px] max-sm:leading-tight max-sm:text-center';

/** The page with accounts: the top row (accounts, „Reîmprospătează”, „Adaugă un cont”) and the chosen account. */
function AccountsView({ list, current, onSelect, onAdd, wizardEl }: { list: AccountView[]; current: AccountView; onSelect: (id: number) => void; onAdd: () => void; wizardEl: React.ReactNode }) {
  const [period, setPeriod] = useState<StatsPeriod>(readPeriod);
  const choosePeriod = useCallback((v: StatsPeriod) => {
    setPeriod(v);
    writePeriod(v);
  }, []);
  const refresh = useRefreshAccount(current, period);
  // A failed refresh belongs to the account it was for: switching accounts clears its warning.
  const resetRefresh = refresh.reset;
  useEffect(() => resetRefresh(), [current.id, resetRefresh]);
  // FD-TRADING: the order form (from a button or a row) and the switch.
  const [ticket, setTicket] = useState<TicketSeed | null>(null);
  const [enabling, setEnabling] = useState(false);
  const disable = useDisableTrading(current);
  const closeTicket = useCallback(() => setTicket(null), []);
  // FD-ORDEREDIT: a position's SL / TP, or an open order, being changed.
  const [modify, setModify] = useState<ModifySeed | null>(null);
  const closeModify = useCallback(() => setModify(null), []);
  // FD-REVERSE: a position being turned the other way.
  const [reverse, setReverse] = useState<{ accountId: number; symbol: string; side: 'long' | 'short' } | null>(null);
  const closeReverse = useCallback(() => setReverse(null), []);
  const closeEnabling = useCallback(() => setEnabling(false), []);
  // FD-TRADESMOBILE: on a phone the accounts' row scrolls sideways; the chosen one is brought into view, sideways only
  // (scrollIntoView could move the page too).
  const accountsRow = useRef<HTMLDivElement>(null);
  useRevealInRow(accountsRow, current.id);
  const paper = current.exchange === 'paper';
  const [paperDialog, setPaperDialog] = useState<'settings' | 'reset' | null>(null);
  const closePaperDialog = useCallback(() => setPaperDialog(null), []);
  return (
    <div className="flex w-full flex-col gap-3.5">
      {/* FD-TRADESMOBILE: on a phone everything below the title takes the full width, a row each: the accounts, the
          period (its label above it), „Ordin nou”, the account's buttons two by two, all of one size. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <h1 className="page-title">Tranzacții</h1>
        <div ref={accountsRow} className="seg max-sm:row-fill" role="group" aria-label="Cont">
          {list.map((a) => (
            <button
              key={a.id}
              type="button"
              aria-pressed={a.id === current.id}
              onClick={() => onSelect(a.id)}
              className="inline-flex items-center gap-1.5"
            >
              <ProviderLogo id={a.exchange} size={16} />
              {a.label}
              {a.exchange === 'paper' && <PaperBadge />}
            </button>
          ))}
        </div>
        {/* FD-TRADESTATS §2, FD-UIPOLISH: the period of the closed trades and the buttons share the top row (FD-BROKERSTATS: every account). */}
        <div className="flex flex-col gap-3 sm:ml-auto sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <span id="trades-period" className="text-[12.5px] text-muted">
              Tranzacții închise în
            </span>
            <div className="seg max-sm:row-fill" role="group" aria-labelledby="trades-period">
              {PERIODS.map((x) => (
                <button key={x.id} type="button" aria-pressed={x.id === period} onClick={() => x.id !== period && choosePeriod(x.id)}>
                  {x.label}
                </button>
              ))}
            </div>
          </div>
          {current.trading.enabled && (
            <button className="btn btn-primary max-sm:w-full" onClick={() => setTicket({ accountId: current.id, kind: current.kind })}>
              <ArrowRightLeft size={14} aria-hidden /> Ordin nou
            </button>
          )}
          {/* Two by two on a phone, each as wide and tall as the others; FIX-MOBILESYM2: an odd last one takes the whole
              row, as the odd last card does (never centred). On a wide screen the grid is gone (`contents`): the buttons stay in
              the row. */}
          <div className="grid grid-cols-2 gap-2 sm:contents max-sm:[&>:last-child:nth-child(odd)]:col-span-2">
            {/* FD-PAPER §6: a profile trades always: its settings and its reset instead of the switch. */}
            {paper ? (
              <>
                <button className={ACCOUNT_BTN} onClick={() => setPaperDialog('settings')}>
                  <Settings2 size={14} className="shrink-0" aria-hidden /> Setări profil
                </button>
                <button className={ACCOUNT_BTN} onClick={() => setPaperDialog('reset')}>
                  <RotateCcw size={14} className="shrink-0" aria-hidden /> Resetează
                </button>
              </>
            ) : current.trading.enabled ? (
              <button
                className={ACCOUNT_BTN}
                disabled={disable.isPending}
                title="Oprește tranzacționarea pe acest cont"
                onClick={() => {
                  if (window.confirm(`Oprești tranzacționarea pe „${current.label}”? Ordinele deja plasate rămân pe platformă.`)) disable.mutate();
                }}
              >
                <Power size={14} className="shrink-0" aria-hidden /> Oprește tranzacționarea
              </button>
            ) : (
              current.trading.supported && (
                <button className={ACCOUNT_BTN} onClick={() => setEnabling(true)}>
                  <ArrowRightLeft size={14} className="shrink-0" aria-hidden /> Pornește tranzacționarea
                </button>
              )
            )}
            <button className={ACCOUNT_BTN} onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <RefreshCw size={14} className={clsx('shrink-0', refresh.isPending && 'animate-spin')} aria-hidden /> Reîmprospătează
            </button>
            <button className={ACCOUNT_BTN} onClick={onAdd}>
              <Plus size={15} className="shrink-0" aria-hidden /> Adaugă un cont
            </button>
          </div>
        </div>
      </div>
      {refresh.isError && <Warning>Reîmprospătarea nu a reușit: {errorMessage(refresh.error)}</Warning>}
      {disable.isError && <Warning>Tranzacționarea nu a putut fi oprită: {errorMessage(disable.error)}</Warning>}
      {current.fundsRisk ? (
        <FundsRiskNote account={current} />
      ) : (
        current.permissionWarning &&
        !current.trading.enabled && (
          <Warning>
            Cheia „{current.label}” poate face mai mult decât citire ({current.permissions}). Ca să tranzacționezi cu ea din Sentiq, pornește tranzacționarea; dacă nu vrei,
            ajunge o cheie doar pentru citire.
          </Warning>
        )
      )}
      {current.trading.reason && <p className="text-[12.5px] text-faint">{current.trading.reason} Contul rămâne doar pentru citire.</p>}
      {current.lastError && <Warning>Ultima eroare: {current.lastError}</Warning>}
      <PortfolioView key={current.id} account={current} period={period} onTicket={setTicket} onModify={setModify} onReverse={(r) => setReverse({ ...r, accountId: current.id })} />
      {/* FD-TRADES: apart from the portfolio, so a platform that cannot be read still shows its bots' trades. FIX-TRADESWITCH:
          its own key, unlike the portfolio's (two siblings with one key left the old account's panels on screen). */}
      <TradeHistoryPanel key={`history-${current.id}`} account={current} period={period} />
      {wizardEl}
      {ticket && <OrderTicket seed={ticket} onClose={closeTicket} />}
      {modify && modify.account.id === current.id && <ModifyTicket seed={modify} onClose={closeModify} />}
      {reverse && reverse.accountId === current.id && <ReverseDialog account={current} symbol={reverse.symbol} side={reverse.side} onClose={closeReverse} />}
      {enabling && <EnableTradingDialog account={current} onClose={closeEnabling} />}
      {paper && paperDialog === 'settings' && <PaperSettingsDialog account={current} onClose={closePaperDialog} />}
      {paper && paperDialog === 'reset' && <PaperResetDialog account={current} onClose={closePaperDialog} />}
    </div>
  );
}
