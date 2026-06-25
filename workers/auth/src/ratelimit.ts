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
  const res = await db.execute({
    sql: "SELECT count, window_start FROM rate_limits WHERE bucket = ?",
    args: [bucket],
  });
  const row = res.rows[0];
  const inWindow = row != null && opts.now - Number(row.window_start) < opts.windowSec;
  const count = inWindow ? Number(row!.count) : 0;
  const windowStart = inWindow ? Number(row!.window_start) : opts.now;

  if (count >= opts.limit) return { allowed: false, remaining: 0 };

  await db.execute({
    sql: `INSERT INTO rate_limits (bucket, count, window_start, last_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(bucket) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, last_at = excluded.last_at`,
    args: [bucket, count + 1, windowStart, opts.now],
  });
  return { allowed: true, remaining: opts.limit - count - 1 };
}
