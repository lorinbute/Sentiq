// FD-KEYIDLE, TD-KEYIDLE: this tab tells the server while it is in use (visible, used in the last 30 minutes), so that
// the user's own keys (AI, Twelve Data) work only then; while it is not, the stock charts stop refreshing too.
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PRESENCE_BEAT_MS, PRESENCE_IDLE_MS } from '../shared/presence.ts';
import { api } from './api.ts';

const PRESENCE_URL = '/api/presence';
/** Mouse moves count at most this often (they come by the hundred). */
const MOVE_EVERY_MS = 5_000;

export interface PresenceDeps {
  now: () => number;
  visible: () => boolean;
  /** Tells the server the tab is in use (`true`) or no longer (`false`). */
  send: (here: boolean) => void;
  /** The visible tab is used again after a pause (coming back to a hidden tab is the browser's to tell). */
  onRegain: () => void;
}

/** When the tab is in use, and what the server is told; the browser's events are the hook's to pass on. */
export class PresenceTracker {
  private readonly d: PresenceDeps;
  private lastUse: number;
  private lastMove = 0;
  /** Where the pointer was at its last move: a move that does not change it is the browser's, not a person's. */
  private lastAt: { x: number; y: number } | null = null;
  /** A beat sent and not taken back. */
  private beating = false;
  private told: boolean;
  private readonly subs = new Set<() => void>();

  constructor(deps: PresenceDeps) {
    this.d = deps;
    this.lastUse = deps.now();
    this.told = this.inUse();
  }

  /** Visible and used (click, touch, key, wheel, the mouse moved) in the last `PRESENCE_IDLE_MS`. */
  inUse(): boolean {
    return this.d.visible() && this.d.now() - this.lastUse < PRESENCE_IDLE_MS;
  }

  /** What the subscribers were last told. */
  get current(): boolean {
    return this.told;
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** The signed-in app opened: the tab counts as just used. */
  start(): void {
    this.lastUse = this.d.now();
    if (this.inUse()) this.beat();
    this.tell();
  }

  /** The signed-in app closed (signed out): the server is told the tab left. */
  stop(): void {
    this.leave();
  }

  /**
   * The pointer moved to (`x`, `y`) on the screen. FIX-KEYIDLE2: a browser also sends moves of a pointer that stayed put
   * (WebKit, after scrolling the page by itself when a list above grows): only a move to another place counts, and the
   * first one only marks where the pointer is.
   */
  moved(x: number, y: number): void {
    const before = this.lastAt;
    this.lastAt = { x, y };
    if (!before || (before.x === x && before.y === y)) return;
    const now = this.d.now();
    if (now - this.lastMove < MOVE_EVERY_MS) return;
    this.lastMove = now;
    this.used();
  }

  /** Somebody used the tab: a click, a touch, a key, the wheel (or, through `moved`, the mouse). */
  used(): void {
    const now = this.d.now();
    const was = this.inUse();
    this.lastUse = now;
    if (!was && this.d.visible()) {
      this.beat();
      this.d.onRegain();
    }
    this.tell();
  }

  /** The tab was shown or hidden (also when restored from the browser's back / forward cache). */
  visibility(): void {
    if (this.d.visible()) {
      this.lastUse = this.d.now();
      this.beat();
    } else this.leave();
    this.tell();
  }

  /** The page goes away (closed, reloaded, left for another site). */
  hide(): void {
    this.leave();
  }

  /** The network is back. */
  online(): void {
    if (this.inUse()) this.beat();
  }

  /** Every `PRESENCE_BEAT_MS`: beat while in use, leave once when no longer. */
  tick(): void {
    if (this.inUse()) this.beat();
    else this.leave();
    this.tell();
  }

  private beat(): void {
    this.beating = true;
    this.d.send(true);
  }

  private leave(): void {
    if (!this.beating) return;
    this.beating = false;
    this.d.send(false);
  }

  private tell(): void {
    const v = this.inUse();
    if (v === this.told) return;
    this.told = v;
    for (const cb of this.subs) cb();
  }
}

const randomTab = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
};

/** This page's id: a new one at each load (a tab duplicated by the browser does not share it). */
const tab = randomTab();
let beatInFlight = false;
let regain: () => void = () => {};

const tracker = new PresenceTracker({
  now: () => Date.now(),
  visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  send: (here) => {
    if (here) {
      if (beatInFlight) return;
      beatInFlight = true;
      // Through `api`: a session that ended elsewhere takes the app back to the sign-in screen, as any request does.
      void api
        .post(PRESENCE_URL, { tab, here: true })
        .catch(() => undefined)
        .finally(() => (beatInFlight = false));
      return;
    }
    // `keepalive`: it gets out even while the page closes. Not through `api`: after a sign-out it may be refused, and
    // that must not change anything.
    try {
      void fetch(PRESENCE_URL, { method: 'POST', keepalive: true, headers: { 'X-Sentiq': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ tab, here: false }) }).catch(
        () => undefined,
      );
    } catch {
      // the browser refused to send it: the beat ends by itself (PRESENCE_TTL_MS)
    }
  },
  onRegain: () => regain(),
});

/** Whether this tab is in use now (visible and used in the last 30 minutes). */
export function useInUse(): boolean {
  return useSyncExternalStore(
    (cb) => tracker.subscribe(cb),
    () => tracker.current,
    () => true,
  );
}

/**
 * What a person does (FIX-KEYIDLE2). Not `scroll`: the browser scrolls a page by itself when a list above the screen
 * grows (scroll anchoring), and a person's scrolling comes with the wheel, a key or a touch anyway.
 */
const USE_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** Runs the tab's presence while the signed-in app is open (`SignedInApp`). */
export function usePresence(): void {
  const qc = useQueryClient();
  useEffect(() => {
    // Back after a pause: the charts on screen are read again at once, not at their next turn.
    regain = () => void qc.invalidateQueries({ queryKey: ['candles'], refetchType: 'active' });
    // Only the browser's own events: none a script dispatched.
    const onUse = (e: Event) => {
      if (e.isTrusted) tracker.used();
    };
    const onMove = (e: PointerEvent) => {
      if (e.isTrusted) tracker.moved(e.screenX, e.screenY);
    };
    const onVisibility = () => tracker.visibility();
    const onHide = () => tracker.hide();
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) tracker.visibility();
    };
    const onOnline = () => tracker.online();
    const opts = { capture: true, passive: true } as const;
    for (const ev of USE_EVENTS) window.addEventListener(ev, onUse, opts);
    window.addEventListener('pointermove', onMove, opts);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    window.addEventListener('online', onOnline);
    tracker.start();
    const timer = setInterval(() => tracker.tick(), PRESENCE_BEAT_MS);
    return () => {
      clearInterval(timer);
      for (const ev of USE_EVENTS) window.removeEventListener(ev, onUse, opts);
      window.removeEventListener('pointermove', onMove, opts);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      window.removeEventListener('online', onOnline);
      regain = () => {};
      tracker.stop();
    };
  }, [qc]);
}
