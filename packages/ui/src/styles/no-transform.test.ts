import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("B14: user text is never case-transformed", () => {
  it("no stylesheet in @meowerse/ui uses text-transform", () => {
    const dir = join(__dirname);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".css")))
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/text-transform\s*:\s*(lower|upper|capital)/);
  });
});
