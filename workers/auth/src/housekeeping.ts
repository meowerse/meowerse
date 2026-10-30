import type { Deps } from "./db";
import type { DbClient } from "./types";
import { TICKET_CLAIM_GRACE } from "./telegram";

/** One day margin kept past every expiry before a row is physically deleted. */
export const HOUSEKEEPING_MARGIN = 86400;
/** audit_log retention window. */
export const AUDIT_RETENTION_DAYS = 365;
/** Rows deleted per statement, and max statements per table per run (=> 10k rows/table/run). */
export const BATCH_SIZE = 500;
export const MAX_BATCHES = 20;

export interface HousekeepingOpts {
  batchSize?: number;
  maxBatches?: number;
}

export interface HousekeepingResult {
  /** Rows deleted per table (partial count if a table failed midway). */
  deleted: Record<string, number>;
  /** Tables whose deletion threw (the others still ran). */
  failed: string[];
}

interface Target {
  table: string;
  where: string;
  args: unknown[];
}

/** audit_log.ts is SQLite `datetime('now')` text: 'YYYY-MM-DD HH:MM:SS' in UTC. */
function sqliteTs(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Deletion targets. All integer expiry columns are epoch SECONDS.
 *
 * Deliberately NOT cleaned (rows are still read after expiry):
 *  - refresh_tokens: rotateRefresh checks `used_at` (reuse detection -> family revoke + audit)
 *    BEFORE the expiry check, so deleting expired rotated rows would silence reuse detection.
 *  - oauth_codes: exchangeCode checks `consumed_at` (replay -> revoke family) before expiry.
 *  - login_requests (no writer), rate_limits / management_tokens (no expiry column).
 */
function targets(now: number): Target[] {
  const cutoff = now - HOUSEKEEPING_MARGIN;
  return [
    { table: "audit_log", where: "ts < ?", args: [sqliteTs(now - AUDIT_RETENTION_DAYS * 86400)] },
    { table: "login_tickets", where: "expires_at < ?", args: [now - TICKET_CLAIM_GRACE - HOUSEKEEPING_MARGIN] },
    // lookupSession/whoami reject on absolute expiry; the row is dead one day past it.
    { table: "sessions", where: "absolute_expires_at < ?", args: [cutoff] },
    // introspect() returns inactive for expired or missing rows alike (ACCESS_TTL is 15 min).
    { table: "access_tokens", where: "expires_at < ?", args: [cutoff] },
  ];
}

async function deleteBounded(db: DbClient, t: Target, batchSize: number, maxBatches: number, tally: (n: number) => void): Promise<void> {
  for (let i = 0; i < maxBatches; i++) {
    const res = await db.execute({
      sql: `DELETE FROM ${t.table} WHERE rowid IN (SELECT rowid FROM ${t.table} WHERE ${t.where} LIMIT ?)`,
      args: [...t.args, batchSize],
    });
    const n = res.rowsAffected ?? 0;
    tally(n);
    if (n < batchSize) return;
  }
}

/** Bounded retention sweep. Never throws: a failing table is recorded and the rest still run. */
export async function runHousekeeping(db: DbClient, now: number, opts: HousekeepingOpts = {}): Promise<HousekeepingResult> {
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? MAX_BATCHES;
  const result: HousekeepingResult = { deleted: {}, failed: [] };
  for (const t of targets(now)) {
    result.deleted[t.table] = 0;
    try {
      await deleteBounded(db, t, batchSize, maxBatches, (n) => (result.deleted[t.table]! += n));
    } catch {
      result.failed.push(t.table);
    }
  }
  return result;
}

/** Cron entry: run the sweep and log one counts-only line. Never throws. */
export async function scheduledHousekeeping(deps: Deps, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
  try {
    const r = await runHousekeeping(deps.getDb(), now);
    const counts = Object.entries(r.deleted).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`housekeeping ${counts}${r.failed.length ? ` failed=${r.failed.join(",")}` : ""}`);
  } catch {
    console.error("housekeeping_failed");
  }
}
