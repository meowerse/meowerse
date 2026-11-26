// Proves the worker typecheck gate bites: a deliberate type error must exit non-zero and a clean
// file must exit zero, under each worker's REAL tsconfig (strict, noUncheckedIndexedAccess, types).
// Fixtures live in a throwaway `.selftest-*` dir next to each tsconfig and are always removed.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORKERS = ["api", "auth", "auth-bot", "edge", "meowsenger"];
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** tsc over `files` using `<worker>/<config>` as the base; returns exit code + output. */
function tsc(worker: string, config: string, files: Record<string, string>) {
  const wdir = join(ROOT, "workers", worker);
  const dir = mkdtempSync(join(wdir, ".selftest-"));
  made.push(dir);
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  // `extends` keeps compilerOptions; the fixture's own include/exclude replace the worker's.
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ extends: `../${config}`, include: Object.keys(files), exclude: [] }),
  );
  const p = Bun.spawnSync([TSC, "-p", dir], { cwd: wdir });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

const TSC = join(ROOT, "node_modules/.bin/tsc");
setDefaultTimeout(240_000); // real tsc runs, on a possibly loaded machine

const BAD = 'export const n: number = "not a number";\n';
const GOOD = "export const n: number = 1;\n";
// Only an error because of the base config's noUncheckedIndexedAccess.
const UNCHECKED = "const a: number[] = [];\nexport const f = a[0].toFixed();\n";
const NODE_IMPORT = 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n';

describe("typecheck gate bites", () => {
  for (const w of WORKERS) {
    const js = w === "edge";
    const [bad, good] = js
      ? ["/** @type {number} */\nexport const n = 'not a number';\n", "/** @type {number} */\nexport const n = 1;\n"]
      : [BAD, GOOD];
    const ext = js ? "js" : "ts";
    test(`${w}: prod config fails on type errors, passes a clean file`, () => {
      const clean = tsc(w, "tsconfig.json", { [`good.${ext}`]: good });
      expect(clean.out).toBe("");
      expect(clean.code).toBe(0);
      const files: Record<string, string> = { [`bad.${ext}`]: bad, [`good.${ext}`]: good };
      if (!js) Object.assign(files, { "idx.ts": UNCHECKED, "n.ts": NODE_IMPORT });
      const r = tsc(w, "tsconfig.json", files);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(`bad.${ext}`);
      expect(r.out).not.toContain(`good.${ext}`);
      if (!js) {
        expect(r.out).toContain("idx.ts"); // noUncheckedIndexedAccess enforced
        expect(r.out).toContain("n.ts"); // prod config has no node types
      }
    });

    if (js) continue;
    test(`${w}: test config accepts node: imports, still rejects type errors`, () => {
      const ok = tsc(w, "tsconfig.test.json", { "good.ts": GOOD, "n.ts": NODE_IMPORT });
      expect(ok.out).toBe("");
      expect(ok.code).toBe(0);
      const r = tsc(w, "tsconfig.test.json", { "bad.ts": BAD, "idx.ts": UNCHECKED });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("bad.ts");
      expect(r.out).toContain("idx.ts");
    });
  }
});

describe("wiring", () => {
  const pkg = (w: string) => JSON.parse(readFileSync(join(ROOT, "workers", w, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const w of WORKERS) {
    test(`${w} has a typecheck script that runs tsc`, () => {
      expect(pkg(w).scripts.typecheck).toMatch(/\btsc -p tsconfig\.json\b/);
    });
  }
  test("turbo and root expose a typecheck task", () => {
    expect(JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")).tasks.typecheck).toBeDefined();
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.typecheck).toBe("turbo run typecheck");
  });
});
