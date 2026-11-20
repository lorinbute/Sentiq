// Adding a symbol to a watch list (FD-WATCHLISTS §2, as the favourites were added in Settings before): a switch
// Crypto / Acțiuni / Indici / Forex / Mărfuri and a search whose results open under the field; for the indices, the
// seven of them at once; forex and commodities (FD-FXCOMMODITIES, the user's Twelve Data key: hidden without it) list
// the majors and the main commodities at once. Also the alias field of a row.
import { FX_READY } from '../fx.ts';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { StockSearchHit, SymbolInfo } from '../../shared/api-types.ts';
import { searchIndices } from '../../shared/indices.ts';
import { api, errorMessage, qs } from '../api.ts';
import { useSettings } from '../hooks.ts';
import { CoinLogo } from './icons.tsx';

type WatchKind = 'crypto' | 'stock' | 'index' | 'forex' | 'commodity';
const KIND_LABEL: Record<WatchKind, string> = { crypto: 'Crypto', stock: 'Acțiuni', index: 'Indici', forex: 'Forex', commodity: 'Mărfuri' };
type FxKind = 'forex' | 'commodity';
const isFx = (k: WatchKind): k is FxKind => k === 'forex' || k === 'commodity';
interface FxHit {
  symbol: string;
  name: string;
  group: string;
}
interface AddHit {
  key: string;
  label: string;
  hint: string;
  body: object;
  coin: string;
  stock: boolean;
  fx?: FxKind;
}

/**
 * `have`: the symbols of the open list (marked "în listă"); `onAdd` gets the body for the route. The results, the seven
 * indices too, open under the field over the page (FD-WATCHLISTS §2: nothing below moves), while the field has the focus.
 */
export function AddSymbol({ have, onAdd }: { have: ReadonlySet<string>; onAdd: (body: object) => void }) {
  const [kind, setKind] = useState<WatchKind>('crypto');
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const term = q.trim();
  const pairs = useQuery({ queryKey: ['symbols', term], queryFn: () => api.get<SymbolInfo[]>(`/api/market/symbols${qs({ q: term })}`), enabled: kind === 'crypto' && term.length >= 1, staleTime: 5 * 60_000 });
  const stocks = useQuery({
    queryKey: ['stocks', 'search', term],
    queryFn: () => api.get<StockSearchHit[]>(`/api/stocks/search${qs({ q: term })}`),
    enabled: kind === 'stock' && term.length >= 1,
    staleTime: 10 * 60_000,
    retry: false,
  });
  // FD-FXCOMMODITIES: only with the user's Twelve Data key, told by the settings read at the start (the switch has all
  // its kinds from the first frame: nothing moves when they come).
  const settings = useSettings();
  const fxAvailable = FX_READY && settings.data?.twelveDataKeySet === true;
  const kinds: WatchKind[] = fxAvailable ? ['crypto', 'stock', 'index', 'forex', 'commodity'] : ['crypto', 'stock', 'index'];
  const fxSearch = useQuery({
    queryKey: ['fx', 'search', kind, term],
    queryFn: () => api.get<FxHit[]>(`/api/fx/search${qs({ kind, q: term })}`),
    enabled: isFx(kind) && fxAvailable,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const hits: AddHit[] | null =
    isFx(kind)
      ? (fxSearch.data?.map((r) => ({ key: r.symbol, label: r.symbol, hint: r.name, body: { kind, coin: r.symbol, name: r.name }, coin: r.symbol, stock: false, fx: kind })) ?? null)
      : kind === 'index'
      ? searchIndices(term).map((i) => ({ key: i.id, label: i.symbol, hint: i.name, body: { kind: 'index', coin: i.id }, coin: i.id, stock: false }))
      : kind === 'crypto'
        ? (pairs.data?.map((r) => ({ key: r.symbol, label: r.symbol, hint: '', body: { kind: 'crypto', coin: r.base, quote: r.quote }, coin: r.base, stock: false })) ?? null)
        : (stocks.data?.map((r) => ({
            key: r.symbol,
            label: r.symbol,
            hint: [r.name, r.exchange].filter(Boolean).join(' · '),
            body: { kind: 'stock', coin: r.symbol, name: r.name, exchange: r.exchange || undefined },
            coin: r.symbol,
            stock: true,
          })) ?? null);
  const searching = kind === 'crypto' ? pairs : kind === 'stock' ? stocks : isFx(kind) ? fxSearch : null;
  // The seven indices, the majors and the commodities show at once (an empty field included); the pairs and the stocks
  // once something is typed.
  const listed = kind === 'index' || isFx(kind);
  const open = focused && ((listed && (hits !== null || Boolean(searching?.isError))) || (term !== '' && (hits !== null || Boolean(searching?.isError))));
  const empty =
    kind === 'crypto'
      ? 'Nicio pereche cu acest simbol'
      : kind === 'stock'
        ? 'Nicio acțiune din SUA cu acest nume'
        : kind === 'forex'
          ? 'Nicio pereche forex cu acest nume'
          : kind === 'commodity'
            ? 'Nicio marfă cu acest nume'
            : 'Niciun indice cu acest nume. Sunt disponibili doar indicii americani din listă.';
  const placeholder = { crypto: 'Adaugă o monedă, ex. SOL', stock: 'Adaugă o acțiune, ex. AAPL sau Apple', index: 'Alege un indice, ex. SPX sau Dow', forex: 'Alege o pereche, ex. EUR/USD', commodity: 'Alege o marfă, ex. aur sau petrol' }[kind];
  const ariaLabel = { crypto: 'Adaugă o monedă', stock: 'Adaugă o acțiune', index: 'Adaugă un indice', forex: 'Adaugă o pereche forex', commodity: 'Adaugă o marfă' }[kind];
  return (
    // One height for the switch and the search field, on every screen (FD-UIPOLISH): the row stretches both.
    <div className="flex flex-wrap items-stretch gap-2.5">
      {/* FD-MOBILESYM §2: on a phone the switch and the field each take the whole row. */}
      <div className="seg max-sm:row-fill" role="group" aria-label="Tipul simbolului">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => {
              setKind(k);
              setQ('');
              // The indices, the majors and the commodities open their list at once: the field takes the focus.
              if (k === 'index' || isFx(k)) input.current?.focus();
            }}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="relative w-80 max-w-full max-sm:w-full">
        <input
          ref={input}
          aria-label={ariaLabel}
          aria-expanded={open}
          placeholder={placeholder}
          value={q}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && open) {
              e.preventDefault();
              if (q) setQ('');
              else input.current?.blur();
            }
          }}
          onChange={(e) => setQ(kind === 'crypto' ? e.target.value.toUpperCase() : e.target.value)}
          className="h-full w-full"
        />
        {open && (
          // Over the page, under the field: a click in it keeps the field's focus (no blur before the click).
          <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-auto overscroll-contain rounded-md border border-line bg-panel-2 py-1 shadow-pop" onMouseDown={(e) => e.preventDefault()}>
            {searching?.isError && <li className="px-3 py-1.5 text-[13px] text-bear">{errorMessage(searching.error)}</li>}
            {hits?.length === 0 && <li className="px-3 py-1.5 text-[13px] text-faint">{empty}</li>}
            {hits?.map((h) => {
              const added = have.has(h.coin);
              return (
                <li key={h.key}>
                  <button
                    type="button"
                    disabled={added}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-hover disabled:opacity-60 disabled:hover:bg-transparent"
                    onClick={() => {
                      onAdd(h.body);
                      setQ('');
                    }}
                  >
                    {(h.stock || kind === 'index' || h.fx) && <CoinLogo coin={h.coin} size={16} badge={h.stock} square={h.stock} fx={h.fx} />}
                    <span className="font-medium">{h.label}</span>
                    {h.hint && <span className="min-w-0 truncate text-faint">{h.hint}</span>}
                    {added ? (
                      <span className="ml-auto shrink-0 text-[12px] text-faint">în listă</span>
                    ) : listed ? (
                      <Plus size={14} aria-hidden className="ml-auto shrink-0 text-faint" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A symbol's aliases in the news, comma separated, saved on leaving the field or Enter (as in Settings before). */
export function AliasInput({ initial, onSave, label }: { initial: string[]; onSave: (list: string[]) => void; label: string }) {
  const [v, setV] = useState(initial.join(', '));
  // Only reset the field when the saved aliases really change (not on every refetch, mid-typing).
  const saved = initial.join(', ');
  useEffect(() => setV(saved), [saved]);
  const commit = () => {
    const list = v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length >= 3);
    if (list.join(',') !== initial.join(',')) onSave(list);
  };
  return <input aria-label={`Aliasuri pentru ${label}`} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} className="block w-full min-w-[180px]" />;
}
