// Sentiq.iOS TD-V4-S2 §2: the changes to the chart's indicators as the chart page makes them (saveStudies, addStudy,
// patchStudy, removeStudy, onPaneFactors, toggleFavorite): each gives the settings patch the app sends. The app passes
// the settings as it has them now (the latest: two quick changes both count) and, for a new one, its uid.
import { STUDY_MAX, type FavoriteId, type Study, type StudyId, type StudyMemoryEntry } from '../shared/studies.ts';
import { fromMemory, memoryOf, rememberStudy } from '../web/indicators/memory.ts';
import { STUDY_META } from '../web/indicators/catalog-meta.ts';

export type StudiesArgs = { studies: Study[]; studyMemory?: StudyMemoryEntry[]; studyFavorites?: FavoriteId[] } & (
  | { op: 'add'; id: StudyId; uid: string }
  | { op: 'remove'; uid: string }
  | { op: 'patch'; uid: string; patch: Partial<Pick<Study, 'visible'>> }
  | { op: 'heights'; heights: Record<string, number> }
  | { op: 'favorite'; id: FavoriteId }
  | { op: 'removeAll' }
  | { op: 'restore'; before: Study[] }
);

/** The settings patch, or null when nothing changes (an unknown indicator, the limit reached). */
export function studiesCall(a: StudiesArgs): Record<string, unknown> | null {
  const list = a.studies;
  const memory = a.studyMemory ?? [];
  switch (a.op) {
    case 'add':
      // Added with its last settings, if it has any.
      if (!STUDY_META.some((m) => m.id === a.id) || list.length >= STUDY_MAX) return null;
      return { studies: [...list, fromMemory(a.id, memory, a.uid)] };
    case 'remove': {
      // Removed as it was: the memory keeps its settings, the pane height dragged included.
      const gone = list.find((x) => x.uid === a.uid);
      return { studies: list.filter((x) => x.uid !== a.uid), ...(gone ? { studyMemory: rememberStudy(memory, memoryOf(gone)) } : {}) };
    }
    case 'patch':
      return { studies: list.map((x) => (x.uid === a.uid ? { ...x, ...a.patch } : x)) };
    case 'heights':
      return { studies: list.map((x) => (a.heights[x.uid] !== undefined ? { ...x, height: Math.round(Math.min(3, Math.max(0.05, a.heights[x.uid] as number)) * 1000) / 1000 } : x)) };
    case 'removeAll':
      // „Șterge N indicatori” (the page's removeIndicators): removed as one by one would, each one's settings remembered.
      return { studies: [], studyMemory: list.reduce((m, x) => rememberStudy(m, memoryOf(x)), [...memory]) };
    case 'restore': {
      // Its „Anulează”: back as they were, with any added since.
      const uids = new Set(a.before.map((x) => x.uid));
      return { studies: [...a.before, ...list.filter((x) => !uids.has(x.uid))].slice(0, STUDY_MAX) };
    }
    case 'favorite': {
      const now = a.studyFavorites ?? [];
      return { studyFavorites: now.includes(a.id) ? now.filter((x) => x !== a.id) : [...now, a.id] };
    }
  }
}
