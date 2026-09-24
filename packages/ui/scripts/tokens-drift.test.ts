import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drift, findAlxnkoDev, significantDrift } from "./tokens-drift";

describe("drift", () => {
  it("reports differing and missing leaves by path", () => {
    expect(drift({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 3, z: 4 } })).toEqual(["a.y", "a.z"]);
  });
  it("is empty for equal trees", () => {
    expect(drift({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
  });
});

describe("significantDrift", () => {
  it("excludes control and type.leading (and their descendants), but not a look-alike key", () => {
    const a = { control: { height: 44 }, controlPanel: { x: 1 }, type: { leading: { tight: 1.2 } } };
    const b = { control: { height: 48 }, controlPanel: { x: 2 }, type: { leading: { tight: 1.3 } } };
    expect(significantDrift(a, b)).toEqual(["controlPanel.x"]);
  });
});

describe("findAlxnkoDev", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join("/var/tmp", "tokens-drift-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a sibling alxnko.dev checkout from several levels below, worktree-shaped", () => {
    const alxnko = join(root, "alxnko.dev");
    mkdirSync(join(alxnko, "design"), { recursive: true });
    writeFileSync(join(alxnko, "design/tokens.json"), "{}");
    // Mirrors meowerse/.claude/worktrees/<name>/packages/ui/scripts.
    const scripts = join(root, "meowerse", ".claude", "worktrees", "brand-v2-ds", "packages", "ui", "scripts");
    mkdirSync(scripts, { recursive: true });
    expect(findAlxnkoDev(scripts)).toBe(alxnko);
  });

  it("returns undefined when no ancestor has an alxnko.dev checkout", () => {
    const scripts = join(root, "a", "b", "c");
    mkdirSync(scripts, { recursive: true });
    expect(findAlxnkoDev(scripts)).toBeUndefined();
  });
});
