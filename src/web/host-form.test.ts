// Sentiq.iOS FD-V3-S19: a form's fields by key, and the values the app sends turned into the form's own.
import { describe, expect, it } from 'vitest';
import { HostSetters, hostNumber, hostString, hostStyle } from './host-form.ts';

describe('the native sheet of an indicator: its setters', () => {
  it('a key runs its own setter; an unknown key changes nothing', () => {
    const s = new HostSetters();
    const got: unknown[] = [];
    expect(s.add('in:length', (v) => got.push(['length', v]))).toBe('in:length');
    s.add('plot:p0:v', (v) => got.push(['visible', v]));
    s.set('in:length', 21);
    s.set('plot:p0:v', false);
    s.set('in:other', 3);
    expect(got).toEqual([
      ['length', 21],
      ['visible', false],
    ]);
    expect(s.has('in:length')).toBe(true);
    expect(s.has('in:other')).toBe(false);
  });

  it('an emptied number is NaN (as the drawer gives it); text and line styles read safely', () => {
    expect(hostNumber(14)).toBe(14);
    expect(hostNumber(null)).toBeNaN();
    expect(hostNumber('14')).toBeNaN();
    expect(hostString('close')).toBe('close');
    expect(hostString(null)).toBe('');
    expect(hostString(3)).toBe('3');
    expect(hostStyle('dashed')).toBe('dashed');
    expect(hostStyle('dotted')).toBe('dotted');
    expect(hostStyle('wavy')).toBe('solid');
    expect(hostStyle(null)).toBe('solid');
  });
});
