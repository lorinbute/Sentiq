// Sentiq.iOS TD-V4-S2 §2: the „Indicatori” list, as the chart page sends it to the app (its `catalog` report).
import { PREMIUM_ITEMS } from '../web/chart/premium.ts';
import { STUDY_CATEGORIES, STUDY_META } from '../web/indicators/catalog-meta.ts';
import { STUDY_MAX } from '../shared/studies.ts';
import { INDEX_DELAY_NOTE, INDEX_TIMEFRAMES, INDICES } from '../shared/indices.ts';
import { TIMEFRAMES } from '../shared/time.ts';
import { EXCHANGE_NAME, MARKET_RO } from '../web/chart/signal-text.ts';

export function catalog() {
  return {
    premium: PREMIUM_ITEMS,
    studies: STUDY_META.map((m) => ({ id: m.id, name: m.name, shortName: m.shortName, overlay: m.overlay, description: m.description, category: m.category })),
    categories: STUDY_CATEGORIES.map((x) => ({ id: x.id, label: x.label })),
    max: STUDY_MAX,
    // The chart's words and lists the app's engine reads (the indices, their timeframes, the sources' names).
    indices: INDICES.map((i) => ({ id: i.id, symbol: i.symbol, name: i.name })),
    indexTfs: INDEX_TIMEFRAMES,
    indexDelayNote: INDEX_DELAY_NOTE,
    timeframes: TIMEFRAMES,
    exchangeNames: EXCHANGE_NAME,
    marketNames: MARKET_RO,
  };
}
