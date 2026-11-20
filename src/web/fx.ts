// FD-FXCOMMODITIES on the web: forex pairs' and commodities' quotes (Twelve Data, the user's key, a credit each: kept a
// minute on the server) and their 48 h lines (hourly candles, read every 10 minutes: few credits).
import { useQuery } from '@tanstack/react-query';
import type { FxQuote } from '../shared/api-types.ts';
import { api, qs } from './api.ts';

export type FxQuoteRow = FxQuote & { error?: string };

/** FD-FXCOMMODITIES: the categories shown (with the user's Twelve Data key; hidden without it, by `/api/fx/info`). */
export const FX_READY = true;
export const isFxItem = (w: { kind?: string }): w is { kind: 'forex' | 'commodity' } => w.kind === 'forex' || w.kind === 'commodity';

/** Digits for a pair's or a commodity's price: a rate under 10 (EUR/USD 1,0812) four, else two (USD/JPY, gold). */
export const fxPrecision = (last: number | null | undefined): number => (last != null && Math.abs(last) < 10 ? 4 : 2);

/** Price, day change and the week's state of the favourite pairs and commodities. */
export function useFxQuotes(symbols: string[]) {
  return useQuery({
    queryKey: ['fx', 'quotes', symbols.join(',')],
    queryFn: () => api.get<FxQuoteRow[]>(`/api/fx/quotes${qs({ symbols: symbols.join(',') })}`),
    enabled: symbols.length > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
    select: (rows: FxQuoteRow[]) => new Map(rows.map((r) => [r.symbol, r])),
  });
}

