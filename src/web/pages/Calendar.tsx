import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Building2, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { CalendarEvent, CalendarResponse } from '../../shared/api-types.ts';
import { CALENDAR_CURRENCIES, IMPACTS, type SettingsView } from '../../shared/settings.ts';
import { addDays, dayBounds, dayKey, zonedTimeToUtc } from '../../shared/time.ts';
import { api, errorMessage, qs } from '../api.ts';
import { fmtCountdown, fmtTime, fmtUsd, fmtWeekday } from '../format.ts';
import { useNow, useSettings, useTz } from '../hooks.ts';
import { ErrorNote, ImpactMark, Loading, Warning } from '../components/ui.tsx';
import { EventIcon } from '../components/icons.tsx';

const IMPACT_RO: Record<string, string> = { High: 'Mare', Medium: 'Mediu', Low: 'Mic', Holiday: 'Sărbători' };
const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase('ro-RO') + s.slice(1);

function weekStart(day: string): string {
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
}

function Deviation({ e }: { e: CalendarEvent }) {
  if (e.deviation === null) return null;
  if (e.deviation === 0) return <span className="text-muted">= așteptări</span>;
  return <span className={e.deviation > 0 ? 'text-link' : 'text-warn'}>{e.deviation > 0 ? '▲ peste așteptări' : '▼ sub așteptări'}</span>;
}

/** FD-CALACTUAL §2: the value announced, by how it compares with the forecast (none, or equal: the text's colour). */
const actualTone = (d: number | null) => (d === null || d === 0 ? 'bg-text/10 text-text' : d > 0 ? 'bg-link/12 text-link' : 'bg-warn/12 text-warn');
/** FD-CALACTUALBIG: an amount shortened, with the currency's symbol so it fits a day's column: "18,52 mld. $". */
function revenueText(v: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: currency ?? 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 2 }).format(v);
  } catch {
    return fmtUsd(v, true);
  }
}

/**
 * FD-CALACTUALBIG: a value announced as one element, its label and the value at the same size, coloured by the
 * surprise; a long one ("Venituri 18,52 mld. $" in a narrow day) breaks only between the two, inside the label.
 */
function Announced({ label, value, delta, title }: { label: string; value: string; delta: number | null; title: string }) {
  return (
    <span className={clsx('num inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 self-start rounded-md px-1.5 text-[15px] leading-6 font-bold', actualTone(delta))} title={title}>
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}

function CustomEventForm({ tz, onDone }: { tz: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(dayKey(Date.now(), tz));
  const [time, setTime] = useState('16:00');
  const [allDay, setAllDay] = useState(false);
  const [impact, setImpact] = useState<'High' | 'Medium' | 'Low'>('Medium');
  const [note, setNote] = useState('');
  const add = useMutation({
    mutationFn: () => {
      const [h, m] = time.split(':').map(Number);
      const ts = allDay ? zonedTimeToUtc(date, tz) : zonedTimeToUtc(date, tz, h ?? 0, m ?? 0);
      return api.post('/api/calendar/custom', { title, ts, allDay, impact, currency: 'CRYPTO', note });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      onDone();
    },
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_150px_110px_auto_130px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) add.mutate();
      }}
    >
      <label className="flex flex-col gap-1.5 text-[13.5px] font-semibold">
        <span>Eveniment</span>
        <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ex. Token unlock ARB" className="font-normal" />
      </label>
      <label className="flex flex-col gap-1.5 text-[13.5px] font-semibold">
        <span>Data</span>
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="font-normal" />
      </label>
      <label className="flex flex-col gap-1.5 text-[13.5px] font-semibold">
        <span>Ora</span>
        <input type="time" value={time} disabled={allDay} onChange={(e) => setTime(e.target.value)} className="font-normal" />
      </label>
      <label className="flex items-center gap-2.5 self-end pb-2.5 text-[13.5px]">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> Toată ziua
      </label>
      <label className="flex flex-col gap-1.5 text-[13.5px] font-semibold">
        <span>Impact</span>
        <select value={impact} onChange={(e) => setImpact(e.target.value as typeof impact)} className="font-normal">
          <option value="High">Mare</option>
          <option value="Medium">Mediu</option>
          <option value="Low">Mic</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-[13.5px] font-semibold sm:col-span-4">
        <span>Notă (opțional)</span>
        <input maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className="font-normal" />
      </label>
      <div className="flex items-end gap-2">
        <button className="btn btn-primary" disabled={add.isPending || !title.trim()}>
          Adaugă evenimentul
        </button>
      </div>
      {add.isError && <div className="text-[13px] text-bear sm:col-span-5">{errorMessage(add.error)}</div>}
    </form>
  );
}

const DAY_SHORT = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return capitalize(new Intl.DateTimeFormat('ro-RO', { weekday: 'long', day: 'numeric', timeZone: 'UTC' }).format(d));
};

function EventCard({ e, now, tz, next, onDelete }: { e: CalendarEvent; now: number; tz: string; next: boolean; onDelete: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const live = !e.allDay && Math.abs(e.ts - now) <= 2 * 60_000;
  const past = e.ts < now && !live;
  const high = e.impact === 'High';
  const hasDetails = Boolean(e.note) || e.deviation !== null || e.source === 'custom';
  // Only a card with something to show is a button; the others are plain content.
  const Summary = hasDetails ? 'button' : 'div';
  return (
    <article
      className={clsx(
        'rounded-[10px] border text-[13px] transition-colors',
        live ? 'border-accent bg-accent/10' : high && !past ? 'border-bear/35 bg-bear/[0.07]' : 'border-line-soft bg-panel-2',
      )}
    >
      <Summary
        className={clsx('flex w-full flex-col gap-1 rounded-[9px] px-2.5 py-2 text-left', hasDetails && 'transition-colors hover:bg-hover')}
        {...(hasDetails ? { type: 'button' as const, onClick: () => setOpen((o) => !o), 'aria-expanded': open } : {})}
      >
        <span className="flex w-full items-center justify-between gap-2 text-[12px]">
          <span className={clsx('num', high && !past ? 'font-semibold text-text' : 'text-muted')}>{e.allDay ? 'toată ziua' : fmtTime(e.ts, tz)}</span>
          <ImpactMark impact={e.impact} label={e.currency === 'ALL' ? 'Global' : e.currency} />
        </span>
        {/* Past events are toned down by colour, not opacity, so small text keeps its contrast. */}
        <span className={clsx('flex gap-2 leading-snug', high && !past && 'font-semibold', past && 'text-muted')}>
          <EventIcon title={e.title} impact={e.impact} source={e.source} symbol={e.currency} size={14} className={clsx('mt-[3px]', past ? 'text-faint' : high ? 'text-impact-high' : 'text-muted')} />
          <span>
            {e.title}
            {e.source === 'custom' && <span className="tag ml-1.5 align-middle font-normal">personal</span>}
          </span>
        </span>
        {/* FD-CALACTUAL §2, FD-CALACTUALBIG: the value announced as one large label ("Act." and the value); the forecast and
            the previous value under it, small. A company's results: EPS and revenue, each with its forecast under it. */}
        {e.results && e.actual ? (
          <>
            <Announced label="EPS" value={e.actual} delta={e.deviation} title="EPS-ul raportat" />
            {e.forecast && <span className="num text-[11.5px] text-muted" title="Prognoză">Prog. {e.forecast}</span>}
            {e.results.revenue !== null && (
              <>
                <Announced
                  label="Venituri"
                  value={revenueText(e.results.revenue, e.results.currency)}
                  delta={e.results.revenueForecast !== null ? e.results.revenue - e.results.revenueForecast : null}
                  title="Veniturile raportate"
                />
                {e.results.revenueForecast !== null && (
                  <span className="num text-[11.5px] text-muted" title="Prognoză">
                    Prog. {revenueText(e.results.revenueForecast, e.results.currency)}
                  </span>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {e.actual ? (
              <Announced label="Act." value={e.actual} delta={e.deviation} title="Valoarea anunțată" />
            ) : past && e.forecast && now - e.ts < 15 * 60_000 ? (
              <span className="text-[11.5px] text-faint">în așteptare</span>
            ) : null}
            {(e.forecast || e.previous) && (
              <span className="num flex w-full flex-wrap justify-between gap-x-2 text-[11.5px] text-muted">
                {e.forecast && <span title="Prognoză">Prog. {e.forecast}</span>}
                {e.previous && <span title="Anterior">Ant. {e.previous}</span>}
              </span>
            )}
          </>
        )}
        {next && !past && <span className="num text-[12px] font-semibold text-accent">în {fmtCountdown(e.ts, now)}</span>}
      </Summary>
      {open && hasDetails && (
        <div className="flex flex-col gap-1.5 border-t border-line-strong/60 px-2.5 py-2 text-[12px]">
          {e.note && <p className="text-muted">{e.note}</p>}
          {e.deviation !== null && (
            <p>
              <Deviation e={e} />
            </p>
          )}
          {e.source === 'custom' && (
            <button className="inline-flex items-center gap-1.5 self-start text-faint hover:text-bear" onClick={() => onDelete(e.id)}>
              <Trash2 size={13} aria-hidden /> Șterge evenimentul
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export default function CalendarPage() {
  const tz = useTz();
  const now = useNow(1000);
  const qc = useQueryClient();
  const settings = useSettings();
  const [week, setWeek] = useState(() => weekStart(dayKey(Date.now(), tz)));
  const [adding, setAdding] = useState(false);
  const impacts = settings.data?.calendar.impacts ?? ['High', 'Medium'];
  const currencies = settings.data?.calendar.currencies ?? ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'ALL'];
  // Quarterly results of the watchlist stocks (FD-SENTIQ §4.5); on unless switched off.
  const earnings = settings.data?.calendar.earnings !== false;
  const from = dayBounds(week, tz).start;
  const to = dayBounds(addDays(week, 7), tz).start;
  const q = useQuery({
    queryKey: ['calendar', 'week', from, impacts.join(), currencies.join(), earnings],
    queryFn: () => api.get<CalendarResponse>(`/api/calendar${qs({ from, to, impact: impacts, currencies, earnings: earnings ? '1' : '0' })}`),
    refetchInterval: 60_000,
    enabled: settings.isSuccess,
  });
  const saveFilters = useMutation({
    mutationFn: (calendar: { impacts: string[]; currencies: string[]; earnings: boolean }) => api.put<SettingsView>('/api/settings', { calendar }),
    // Optimistic: the next click builds on what the user already sees, not on a stale server answer.
    onMutate: (calendar) => {
      const prev = qc.getQueryData<SettingsView>(['settings']);
      if (prev) qc.setQueryData<SettingsView>(['settings'], { ...prev, calendar: calendar as SettingsView['calendar'] });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['settings'], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/calendar/custom/${id.replace('custom:', '')}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar'] }),
  });

  // At least one option stays selected: an empty filter would silently mean "everything".
  const toggle = (list: string[], v: string) => (list.includes(v) ? (list.length > 1 ? list.filter((x) => x !== v) : list) : [...list, v]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of q.data?.events ?? []) {
      const d = dayKey(e.ts, tz);
      m.set(d, [...(m.get(d) ?? []), e]);
    }
    return m;
  }, [q.data, tz]);
  const days = Array.from({ length: 7 }, (_, k) => addDays(week, k));
  const fromFallback = (q.data?.events ?? []).some((e) => e.source === 'tv');
  const nextHigh = (q.data?.events ?? []).find((e) => e.impact === 'High' && !e.allDay && e.ts > now);
  const todayKey = dayKey(now, tz);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <h1 className="page-title">Calendar economic</h1>
          {/* FD-MOBILESYM §4: on a phone across the width, the middle button stretching between the arrows. */}
          <div className="flex items-center gap-1.5 max-sm:w-full">
            <button className="btn w-[38px] shrink-0 px-0" aria-label="Săptămâna anterioară" onClick={() => setWeek(addDays(week, -7))}>
              <ChevronLeft size={16} aria-hidden />
            </button>
            <button className="btn max-sm:flex-1" onClick={() => setWeek(weekStart(todayKey))}>
              Săptămâna curentă
            </button>
            <button className="btn w-[38px] shrink-0 px-0" aria-label="Săptămâna următoare" onClick={() => setWeek(addDays(week, 7))}>
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>
          <span className="text-muted">
            {fmtWeekday(from, tz)} – {fmtWeekday(to - 1, tz)}
          </span>
        </div>
        {nextHigh && (
          <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
            <EventIcon title={nextHigh.title} impact={nextHigh.impact} source={nextHigh.source} symbol={nextHigh.currency} className="text-impact-high" />
            <span className="text-muted">Următorul major:</span>
            <strong className="font-semibold">
              {nextHigh.currency === 'ALL' ? 'Global' : nextHigh.currency} {nextHigh.title}
            </strong>
            <span className="num font-semibold text-accent">în {fmtCountdown(nextHigh.ts, now)}</span>
          </span>
        )}
      </div>

      {/* FD-MOBILESYM §4: on a phone each group on its own row, scrolling sideways; the two buttons a pair. */}
      <div role="toolbar" aria-label="Filtre" className="panel flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-[14px] px-3 py-2.5 max-sm:flex-col max-sm:items-stretch">
        <div role="group" aria-label="Impact" className="flex flex-wrap items-center gap-1.5 max-sm:row-fill">
          {IMPACTS.map((i) => (
            <button key={i} type="button" className="chip" aria-pressed={impacts.includes(i)} onClick={() => saveFilters.mutate({ impacts: toggle(impacts, i), currencies, earnings })}>
              {IMPACT_RO[i]}
            </button>
          ))}
        </div>
        <span className="h-5 w-px bg-line-strong max-sm:hidden" aria-hidden />
        <div role="group" aria-label="Valute" className="flex flex-wrap items-center gap-1.5 max-sm:row-fill">
          {CALENDAR_CURRENCIES.map((c) => (
            <button key={c} type="button" className="chip" aria-pressed={currencies.includes(c)} onClick={() => saveFilters.mutate({ impacts, currencies: toggle(currencies, c), earnings })}>
              {c === 'ALL' ? 'Global' : c}
            </button>
          ))}
        </div>
        <span className="h-5 w-px bg-line-strong max-sm:hidden" aria-hidden />
        <div className="grid grid-cols-2 gap-2 sm:contents">
          <button
            type="button"
            className="chip gap-1.5 max-sm:min-h-11 max-sm:justify-center"
            aria-pressed={earnings}
            title="Rezultatele trimestriale ale acțiunilor din listele tale de urmărire (Nasdaq; data confirmată de la TradingView)"
            onClick={() => saveFilters.mutate({ impacts, currencies, earnings: !earnings })}
          >
            <Building2 size={14} aria-hidden /> Rezultate companii
          </button>
          <button className="btn ml-auto max-sm:ml-0 max-sm:min-h-11 max-sm:px-2.5 max-sm:text-[12.5px]" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            <Plus size={16} aria-hidden /> Eveniment personal
          </button>
        </div>
        {adding && (
          <div className="w-full border-t border-line pt-3">
            <CustomEventForm tz={tz} onDone={() => setAdding(false)} />
          </div>
        )}
      </div>

      {q.data?.ffBlockedUntil && (
        <Warning>ForexFactory a limitat temporar accesul. Până la {fmtTime(q.data.ffBlockedUntil, tz)} lista vine din ultima descărcare și din TradingView.</Warning>
      )}
      {fromFallback && <Warning>Pentru unele zile din această săptămână nu există date ForexFactory; acele evenimente și impactul lor vin de la TradingView.</Warning>}
      {del.isError && <ErrorNote error={del.error} />}

      {!q.data && !q.isError ? (
        <Loading />
      ) : !q.data ? (
        <ErrorNote error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid items-start gap-2.5 xl:grid-cols-7">
          {days.map((day) => {
            const events = byDay.get(day) ?? [];
            const isToday = day === todayKey;
            return (
              <section
                key={day}
                aria-label={`${capitalize(fmtWeekday(dayBounds(day, tz).start, tz))}${isToday ? ', azi' : ''}`}
                className={clsx('panel flex flex-col gap-2 rounded-2xl p-3', isToday && 'border-accent-dim/70')}
              >
                <div className="flex items-baseline justify-between gap-2 px-0.5">
                  <span className={clsx('font-semibold', isToday && 'text-accent')}>{DAY_SHORT(day)}</span>
                  <span className={clsx('text-[11.5px]', isToday ? 'text-accent' : 'text-faint')}>{isToday ? 'azi' : events.length > 0 ? events.length : ''}</span>
                </div>
                {events.length === 0 ? (
                  <p className="px-0.5 py-2 text-[12.5px] text-faint">Niciun eveniment pentru filtrele alese.</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-1">
                    {events.map((e) => (
                      <EventCard key={e.id} e={e} now={now} tz={tz} next={nextHigh?.id === e.id} onDelete={(id) => del.mutate(id)} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
