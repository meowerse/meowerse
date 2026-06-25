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

/** Insert a validated meow and read it back. Returns the persisted row. */
export async function createMeow(db: DbClient, text: string, slug: string): Promise<Meow> {
  const ins = await db.execute({
    sql: "INSERT INTO meows (text, slug) VALUES (?, ?)",
    args: [text, slug],
  });
  const id = Number(ins.lastInsertRowid ?? 0);
  const sel = await db.execute({
    sql: "SELECT id, text, slug, created_at FROM meows WHERE id = ?",
    args: [id],
  });
  return sel.rows[0] as unknown as Meow;
}

/** List all meows, newest first. */
export async function listMeows(db: DbClient): Promise<Meow[]> {
  const res = await db.execute("SELECT id, text, slug, created_at FROM meows ORDER BY id DESC");
  return res.rows as unknown as Meow[];
}

/** Per-op result for the batch endpoint. */
export interface BatchOpResult {
  status: number;
  meow?: Meow;
  error?: string;
}

/** Execute a single batch op. Only {op:"create", text} is supported. */
export async function runBatchOp(db: DbClient, op: unknown): Promise<BatchOpResult> {
  if (!op || typeof op !== "object" || (op as { op?: unknown }).op !== "create") {
    return { status: 400, error: "unsupported op" };
  }
  const v = validateText((op as { text?: unknown }).text);
  if (!v.ok) return { status: 400, error: v.error };
  const meow = await createMeow(db, v.text, v.slug);
  return { status: 201, meow };
}
