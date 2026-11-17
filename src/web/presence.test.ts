// FD-KEYIDLE: a tab is in use while visible and used in the last 30 minutes; it beats then, and leaves once otherwise.
import { describe, expect, it } from 'vitest';
import { PRESENCE_IDLE_MS } from '../shared/presence.ts';
import { PresenceTracker } from './presence.ts';

function tracker(visible = true) {
  const s = { now: Date.parse('2026-11-01T10:00:00Z'), visible, sent: [] as boolean[], regained: 0, told: 0 };
  const t = new PresenceTracker({ now: () => s.now, visible: () => s.visible, send: (here) => s.sent.push(here), onRegain: () => s.regained++ });
  t.subscribe(() => s.told++);
  return { s, t };
}

describe('the tab in use (FD-KEYIDLE)', () => {
  it('beats when the app opens and every minute while used; leaves once after 30 minutes untouched; back at the first use', () => {
    const { s, t } = tracker();
    t.start();
    expect(s.sent).toEqual([true]);
    s.now += 60_000;
    t.tick();
    expect(s.sent).toEqual([true, true]);
    expect(t.current).toBe(true);
    s.now += PRESENCE_IDLE_MS;
    t.tick();
    expect(s.sent).toEqual([true, true, false]);
    expect(t.current).toBe(false);
    expect(s.told).toBe(1);
    // No more beats, and no second leave, while nobody uses it.
    s.now += 60_000;
    t.tick();
    expect(s.sent).toEqual([true, true, false]);
    // A click: a beat at once, and the charts are read again.
    t.used();
    expect(s.sent).toEqual([true, true, false, true]);
    expect(s.regained).toBe(1);
    expect(t.current).toBe(true);
    expect(s.told).toBe(2);
    // Used while already in use: no extra beat, no re-read.
    t.used();
    expect(s.sent).toHaveLength(4);
    expect(s.regained).toBe(1);
  });

  it('mouse moves count when the pointer goes somewhere, at most one every 5 seconds', () => {
    const { s, t } = tracker();
    t.start();
    s.now += PRESENCE_IDLE_MS;
    t.tick();
    // The first move only marks where the pointer is (a real move comes with many more).
    t.moved(700, 600);
    expect(t.current).toBe(false);
    t.moved(705, 602);
    expect(t.current).toBe(true);
    expect(s.sent.at(-1)).toBe(true);
    // A move 2 s later is not counted: still the last use at the first move.
    s.now += 2_000;
    t.moved(720, 610);
    s.now += PRESENCE_IDLE_MS - 2_000;
    expect(t.inUse()).toBe(false);
  });

  it('FIX-KEYIDLE2: moves of a pointer that stayed put (the browser after scrolling by itself) do not count', () => {
    const { s, t } = tracker();
    t.start();
    t.moved(700, 600);
    // Every minute for an hour, the list above grows, the page scrolls itself and WebKit repeats the move in place.
    for (let m = 0; m < 60; m++) {
      s.now += 60_000;
      t.moved(700, 600);
      t.tick();
    }
    expect(t.current).toBe(false);
    expect(s.sent.filter((h) => h === false)).toHaveLength(1);
    // The person comes back and moves the mouse: in use at once.
    t.moved(710, 600);
    expect(t.current).toBe(true);
    expect(s.regained).toBe(1);
  });

  it('hidden: leaves at once; shown again: beats (the browser re-reads the data itself)', () => {
    const { s, t } = tracker();
    t.start();
    s.visible = false;
    t.visibility();
    expect(s.sent).toEqual([true, false]);
    expect(t.current).toBe(false);
    // Hidden: the minute's check sends nothing.
    t.tick();
    expect(s.sent).toEqual([true, false]);
    s.now += 2 * PRESENCE_IDLE_MS;
    s.visible = true;
    t.visibility();
    expect(s.sent).toEqual([true, false, true]);
    expect(t.current).toBe(true);
    expect(s.regained).toBe(0);
  });

  it('the page closing leaves; signing out leaves; nothing to take back when it never beat', () => {
    const { s, t } = tracker(false);
    t.start();
    expect(s.sent).toEqual([]);
    t.hide();
    t.stop();
    expect(s.sent).toEqual([]);
    s.visible = true;
    t.visibility();
    t.hide();
    expect(s.sent).toEqual([true, false]);
    t.stop();
    expect(s.sent).toEqual([true, false]);
  });

  it('the network back: a beat if in use, nothing otherwise', () => {
    const { s, t } = tracker();
    t.start();
    t.online();
    expect(s.sent).toEqual([true, true]);
    s.now += PRESENCE_IDLE_MS;
    t.online();
    expect(s.sent).toEqual([true, true]);
  });
});
