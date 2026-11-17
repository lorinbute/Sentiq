// Sentiq.iOS FD-V3-S19 / TD-V4-S2: the description of a form the iOS app draws natively, and its setters. Pure (no
// React): the page's forms and the app's chart engine (src/ios-core) describe themselves with it.
import type { HostValue } from './embed.ts';

export type HostLineStyle = 'solid' | 'dashed' | 'dotted';

/** A colour box: its key (none: shown only, e.g. a colour made from others), its colour or the colours it is made of. */
export interface HostColor {
  key?: string;
  label: string;
  /** #RRGGBB(AA) or rgba(); empty with `gradient`. */
  value: string;
  gradient?: string[];
}

export type HostField =
  | { k: 'bool'; key: string; label: string; value: boolean; off?: boolean; why?: string; tip?: string }
  | { k: 'number'; key: string; label: string; value: number | null; int: boolean; min?: number; max?: number; step?: number; off?: boolean; forced?: boolean; tip?: string }
  | { k: 'select'; key: string; label: string; value: string; options: { value: string; label: string }[]; off?: boolean; tip?: string }
  | { k: 'text'; key: string; label: string; value: string; area?: boolean; off?: boolean; tip?: string }
  | { k: 'time'; key: string; label: string; value: number | null; off?: boolean; tip?: string }
  | { k: 'color'; key: string; label: string; value: string; tip?: string }
  | {
      k: 'look';
      label: string;
      tip?: string;
      toggle?: { key: string; value: boolean };
      colors: HostColor[];
      note?: string;
      width?: { key: string; value: number };
      style?: { key: string; value: HostLineStyle };
      size?: { key: string; value: string; options: string[] };
      /** A level: a field (a key) or only shown. */
      level?: { key?: string; value: number | null };
    };

export interface HostGroup {
  title: string | null;
  fields: HostField[];
}

export interface HostForm {
  /** What the drawer shows (`study:<uid>`, `slingshot`, `lma`). */
  target: string;
  title: string;
  premium: boolean;
  tabs?: { id: 'inputs' | 'style'; label: string }[];
  tab?: 'inputs' | 'style';
  intro?: string | null;
  /** A tab with nothing in it, or a form that cannot show (the indicator removed, still loading). */
  empty?: string | null;
  groups: HostGroup[];
  invalid?: string | null;
  error?: string | null;
  saving?: boolean;
  saved?: boolean;
}

/** A form's fields by key: what the app's `formSet` changes. */
export class HostSetters {
  private readonly map = new Map<string, (v: HostValue) => void>();

  /** Registers `fn` under `key` and gives the key back (for the field's description). */
  add(key: string, fn: (v: HostValue) => void): string {
    this.map.set(key, fn);
    return key;
  }

  set(key: string, v: HostValue): void {
    this.map.get(key)?.(v);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

/** A number field's value from the app: an empty field (null) is NaN, as the drawer's own field gives it. */
export const hostNumber = (v: HostValue): number => (typeof v === 'number' ? v : NaN);
export const hostString = (v: HostValue): string => (typeof v === 'string' ? v : v === null ? '' : String(v));
export const hostStyle = (v: HostValue): HostLineStyle => (v === 'dashed' || v === 'dotted' ? v : 'solid');
