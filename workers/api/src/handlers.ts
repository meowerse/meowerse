import { slugify } from "@meowerse/ts-shared";
import type { DbClient, Meow } from "./types";

export const MAX_TEXT = 280;
export const MAX_BATCH = 25;

/** Validation outcome for a single meow's text. */
export type TextResult = { ok: true; text: string; slug: string } | { ok: false; error: string };

/** Trim + validate meow text, deriving its slug. Pure + unit-testable. */
export function validateText(input: unknown): TextResult {
  if (typeof input !== "string") return { ok: false, error: "text must be a string" };
  const text = input.trim();
  if (text === "") return { ok: false, error: "text must not be empty" };
  if (text.length > MAX_TEXT) return { ok: false, error: `text must be <= ${MAX_TEXT} chars` };
  return { ok: true, text, slug: slugify(text) };
}

const CREATE_SQL = "INSERT INTO meows (text, slug) VALUES (?, ?) RETURNING id, text, slug, created_at";

/** Insert a validated meow, returning the persisted row in ONE round-trip
 *  (INSERT … RETURNING — no separate SELECT read-back; Turso is remote, ~200-400ms
 *  per hop, so halving the round-trips halves the latency + rows-read). */
export async function createMeow(db: DbClient, text: string, slug: string): Promise<Meow> {
  const res = await db.execute({ sql: CREATE_SQL, args: [text, slug] });
  return res.rows[0] as unknown as Meow;
}

/** Insert MANY validated meows in a SINGLE round-trip via db.batch (one network
 *  hop for the whole batch instead of N sequential INSERTs). Rows in input order. */
export async function createMeows(db: DbClient, items: { text: string; slug: string }[]): Promise<Meow[]> {
  if (items.length === 0) return [];
  const results = await db.batch(items.map((i) => ({ sql: CREATE_SQL, args: [i.text, i.slug] })));
  return results.map((r) => r.rows[0] as unknown as Meow);
}

/** Default page size for the public list — bounds per-request rows-read + CPU +
 *  payload regardless of table growth. */
export const LIST_LIMIT = 100;

/** List the newest meows (capped at LIST_LIMIT). `beforeId` keyset-paginates older
 *  rows (WHERE id < ?) via the id primary-key index — no unbounded scan, no OFFSET. */
export async function listMeows(db: DbClient, beforeId?: number, limit = LIST_LIMIT): Promise<Meow[]> {
  const res = beforeId
    ? await db.execute({ sql: "SELECT id, text, slug, created_at FROM meows WHERE id < ? ORDER BY id DESC LIMIT ?", args: [beforeId, limit] })
    : await db.execute({ sql: "SELECT id, text, slug, created_at FROM meows ORDER BY id DESC LIMIT ?", args: [limit] });
  return res.rows as unknown as Meow[];
}

/** Per-op result for the batch endpoint. */
export interface BatchOpResult {
  status: number;
  meow?: Meow;
  error?: string;
}

/** Validate a single batch op's SHAPE + text (pure, NO db) → the insertable
 *  {text,slug} or a per-op error. Lets handleBatch validate everything first and
 *  then batch-insert only the valid ops in one round-trip. */
export function validateBatchOp(op: unknown): { ok: true; text: string; slug: string } | { ok: false; status: number; error: string } {
  if (!op || typeof op !== "object" || (op as { op?: unknown }).op !== "create") {
    return { ok: false, status: 400, error: "unsupported op" };
  }
  const v = validateText((op as { text?: unknown }).text);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  return { ok: true, text: v.text, slug: v.slug };
}
