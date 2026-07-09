import type { DbClient } from "./types";

/**
 * Fixed-window per-bucket limiter (spec §7, §10/#10). Buckets key on hashed
 * identifiers (e.g. sha256(username) or an IP hash). This is the SECOND line:
 * the edge WAF rate-limit drops floods before they ever reach a Turso write —
 * this counter exists for per-account / per-client fairness once past the edge.
 *
 * // ponytail: read-then-write isn't atomic across colos; fine at free-tier
 * // scale behind the edge limiter. Upgrade to a Durable Object if strict global
 * // counting is ever needed.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export async function checkRateLimit(
  db: DbClient,
  bucket: string,
  opts: { limit: number; windowSec: number; now: number },
): Promise<RateLimitResult> {
  // ONE atomic upsert (was SELECT-then-INSERT, two round-trips). The window logic
  // moves into the statement: still inside the window → increment; window elapsed
  // → reset to 1 and re-stamp window_start. `RETURNING count` gives the post-write
  // counter so `allowed = count <= limit` (equivalent to the old "prior < limit").
  const { now, windowSec } = opts;
  const res = await db.execute({
    sql: `INSERT INTO rate_limits (bucket, count, window_start, last_at) VALUES (?, 1, ?, ?)
          ON CONFLICT(bucket) DO UPDATE SET
            count = CASE WHEN ? - window_start < ? THEN count + 1 ELSE 1 END,
            window_start = CASE WHEN ? - window_start < ? THEN window_start ELSE ? END,
            last_at = ?
          RETURNING count`,
    args: [bucket, now, now, now, windowSec, now, windowSec, now, now],
  });
  const count = Number(res.rows[0]?.count ?? 1);
  const allowed = count <= opts.limit;
  return { allowed, remaining: allowed ? opts.limit - count : 0 };
}
