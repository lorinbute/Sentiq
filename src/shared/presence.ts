// FD-KEYIDLE: the users' own keys (AI, Twelve Data) work only while they use Sentiq: a visible tab of a signed-in
// account, used lately. Each such tab says so to the server; the jobs that spend a user's key look at it.

/** How often a tab in use says so. */
export const PRESENCE_BEAT_MS = 60_000;
/** How long one beat counts: a missed beat, or a tab gone without a word, ends at most this late. */
export const PRESENCE_TTL_MS = 150_000;
/** A visible tab nobody used (click, touch, key, wheel, scroll, mouse) for this long is no longer in use. */
export const PRESENCE_IDLE_MS = 30 * 60_000;
/** A tab's id in a beat (random, made by the page). */
export const PRESENCE_TAB_RE = /^[A-Za-z0-9_-]{8,64}$/;
