import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

describe("fonts", () => {
  it("ships only JetBrains Mono + the VT323 mark subset", () => {
    const css = readFileSync(join(__dirname, "fonts.css"), "utf8");
    expect(css).not.toMatch(/outfit|bytesized/i);
    expect(css).toContain("@fontsource/jetbrains-mono/700.css");
    expect(Object.keys(pkg.dependencies)).toEqual(["@fontsource/jetbrains-mono", "@fontsource/vt323"]);
  });
});
