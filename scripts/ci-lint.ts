// Workflow guard: fails CI if any .github/workflows/*.yml is invalid or violates house rules.
// Runs with bun only (Bun.YAML), before `bun install`, so it has zero dependencies.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", ".github", "workflows");
const errors: string[] = [];

// Bun.YAML keeps the last of two equal keys silently, so duplicate keys need a line scan.
// shortcut: block-style mappings only (flow `{a: 1}` is not scanned); upgrade if workflows use flow maps with repeated keys.
function duplicateKeys(src: string): string[] {
  const out: string[] = [];
  const stack: { indent: number; keys: Set<string> }[] = [];
  let skipAbove = -1; // inside a block scalar (| or >) indented deeper than this
  src.split("\n").forEach((raw, i) => {
    if (!raw.trim() || raw.trim().startsWith("#")) return;
    const indent = raw.length - raw.trimStart().length;
    if (skipAbove >= 0) { if (indent > skipAbove) return; skipAbove = -1; }
    const m = /^(\s*)(?:- +)?([A-Za-z0-9_.\-"']+)\s*:(?:\s|$)(.*)$/.exec(raw);
    if (!m) return;
    const isItem = /^\s*- /.test(raw);
    const keyIndent = indent + (isItem ? raw.trimStart().indexOf(m[2]) : 0);
    while (stack.length && stack[stack.length - 1].indent > keyIndent) stack.pop();
    if (isItem) while (stack.length && stack[stack.length - 1].indent >= keyIndent) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.indent < keyIndent) stack.push((top = { indent: keyIndent, keys: new Set() }));
    if (top.keys.has(m[2])) out.push(`line ${i + 1}: duplicate key "${m[2]}"`);
    top.keys.add(m[2]);
    if (/^[|>][-+0-9]*\s*(#.*)?$/.test(m[3].trim())) skipAbove = indent;
  });
  return out;
}

const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
if (!files.length) errors.push("no workflow files found");
for (const f of files) {
  const src = readFileSync(join(dir, f), "utf8");
  const fail = (m: string) => errors.push(`${f}: ${m}`);
  let doc: any;
  try { doc = Bun.YAML.parse(src); } catch (e) { fail(`YAML parse error: ${e}`); continue; }
  for (const d of duplicateKeys(src)) fail(d);
  if (!doc?.on) fail("missing `on:`");
  if (!doc?.permissions) fail("missing top-level `permissions:`");
  if (!doc?.concurrency?.group) fail("missing top-level `concurrency.group`");
  const jobs = Object.entries<any>(doc?.jobs ?? {});
  if (!jobs.length) fail("no jobs");
  for (const [id, job] of jobs) {
    if (typeof job["timeout-minutes"] !== "number") fail(`job ${id}: missing numeric timeout-minutes`);
    if (job["continue-on-error"]) fail(`job ${id}: continue-on-error is not allowed`);
    for (const [n, s] of (job.steps ?? []).entries()) {
      const where = `job ${id} step ${n + 1} (${s.name ?? s.uses ?? s.run?.split("\n")[0]})`;
      if (s["continue-on-error"]) fail(`${where}: continue-on-error is not allowed`);
      if (typeof s.run === "string" && /\|\|\s*true\b/.test(s.run)) fail(`${where}: \`|| true\` swallows failures`);
      if (typeof s.uses === "string" && !s.uses.startsWith("./") && !/^[^@\s]+@[0-9a-f]{40}$/.test(s.uses))
        fail(`${where}: action must be pinned to a 40-hex commit SHA (got ${s.uses})`);
    }
  }
  // house rule: a quoted-less "name: x: y" is a YAML error already; also flag names containing ": " even when quoted-looking
  for (const [i, l] of src.split("\n").entries())
    if (/^\s*(?:- )?name:\s+[^"'\s][^#]*:\s/.test(l)) fail(`line ${i + 1}: unquoted ": " in name`);
}

if (errors.length) { console.error("ci-lint FAILED:\n" + errors.map((e) => "  - " + e).join("\n")); process.exit(1); }
console.log(`ci-lint ok: ${files.length} workflow file(s)`);
