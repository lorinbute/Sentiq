// FD-PAPER §2: a Paper Trading profile: made (its name, market, budget and commission), its settings changed (the name
// and the commission), reset with a new budget; and its badge wherever an account is named.
import { useId, useState } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';
import type { AccountView } from '../../shared/api-types.ts';
import { COMMISSION_MAX, COMMISSION_TYPE_RO, PAPER_DEFAULT_BUDGET, PAPER_DEFAULT_COMMISSION, PAPER_KIND_RO, PAPER_MAX_BUDGET, PAPER_MIN_BUDGET, commissionText, type CommissionType, type PaperKind } from '../../shared/paper.ts';
import { api, errorMessage } from '../api.ts';
import { Modal } from './Modal.tsx';
import { Seg } from './ui.tsx';

/** A typed number: '' is none, a comma is a decimal point, spaces and dots between thousands are left out. */
function readAmount(s: string): number | null {
  const t = s.trim().replace(/\s/g, '');
  if (t === '') return null;
  // "100.000" / "100 000" (thousands) or "0,1" (decimals).
  const v = Number(/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(',', '.'));
  return Number.isFinite(v) ? v : Number.NaN;
}

const plain = (v: number) => new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 4 }).format(v);

/** After a profile changed: the accounts, what each trades, its portfolio and history read again. */
export function afterPaperChange(qc: QueryClient, accountId?: number) {
  void qc.invalidateQueries({ queryKey: ['accounts'] });
  void qc.invalidateQueries({ queryKey: ['trading'] });
  if (accountId !== undefined) {
    void qc.invalidateQueries({ queryKey: ['portfolio', accountId] });
    // A reset empties the history: its statistics and rows are read again too.
    void qc.invalidateQueries({ queryKey: ['portfolio-stats', accountId] });
    void qc.invalidateQueries({ queryKey: ['portfolio-history', accountId] });
  }
  void qc.invalidateQueries({ queryKey: ['bots'] });
}

/** „Paper”, next to an account's name: its orders are never real. */
export function PaperBadge({ className }: { className?: string }) {
  // On a chosen button (the accent behind it) the badge takes the button's text colour, so it stays visible.
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-[5px] border border-accent/50 bg-accent/10 px-1.5 text-[10.5px] leading-[16px] font-semibold tracking-wide text-accent uppercase [[aria-pressed=true]_&]:border-current/45 [[aria-pressed=true]_&]:bg-transparent [[aria-pressed=true]_&]:text-current ${className ?? ''}`}
    >
      Paper
    </span>
  );
}

/** The commission's two fields: its kind (percent / fixed) and its value with its unit. */
function CommissionFields({ type, value, onType, onValue }: { type: CommissionType; value: string; onType: (t: CommissionType) => void; onValue: (v: string) => void }) {
  const id = useId();
  return (
    <>
      <div className="flex flex-col gap-1.5 text-[13px]">
        <span className="text-muted">Tip comision</span>
        <Seg label="Tip comision" value={type} options={(['percent', 'fixed'] as const).map((t) => ({ value: t, label: COMMISSION_TYPE_RO[t] }))} onChange={onType} className="max-sm:row-fill" />
      </div>
      <label htmlFor={id} className="flex flex-col gap-1.5 text-[13px]">
        <span className="text-muted">{type === 'percent' ? 'Comision (% din valoarea fiecărei execuții)' : 'Comision (USD pe fiecare execuție)'}</span>
        <input id={id} inputMode="decimal" value={value} onChange={(e) => onValue(e.target.value)} className="num w-full" />
      </label>
    </>
  );
}

/** What is wrong with a commission typed, or null. */
function commissionError(type: CommissionType, v: number | null): string | null {
  if (v === null || Number.isNaN(v)) return 'Comisionul: un număr (0 pentru fără comision).';
  if (v < 0) return 'Comisionul nu poate fi negativ.';
  if (v > COMMISSION_MAX[type]) return type === 'percent' ? 'Comisionul: cel mult 10%.' : 'Comisionul: cel mult 10.000 USD pe execuție.';
  return null;
}

function budgetError(v: number | null): string | null {
  if (v === null || Number.isNaN(v)) return 'Bugetul: un număr, în USD.';
  if (v < PAPER_MIN_BUDGET) return `Bugetul: cel puțin ${PAPER_MIN_BUDGET} USD.`;
  if (v > PAPER_MAX_BUDGET) return 'Bugetul: cel mult 1.000.000.000 USD.';
  return null;
}

function ErrorBox({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div role="alert" className="rounded-lg border border-bear/40 bg-bear/[0.07] px-3 py-2.5 text-[13px] text-bear">
      {text}
    </div>
  );
}

/** The wizard's form for a new profile (Adaugă un cont → Paper Trading). */
export function PaperForm({ onBack, onCreated }: { onBack: () => void; onCreated: (a: AccountView) => void }) {
  const qc = useQueryClient();
  const nameId = useId();
  const budgetId = useId();
  const [label, setLabel] = useState('Paper Trading');
  const [kind, setKind] = useState<PaperKind>('crypto');
  const [budget, setBudget] = useState(plain(PAPER_DEFAULT_BUDGET));
  const [type, setType] = useState<CommissionType>(PAPER_DEFAULT_COMMISSION.type);
  const [value, setValue] = useState(plain(PAPER_DEFAULT_COMMISSION.value));
  const [local, setLocal] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<AccountView>('/api/accounts/paper', body),
    onSuccess: (a) => {
      afterPaperChange(qc, a.id);
      onCreated(a);
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const b = readAmount(budget);
    const c = readAmount(value);
    const problem = !label.trim() ? 'Numele lipsește.' : (budgetError(b) ?? commissionError(type, c));
    setLocal(problem);
    if (!problem) create.mutate({ label: label.trim(), kind, budget: b, commissionType: type, commissionValue: c });
  };
  const error = local ?? (create.isError ? errorMessage(create.error) : null);
  return (
    <div className="grid gap-6 md:grid-cols-[1fr_1.1fr]">
      <section className="flex min-w-0 flex-col gap-3 text-[13px] leading-[1.5] text-muted">
        <h3 className="text-[14px] font-semibold text-text">Tranzacții fără bani reali</h3>
        <p>Ca la TradingView: un buget în USD, ordine market, limită și stop, cu SL / TP, executate la prețurile din graficele tale. Niciun ordin nu pleacă nicăieri.</p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 marker:text-faint">
          <li>
            <span className="text-text">Crypto:</span> spot și futures (levier până la 125×, Isolated sau Cross), ca un exchange.
          </li>
          <li>
            <span className="text-text">Acțiuni:</span> long și short, cu SL / TP, ca un broker; ordinele market doar cu bursa deschisă.
          </li>
          <li>Comisionul se scade la fiecare execuție: un procent din valoare sau o sumă fixă.</li>
          <li>Poți avea mai multe profiluri, fiecare cu banii lui; un bot simulează pe unul dintre ele.</li>
        </ul>
      </section>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-3.5" noValidate>
        <label htmlFor={nameId} className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted">Nume</span>
          <input id={nameId} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className="w-full" />
        </label>
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted">Piața</span>
          <Seg label="Piața" value={kind} options={(['crypto', 'stocks'] as const).map((k) => ({ value: k, label: PAPER_KIND_RO[k] }))} onChange={setKind} className="max-sm:row-fill" />
        </div>
        <label htmlFor={budgetId} className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted">Buget (USD)</span>
          <input id={budgetId} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className="num w-full" />
        </label>
        <CommissionFields type={type} value={value} onType={setType} onValue={setValue} />
        <ErrorBox text={error} />
        <div className="mt-1 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <button className="btn btn-primary" disabled={create.isPending}>
            {create.isPending && <Loader2 size={15} className="animate-spin" aria-hidden />} Creează profilul
          </button>
          <button type="button" className="btn" onClick={onBack} disabled={create.isPending}>
            Altă platformă
          </button>
        </div>
      </form>
    </div>
  );
}

/** „Setări profil”: the name and the commission (from the next execution). */
export function PaperSettingsDialog({ account, onClose }: { account: AccountView; onClose: () => void }) {
  const qc = useQueryClient();
  const nameId = useId();
  const p = account.paper;
  const [label, setLabel] = useState(account.label);
  const [type, setType] = useState<CommissionType>(p?.commissionType ?? 'percent');
  const [value, setValue] = useState(plain(p?.commissionValue ?? 0));
  const [local, setLocal] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<AccountView>(`/api/accounts/${account.id}/paper`, body),
    onSuccess: () => {
      afterPaperChange(qc, account.id);
      onClose();
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = readAmount(value);
    const problem = !label.trim() ? 'Numele lipsește.' : commissionError(type, c);
    setLocal(problem);
    if (!problem) save.mutate({ label: label.trim(), commissionType: type, commissionValue: c });
  };
  return (
    <Modal title={`Setări profil: ${account.label}`} onClose={onClose} locked={save.isPending}>
      <form onSubmit={submit} className="flex flex-col gap-3.5 text-[13px]" noValidate>
        <p className="text-muted">
          Piața: <span className="text-text">{PAPER_KIND_RO[p?.kind ?? 'crypto']}</span>. Bugetul: <span className="num text-text">{plain(p?.budget ?? 0)} USD</span> (se schimbă doar cu „Resetează”). Comisionul nou se aplică de la
          execuția următoare.
        </p>
        <label htmlFor={nameId} className="flex flex-col gap-1.5">
          <span className="text-muted">Nume</span>
          <input id={nameId} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className="w-full" />
        </label>
        <CommissionFields type={type} value={value} onType={setType} onValue={setValue} />
        <ErrorBox text={local ?? (save.isError ? errorMessage(save.error) : null)} />
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <Loader2 size={15} className="animate-spin" aria-hidden />} Salvează
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>
            Renunță
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** „Resetează”: a new budget; the positions, orders and history go, the bots on it end (asked again first). */
export function PaperResetDialog({ account, onClose }: { account: AccountView; onClose: () => void }) {
  const qc = useQueryClient();
  const budgetId = useId();
  const [budget, setBudget] = useState(plain(account.paper?.budget ?? PAPER_DEFAULT_BUDGET));
  const [local, setLocal] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: (b: number) => api.post<{ account: AccountView; endedBots: number }>(`/api/accounts/${account.id}/paper/reset`, { budget: b }),
    onSuccess: () => {
      afterPaperChange(qc, account.id);
      onClose();
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const b = readAmount(budget);
    const problem = budgetError(b);
    setLocal(problem);
    if (!problem) reset.mutate(b as number);
  };
  return (
    <Modal title={`Resetează: ${account.label}`} onClose={onClose} locked={reset.isPending}>
      <form onSubmit={submit} className="flex flex-col gap-3.5 text-[13px]" noValidate>
        <p>
          Pozițiile, ordinele și istoricul profilului se șterg, iar banii devin bugetul de mai jos. Boții care tranzacționează pe el se încheie. <span className="font-semibold">Nu se poate anula.</span>
        </p>
        <p className="text-muted">Comisionul rămâne: {account.paper ? commissionText(account.paper.commissionType, account.paper.commissionValue) : '—'}.</p>
        <label htmlFor={budgetId} className="flex flex-col gap-1.5">
          <span className="text-muted">Bugetul nou (USD)</span>
          <input id={budgetId} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className="num w-full" />
        </label>
        <ErrorBox text={local ?? (reset.isError ? errorMessage(reset.error) : null)} />
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button className="btn btn-danger" disabled={reset.isPending}>
            {reset.isPending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <RotateCcw size={15} aria-hidden />} Resetează
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={reset.isPending}>
            Renunță
          </button>
        </div>
      </form>
    </Modal>
  );
}
