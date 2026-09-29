import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";

describe("package.json exports", () => {
  it.each(Object.entries(pkg.exports))("%s points at a real file", (_key, target) => {
    const probe = String(target).replace("*", "vt323-marks.woff2");
    expect(existsSync(join(__dirname, "..", probe)), probe).toBe(true);
  });
  it("offers the React-free subpaths the static site needs", () => {
    expect(pkg.exports).toMatchObject({
      "./theme": "./src/lib/theme.ts",
      "./status": "./src/lib/status.ts",
      "./seo": "./src/lib/seo.ts",
      "./tokens.json": "./design/tokens.json",
      "./assets/fonts/*": "./src/assets/fonts/*",
    });
  });
});
