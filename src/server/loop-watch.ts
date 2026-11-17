// FIX-DBSTUCK: the Node process blocked (a long computation, a frozen moment) holds every timer and every unread result,
// and with them the database's write lock: when it could run nothing for a while, the log says how long and which jobs
// were running, so the next stall shows its cause.
import type { Logger } from './log.ts';

export interface LoopWatchOptions {
  /** How often it looks. */
  tickMs?: number;
  /** A delay from this long is written. */
  minMs?: number;
  now?: () => number;
}

/** Starts the watch; returns its stop. */
export function watchEventLoop(log: Pick<Logger, 'warn'>, running: () => string[], opts: LoopWatchOptions = {}): () => void {
  const tickMs = opts.tickMs ?? 1000;
  const minMs = opts.minMs ?? 5000;
  const now = opts.now ?? Date.now;
  let last = now();
  // The jobs of the moment before the block: those the block held (one ending during it is still named).
  let before = running();
  const timer = setInterval(() => {
    const t = now();
    const late = t - last - tickMs;
    if (late >= minMs) {
      const jobs = [...new Set([...before, ...running()])];
      log.warn(`event loop: blocked ${Math.round(late / 1000)} s (jobs running: ${jobs.length ? jobs.join(', ') : 'none'})`);
    }
    last = t;
    before = running();
  }, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
