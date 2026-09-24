// Compares packages/ui/design/tokens.json with alxnko.dev's design/tokens.json (B5).
// Local: ALXNKO_DEV_DIR (default ../../../alxnko.dev from the repo root). CI: skipped with a notice
// when the private repo isn't checked out — `just tokens-drift` is part of the release checklist.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function drift(a: unknown, b: unknown, path = ""): string[] {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((k) => drift((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
}

if (import.meta.main) {
  const dir = process.env.ALXNKO_DEV_DIR ?? resolve(import.meta.dir, "../../../../alxnko.dev");
  const theirs = resolve(dir, "design/tokens.json");
  if (!existsSync(theirs)) { console.warn(`tokens-drift: ${theirs} not found — skipped`); process.exit(0); }
  const ours = JSON.parse(readFileSync(resolve(import.meta.dir, "../design/tokens.json"), "utf8"));
  const other = JSON.parse(readFileSync(theirs, "utf8"));
  const diff = drift(ours, other).filter((p) => !p.startsWith("control") && !p.startsWith("type.leading"));
  if (diff.length) { console.error("token drift vs alxnko.dev:\n  " + diff.join("\n  ")); process.exit(1); }
  console.log("tokens in sync with alxnko.dev");
}
