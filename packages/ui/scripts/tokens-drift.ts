// Compares packages/ui/design/tokens.json with alxnko.dev's design/tokens.json (B5).
// Local: ALXNKO_DEV_DIR, else the nearest ancestor's sibling alxnko.dev checkout (same idea as
// scripts/extract-cat.ts's sceneDir — works from the main checkout and from any worktree, e.g.
// meowerse/.claude/worktrees/<name>/packages/ui/scripts). CI: skipped with a notice when the private
// repo isn't checked out (process.env.CI set) — `just tokens-drift` is part of the release checklist.
// Locally, not finding it is a hard failure: a local run must never look like a pass.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function drift(a: unknown, b: unknown, path = ""): string[] {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((k) => drift((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
}

const isOrUnder = (p: string, prefix: string) => p === prefix || p.startsWith(`${prefix}.`);

/** `drift()` filtered to the paths that matter: excludes exactly `control` and `type.leading` (and
 * their descendants), which alxnko.dev may add later — not a bare prefix match, so e.g. a
 * `controlPanel` key is still reported. */
export function significantDrift(a: unknown, b: unknown): string[] {
  return drift(a, b).filter((p) => !isOrUnder(p, "control") && !isOrUnder(p, "type.leading"));
}

/** Nearest ancestor's sibling alxnko.dev checkout, found by walking up from `startDir` and checking
 * `<ancestor>/alxnko.dev/design/tokens.json` at each level. Returns the alxnko.dev directory, or
 * undefined if no ancestor has one. */
export function findAlxnkoDev(startDir: string): string | undefined {
  for (let d = startDir; ; d = dirname(d)) {
    const candidate = join(d, "alxnko.dev");
    if (existsSync(join(candidate, "design/tokens.json"))) return candidate;
    const parent = dirname(d);
    if (parent === d) return undefined;
  }
}

function readJSON(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`tokens-drift: couldn't read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`tokens-drift: couldn't parse ${path} as JSON: ${(e as Error).message}`);
  }
}

if (import.meta.main) {
  const dir = process.env.ALXNKO_DEV_DIR ?? findAlxnkoDev(import.meta.dir);
  const theirsPath = dir ? resolve(dir, "design/tokens.json") : undefined;
  if (!theirsPath || !existsSync(theirsPath)) {
    if (process.env.CI) {
      console.warn(`tokens-drift: alxnko.dev not found${theirsPath ? ` (${theirsPath})` : ""} — skipped`);
      process.exit(0);
    }
    console.error(
      `tokens-drift: alxnko.dev not found${theirsPath ? ` at ${theirsPath}` : " above this script"}. Set ALXNKO_DEV_DIR to its checkout path.`,
    );
    process.exit(1);
  }
  const ours = readJSON(resolve(import.meta.dir, "../design/tokens.json"));
  const other = readJSON(theirsPath);
  const diff = significantDrift(ours, other);
  if (diff.length) { console.error("token drift vs alxnko.dev:\n  " + diff.join("\n  ")); process.exit(1); }
  console.log("tokens in sync with alxnko.dev");
}
