// FD-WATCHLISTS §3: the "Date financiare" popup of a watch-list row. The description first (as its source wrote it, no
// translation since 18 Nov 2026), then, for a stock, its last four quarters and the next results; a coin or an index has
// its description only.
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import type { ProfileQuarter, SymbolProfile, WatchItem } from '../../shared/api-types.ts';
import { plainSymbol } from '../../shared/indices.ts';
import { api, qs } from '../api.ts';
import { fmtPct, fmtUsd } from '../format.ts';
import { CoinLogo } from './icons.tsx';
import { Modal } from './Modal.tsx';
import { ErrorNote, Loading } from './ui.tsx';

const MONTHS = ['ian.', 'feb.', 'mar.', 'apr.', 'mai', 'iun.', 'iul.', 'aug.', 'sept.', 'oct.', 'nov.', 'dec.'];
/** "2026-06-30" → "iun. 2026". */
export const quarterLabel = (end: string) => `${MONTHS[Number(end.slice(5, 7)) - 1] ?? ''} ${end.slice(0, 4)}`.trim();
/** "2026-10-21" → "21 oct. 2026". */
const dayLabel = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''} ${day.slice(0, 4)}`;
const WHEN: Record<string, string> = { pre: 'înainte de deschiderea bursei', after: 'după închiderea bursei', unknown: 'ora nu e anunțată' };

/** A margin, when both amounts are known and the revenue is positive. */
const margin = (part: number | null, revenue: number | null) => (part !== null && revenue !== null && revenue > 0 ? part / revenue : null);

const tone = (v: number | null) => (v !== null && v < 0 ? 'text-bear' : undefined);

function Rows({ quarters }: { quarters: ProfileQuarter[] }) {
  const rows: { label: string; value: (q: ProfileQuarter) => number | null; money: 'big' | 'eps'; sub?: (q: ProfileQuarter) => string | null }[] = [
    { label: 'Venituri', value: (q) => q.revenue, money: 'big', sub: (q) => (q.revenueYoY !== null ? `${fmtPct(q.revenueYoY * 100, 1)} față de anul trecut` : null) },
    { label: 'Profit brut', value: (q) => q.grossProfit, money: 'big', sub: (q) => (margin(q.grossProfit, q.revenue) !== null ? `marjă ${fmtPct((margin(q.grossProfit, q.revenue) as number) * 100, 1, false)}` : null) },
    { label: 'EBITDA', value: (q) => q.ebitda, money: 'big' },
    { label: 'Profit net', value: (q) => q.netIncome, money: 'big', sub: (q) => (margin(q.netIncome, q.revenue) !== null ? `marjă ${fmtPct((margin(q.netIncome, q.revenue) as number) * 100, 1, false)}` : null) },
    { label: 'EPS diluat', value: (q) => q.eps, money: 'eps', sub: (q) => (q.epsYoY !== null ? `${fmtPct(q.epsYoY * 100, 1)} față de anul trecut` : null) },
    { label: 'Flux de numerar liber', value: (q) => q.freeCashFlow, money: 'big' },
  ];
  return (
    <div className="table-bleed relative overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Trimestrul încheiat în</th>
            {quarters.map((q) => (
              <th key={q.end} className="text-right">
                {quarterLabel(q.end)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="font-medium whitespace-nowrap">{r.label}</td>
              {quarters.map((q) => {
                const v = r.value(q);
                const sub = r.sub?.(q) ?? null;
                return (
                  <td key={q.end} className="text-right whitespace-nowrap">
                    <span className={clsx('num', tone(v))}>{v === null ? '—' : r.money === 'big' ? fmtUsd(v, true) : fmtUsd(v)}</span>
                    {sub && <span className="block text-[11.5px] text-faint">{sub}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The description as its source wrote it (18 Nov 2026: no translation into Romanian, it spent the user's AI tokens). */
function Description({ p }: { p: SymbolProfile }) {
  if (!p.description) {
    const problem = p.problems.find((x) => x.part === 'description');
    return <p className="text-[13px] text-faint">{problem ? `Descrierea nu s-a putut încărca acum (${problem.message}).` : 'Descrierea nu e disponibilă.'}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {p.description.text.split('\n\n').map((para, i) => (
        <p key={i} className="text-[13.5px] leading-relaxed text-text">
          {para}
        </p>
      ))}
      <p className="text-[12px] text-faint">Sursa: {p.description.source}.</p>
    </div>
  );
}

export function SymbolInfo({ item, onClose }: { item: WatchItem; onClose: () => void }) {
  const profile = useQuery({
    queryKey: ['profile', item.kind, item.coin],
    queryFn: () => api.get<SymbolProfile>(`/api/symbols/profile${qs({ kind: item.kind, symbol: item.coin })}`),
    staleTime: 10 * 60_000,
  });
  const p = profile.data;
  const shown = plainSymbol(item.coin);
  const results = p?.problems.find((x) => x.part === 'results');
  return (
    <Modal
      width={860}
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2.5">
          <CoinLogo coin={item.coin} size={22} badge={item.kind === 'stock'} square={item.kind === 'stock'} fx={item.kind === 'forex' || item.kind === 'commodity' ? item.kind : undefined} />
          <span className="truncate">
            {shown}
            {(p?.name ?? item.name) && <span className="font-normal text-muted"> · {p?.name ?? item.name}</span>}
          </span>
        </span>
      }
    >
      {!p ? (
        profile.isError ? (
          <ErrorNote error={profile.error} onRetry={() => profile.refetch()} />
        ) : (
          <Loading label="Se încarcă datele…" />
        )
      ) : (
        <div className="flex flex-col gap-5">
          <section aria-labelledby="info-desc" className="flex flex-col gap-2">
            <h3 id="info-desc" className="text-[13px] font-semibold text-muted">
              Descriere
            </h3>
            <Description p={p} />
            {p.facts.length > 0 && (
              <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
                {p.facts.map((f) => (
                  <div key={f.label} className="contents">
                    <dt className="text-faint">{f.label}</dt>
                    <dd className="min-w-0 [overflow-wrap:anywhere]">
                      {f.href ? (
                        <a href={f.href} target="_blank" rel="noreferrer" className="text-accent">
                          {f.value}
                        </a>
                      ) : (
                        f.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section aria-labelledby="info-results" className="flex flex-col gap-2">
            <h3 id="info-results" className="text-[13px] font-semibold text-muted">
              Rezultate trimestriale
            </h3>
            {p.kind === 'crypto' ? (
              <p className="text-[13px] text-faint">Monedele nu publică rezultate financiare.</p>
            ) : p.kind === 'index' ? (
              <p className="text-[13px] text-faint">Un indice nu are rezultate financiare.</p>
            ) : p.kind === 'forex' || p.kind === 'commodity' ? (
              <p className="text-[13px] text-faint">{p.kind === 'forex' ? 'O pereche valutară nu are rezultate financiare.' : 'O marfă nu are rezultate financiare.'}</p>
            ) : p.kind === 'fund' ? (
              <p className="text-[13px] text-faint">Fond tranzacționat la bursă (ETF): fondurile nu publică rezultate trimestriale.</p>
            ) : p.quarters.length === 0 ? (
              <p className="text-[13px] text-faint">{results ? `Rezultatele nu s-au putut încărca acum (${results.message}).` : 'Rezultatele trimestriale nu sunt disponibile pentru acest simbol.'}</p>
            ) : (
              <>
                <Rows quarters={p.quarters} />
                <p className="text-[12px] text-faint">{p.quarters.length === 1 ? 'Ultimul trimestru raportat' : `Ultimele ${p.quarters.length} trimestre raportate`}, în dolari (TradingView).</p>
              </>
            )}
            {p.next && (
              <p className="text-[13px] text-muted">
                Următoarele rezultate: <span className="text-text">{dayLabel(p.next.day)}</span>, {WHEN[p.next.time]} ({p.next.confirmed ? 'confirmat' : 'dată estimată'})
                {p.next.eps !== null ? ` · EPS estimat ${fmtUsd(p.next.eps)}` : ''}.
              </p>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
