// Slingshot and LMA on the chart (FD-PREMIUMHIDE): off it, drawn, or kept on it but hidden with the legend's eye.
import type { Settings } from '../../shared/settings.ts';
import { LMA_TITLE } from '../../shared/indicator/lma-params.ts';
import { SLINGSHOT_TITLE } from '../../shared/indicator/params.ts';
import type { PremiumItem } from '../components/IndicatorPicker.tsx';

export type PremiumState = 'off' | 'shown' | 'hidden';

export function premiumState(prefs: Pick<Settings['charts'], 'showSlingshot' | 'slingshotHidden' | 'showLma' | 'lmaHidden'>): { slingshot: PremiumState; lma: PremiumState } {
  const of = (on: boolean, hidden: boolean): PremiumState => (!on ? 'off' : hidden ? 'hidden' : 'shown');
  return { slingshot: of(prefs.showSlingshot, prefs.slingshotHidden), lma: of(prefs.showLma, prefs.lmaHidden) };
}

/** What the row of the "Indicatori" list says on its right. */
export const premiumNote = (state: PremiumState): string | null => (state === 'off' ? null : state === 'hidden' ? 'Pe grafic, ascuns' : 'Pe grafic');

/** The premium indicators of the „Indicatori” list (shared with the iOS app's chart engine, Sentiq.iOS TD-V4-S2). */
export const PREMIUM_ITEMS: PremiumItem[] = [
  {
    key: 'slingshot',
    name: SLINGSHOT_TITLE,
    shortName: 'Slingshot',
    overlay: true,
    description: 'Norul EMA 38 / 62, semnalele LONG și TAKE PROFIT, nivelurile TP / SL din ATR și Market Structure.',
  },
  { key: 'lma', name: LMA_TITLE, shortName: 'LMA', overlay: false, description: 'Linia de semnal, pragurile long / short și starea BULLISH / BEARISH / NEUTRAL, în panoul de jos.' },
];
