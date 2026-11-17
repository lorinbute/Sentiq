// FIX-DBSTUCK: a blocked process is written in the log with the jobs that were running; a short delay is not.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchEventLoop } from './loop-watch.ts';

describe('the event loop watch (FIX-DBSTUCK)', () => {
  afterEach(() => vi.useRealTimers());

  it('writes a block of 5 s or more, with the jobs of before and after it; nothing under it', () => {
    vi.useFakeTimers();
    let t = 0;
    const warns: string[] = [];
    let jobs = ['news.fetch'];
    const stop = watchEventLoop({ warn: (m: string) => void warns.push(m) }, () => jobs, { tickMs: 1000, minMs: 5000, now: () => t });
    // A normal second, then one of 4 s late: nothing.
    t += 1000;
    vi.advanceTimersByTime(1000);
    t += 5000;
    vi.advanceTimersByTime(1000);
    expect(warns).toEqual([]);
    // 12 s late, a job started meanwhile: both named.
    jobs = ['news.fetch', 'sentiment.score'];
    t += 13_000;
    vi.advanceTimersByTime(1000);
    expect(warns).toEqual(['event loop: blocked 12 s (jobs running: news.fetch, sentiment.score)']);
    jobs = [];
    t += 7000;
    vi.advanceTimersByTime(1000);
    expect(warns[1]).toBe('event loop: blocked 6 s (jobs running: news.fetch, sentiment.score)');
    t += 7000;
    vi.advanceTimersByTime(1000);
    expect(warns[2]).toBe('event loop: blocked 6 s (jobs running: none)');
    stop();
    t += 60_000;
    vi.advanceTimersByTime(5000);
    expect(warns).toHaveLength(3);
  });
});
