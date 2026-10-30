import type { Deps } from "./db";
import type { DbClient } from "./types";
import { TICKET_CLAIM_GRACE } from "./telegram";
import { REFRESH_ABS_TTL } from "./refresh";
import { ACCESS_TTL } from "./token";

/** One day margin kept past every expiry before a row is physically deleted. */
export const HOUSEKEEPING_MARGIN = 86400;
/** audit_log retention window. */
export const AUDIT_RETENTION_DAYS = 365;
/** Evidence kept past a token family's absolute expiry (refresh reuse / code replay detection). */
export const RETENTION_GRACE = 30 * 86400;
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
  /** Optional tables not yet created in this database (not an error). */
  skipped: string[];
}

/** Tables added after the manual prod migration baseline; pruning them is skipped silently while absent. */
const OPTIONAL_TABLES = new Set(["account_delete_confirmations"]);

interface Target {
  /** Result/failure key (a table may have more than one target). */
  key: string;
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
 * Token-evidence retention (owner-approved): rows are never deleted by an individual idle expiry,
 * because reuse/replay detection (rotateRefresh `used_at`, exchangeCode `consumed_at`) must keep
 * working while the token family is still valid.
 *  - refresh_tokens: only when the WHOLE family is past absolute expiry + RETENTION_GRACE.
 *  - oauth_codes consumed: the family it created expires <= code expiry + REFRESH_ABS_TTL and its
 *    access tokens die <= ACCESS_TTL later; keep until that + RETENTION_GRACE.
 *  - oauth_codes never redeemed: no family exists; expiry + RETENTION_GRACE.
 * Not cleaned: login_requests (no writer), rate_limits / management_tokens (no expiry column).
 * Account deletion removes these rows by account_id immediately (accounts.ts), independent of this.
 */
function targets(now: number): Target[] {
  const cutoff = now - HOUSEKEEPING_MARGIN;
  const familyCutoff = now - RETENTION_GRACE;
  return [
    { key: "audit_log", table: "audit_log", where: "ts < ?", args: [sqliteTs(now - AUDIT_RETENTION_DAYS * 86400)] },
    { key: "login_tickets", table: "login_tickets", where: "expires_at < ?", args: [now - TICKET_CLAIM_GRACE - HOUSEKEEPING_MARGIN] },
    // lookupSession/whoami reject on absolute expiry; the row is dead one day past it.
    { key: "sessions", table: "sessions", where: "absolute_expires_at < ?", args: [cutoff] },
    // Delete confirmations live 5 min; used/expired rows are dead one day past expiry.
    { key: "account_delete_confirmations", table: "account_delete_confirmations", where: "expires_at < ?", args: [cutoff] },
    // introspect() returns inactive for expired or missing rows alike (ACCESS_TTL is 15 min).
    { key: "access_tokens", table: "access_tokens", where: "expires_at < ?", args: [cutoff] },
    {
      key: "refresh_tokens",
      table: "refresh_tokens",
      // Defensive sibling check: a row stays while ANY row of its family is inside the window.
      where: `absolute_expires_at < ? AND NOT EXISTS (
        SELECT 1 FROM refresh_tokens s WHERE s.family_id = refresh_tokens.family_id AND s.absolute_expires_at >= ?)`,
      args: [familyCutoff, familyCutoff],
    },
    {
      key: "oauth_codes_consumed",
      table: "oauth_codes",
      where: "consumed_at IS NOT NULL AND expires_at < ?",
      args: [now - REFRESH_ABS_TTL - ACCESS_TTL - RETENTION_GRACE],
    },
    {
      key: "oauth_codes_unredeemed",
      table: "oauth_codes",
      where: "consumed_at IS NULL AND expires_at < ?",
      args: [now - RETENTION_GRACE],
    },
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
  const result: HousekeepingResult = { deleted: {}, failed: [], skipped: [] };
  // Production runs SKIP_MIGRATIONS=1, so tables added after the last manual migration may not exist yet.
  // Optional targets are skipped (reported in `skipped`, not `failed`) when sqlite_master has no such table.
  let present: Set<string> | null = null;
  for (const t of targets(now)) {
    if (OPTIONAL_TABLES.has(t.table)) {
      try {
        present ??= new Set((await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name)));
      } catch {
        result.failed.push(t.key);
        continue;
      }
      if (!present.has(t.table)) {
        result.skipped.push(t.key);
        continue;
      }
    }
    result.deleted[t.key] = 0;
    try {
      await deleteBounded(db, t, batchSize, maxBatches, (n) => (result.deleted[t.key]! += n));
    } catch {
      result.failed.push(t.key);
    }
  }
  return result;
}

/** Cron entry: run the sweep and log one counts-only line. Never throws. */
export async function scheduledHousekeeping(deps: Deps, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
  try {
    const r = await runHousekeeping(deps.getDb(), now);
    const counts = Object.entries(r.deleted).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`housekeeping ${counts}${r.skipped.length ? ` skipped=${r.skipped.join(",")}` : ""}${r.failed.length ? ` failed=${r.failed.join(",")}` : ""}`);
  } catch {
    console.error("housekeeping_failed");
  }
}
