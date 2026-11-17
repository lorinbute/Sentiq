// Who is using Sentiq right now (FD-KEYIDLE, TD-KEYIDLE): every visible tab in use beats each minute; the jobs that
// spend a user's own key (their AI's scores, their Twelve Data candles and plan) work only for users with a live beat.
// Kept in the database (`market_cache`), so a beat served by one instance counts on the one running the jobs.
import type { Db } from '../db/database.ts';
import { PRESENCE_TTL_MS } from '../../shared/presence.ts';

/** One tab of one session: the session's hash first, so a session that ends ends its tabs (the join finds nothing). */
const keyOf = (sessionHash: string, tab: string) => `presence:${sessionHash}:${tab}`;

/** The users of the live beats: a full session not expired, of an account not disabled. */
const LIVE = `FROM market_cache c
  JOIN sessions s ON c.[key] LIKE N'presence:' + s.id_hash + N':%'
  JOIN users u ON u.id = s.user_id
  WHERE c.[key] LIKE N'presence:%' AND c.fetched_at > @now AND s.kind = N'full' AND s.expires_at > @now AND u.disabled_at IS NULL`;

export class Presence {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /**
   * The tab is in use: it counts for `PRESENCE_TTL_MS`. True when the session's user had no live beat before this one
   * (they come back: the jobs can start at once).
   */
  async beat(sessionHash: string, tab: string): Promise<boolean> {
    const now = this.now();
    const before = await this.db.get<{ n: number }>(`SELECT count(*) AS n ${LIVE} AND s.user_id = (SELECT user_id FROM sessions WHERE id_hash = @h)`, { now, h: sessionHash });
    // Two beats of one tab at once: the second insert finds the first one's row (a duplicate key), which is as good.
    await this.db.run(
      `UPDATE market_cache SET value = N'{}', fetched_at = @until WHERE [key] = @k;
       IF @@ROWCOUNT = 0
       BEGIN
         BEGIN TRY INSERT INTO market_cache([key], value, fetched_at) VALUES (@k, N'{}', @until) END TRY
         BEGIN CATCH IF ERROR_NUMBER() NOT IN (2601, 2627) THROW; END CATCH
       END`,
      { k: keyOf(sessionHash, tab), until: now + PRESENCE_TTL_MS },
    );
    return (before?.n ?? 0) === 0;
  }

  /** The tab is hidden, closed or no longer used. */
  async leave(sessionHash: string, tab: string): Promise<void> {
    await this.db.run('DELETE FROM market_cache WHERE [key] = ?', [keyOf(sessionHash, tab)]);
  }

  /** The users using Sentiq now. */
  async activeUsers(): Promise<Set<number>> {
    return new Set((await this.db.all<{ user_id: number }>(`SELECT DISTINCT s.user_id ${LIVE}`, { now: this.now() })).map((r) => r.user_id));
  }

  /** Forgets the beats that no longer count (the maintenance job). */
  async purge(): Promise<number> {
    return (await this.db.run("DELETE FROM market_cache WHERE [key] LIKE N'presence:%' AND fetched_at <= ?", [this.now()])).changes;
  }
}
