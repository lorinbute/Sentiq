// What every chart opens with, kept in this browser: the zoom (FD-CHARTOPEN), the room after the last candle
// (FD-CHARTROOM) and where the candles sit on the price pane (FD-CHARTOPEN), one of each for all of them. Storage may be
// unavailable (private window, blocked site data): every access is guarded and the chart then opens on the default view.

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// FD-CHARTOPEN: the zoom, px per bar (lightweight-charts `barSpacing`).
const ZOOM_KEY = 'sentiq.chartZoom';
/** The views kept per exchange|pair|timeframe before FD-CHARTOPEN (and before the rename, FD-SENTIQ §1): read, never written. */
const VIEWS_KEYS = ['sentiq.chartViews', 'kryptoniq.chartViews'];

const validZoom = (px: unknown): px is number => typeof px === 'number' && Number.isFinite(px) && px > 0.1 && px <= 500;

/** The zoom of the view used last before FD-CHARTOPEN, if any. */
function legacyZoom(storage: Storage): number | null {
  for (const key of VIEWS_KEYS) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    let best: { barSpacing: number; at: number } | null = null;
    for (const v of Object.values(parsed) as { barSpacing?: unknown; at?: unknown }[]) {
      if (typeof v !== 'object' || v === null || !validZoom(v.barSpacing) || typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
      if (!best || v.at > best.at) best = { barSpacing: v.barSpacing, at: v.at };
    }
    return best?.barSpacing ?? null;
  }
  return null;
}

export function loadZoom(storage: Storage | null = defaultStorage()): number | null {
  try {
    if (!storage) return null;
    const raw = storage.getItem(ZOOM_KEY);
    if (raw) {
      const px = Number(raw);
      return validZoom(px) ? px : null;
    }
    return legacyZoom(storage);
  } catch {
    return null;
  }
}

export function saveZoom(px: number, storage: Storage | null = defaultStorage()): void {
  if (!validZoom(px)) return;
  try {
    storage?.setItem(ZOOM_KEY, String(px));
  } catch {
    // Full or blocked storage: the zoom is simply not remembered.
  }
}

/**
 * The zoom a view keeps, or null when it is not one to keep: at the library's maximum (a bar half the plot wide, with no
 * `maxBarSpacing`), where a narrower window cut it.
 */
export function zoomOf(barSpacing: number, width: number): number | null {
  if (!Number.isFinite(barSpacing) || !Number.isFinite(width) || width <= 0 || barSpacing >= width / 2) return null;
  return validZoom(barSpacing) ? barSpacing : null;
}

// FD-CHARTROOM: the room after the last candle, in px, one for every chart (the TP / SL table and the trades' labels are
// as wide on any of them).
const ROOM_KEY = 'sentiq.chartRoom';
export const MAX_ROOM = 20_000;

const validRoom = (px: unknown): px is number => typeof px === 'number' && Number.isFinite(px) && px >= 0 && px <= MAX_ROOM;

export function loadRoom(storage: Storage | null = defaultStorage()): number | null {
  try {
    const raw = storage?.getItem(ROOM_KEY);
    const px = raw ? Number(raw) : NaN;
    return validRoom(px) ? px : null;
  } catch {
    return null;
  }
}

export function saveRoom(px: number, storage: Storage | null = defaultStorage()): void {
  if (!validRoom(px)) return;
  try {
    storage?.setItem(ROOM_KEY, String(px));
  } catch {
    // Full or blocked storage: the room is simply not remembered.
  }
}

/**
 * The room a view leaves after the last candle, or null when it is not one to keep: the last candle off screen (looking
 * back in history, or left of the view behind an indicator's points drawn ahead), or the view at the library's limit
 * (2 bars left on screen), where a narrower window cut it.
 * `fromCandle`: bars from the last candle to the right edge; `offset`: the library's own (`scrollPosition()`).
 */
export function roomOf(v: { fromCandle: number; barSpacing: number; offset: number; width: number }): number | null {
  const { fromCandle, barSpacing, offset, width } = v;
  if (![fromCandle, barSpacing, offset, width].every(Number.isFinite) || barSpacing <= 0 || width <= 0) return null;
  const across = width / barSpacing;
  if (fromCandle < 0 || fromCandle > across - 1 || offset >= across - 2) return null;
  const px = fromCandle * barSpacing;
  return validRoom(px) ? px : null;
}

/** A view's room (negative: the last candle off screen) as last remembered for a key. */
export interface RoomMark {
  key: string;
  px: number;
}

/**
 * Whether the view moved since the room was last remembered: what only the width changed (a window narrowed, the view cut
 * at the library's limit, then widened) or what keeps the last candle where it was (new candles, an indicator drawing
 * ahead) is not a room chosen.
 */
export const roomMoved = (was: RoomMark | null, now: RoomMark) => !was || was.key !== now.key || Math.abs(was.px - now.px) > 0.5;

/** The bar spacing of the default view (the last 180 candles, 20 bars after them) on a plot this wide. */
export const defaultSpacing = (width: number, n: number) => width / (n + 20 - Math.max(0, n - 180) + 1);

// FD-CHARTOPEN: where the visible candles sit on the price pane once the user moved the prices ("A" off): the room above
// the highest and below the lowest, as parts of the pane's height (the library's `scaleMargins`). None: "A" on.
const BAND_KEY = 'sentiq.chartBand';
/** The band keeps at least 5% of the pane's height. */
export const MAX_BAND_MARGINS = 0.95;

export interface Band {
  top: number;
  bottom: number;
}

const validBand = (b: unknown): b is Band => {
  const o = b as Band | null;
  return (
    typeof o === 'object' && o !== null &&
    Number.isFinite(o.top) && Number.isFinite(o.bottom) && o.top >= 0 && o.bottom >= 0 && o.top + o.bottom <= MAX_BAND_MARGINS + 1e-9
  ); // prettier-ignore
};

export function loadBand(storage: Storage | null = defaultStorage()): Band | null {
  try {
    const raw = storage?.getItem(BAND_KEY);
    const b: unknown = raw ? JSON.parse(raw) : null;
    return validBand(b) ? { top: b.top, bottom: b.bottom } : null;
  } catch {
    return null;
  }
}

/** Null forgets the band: every chart opens with the scale fitting itself. */
export function saveBand(band: Band | null, storage: Storage | null = defaultStorage()): void {
  if (band !== null && !validBand(band)) return;
  try {
    if (band === null) storage?.removeItem(BAND_KEY);
    else storage?.setItem(BAND_KEY, JSON.stringify({ top: band.top, bottom: band.bottom }));
  } catch {
    // Full or blocked storage: the band is simply not remembered.
  }
}

/**
 * The band of the candles on screen, from where the highest high and the lowest low are drawn (y from the pane's top, px):
 * the inverse of the library's map, where the range's top is drawn at `top × height` and its bottom at
 * `height − 1 − bottom × height`. Candles off the pane give 0 there; squashed ones keep 5% of the height; null when they
 * all sit at one price or a value is not valid.
 */
export function bandOf(v: { high: number; low: number; height: number }): Band | null {
  const { high, low, height } = v;
  if (![high, low, height].every(Number.isFinite) || height <= 0 || low - high < 1) return null;
  let top = Math.max(0, high / height);
  let bottom = Math.max(0, (height - 1 - low) / height);
  const sum = top + bottom;
  if (sum > MAX_BAND_MARGINS) {
    top *= MAX_BAND_MARGINS / sum;
    bottom *= MAX_BAND_MARGINS / sum;
  }
  return { top, bottom };
}

/**
 * FD-CHARTKEEP: the bars to scroll so that the last candle, drawn at `xNow` after new data, is back at `xBefore` (its
 * place before them); null when it did not move (half a pixel or less) or a value cannot be used.
 */
export function keepShift(xBefore: number | null, xNow: number | null, barSpacing: number): number | null {
  if (xBefore === null || xNow === null || !Number.isFinite(xBefore) || !Number.isFinite(xNow) || !(barSpacing > 0)) return null;
  const dx = xNow - xBefore;
  return Math.abs(dx) > 0.5 ? dx / barSpacing : null;
}
