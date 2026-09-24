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

  it("VT323 mark subset covers every character the wordmarks need", () => {
    const covered = readFileSync(join(__dirname, "../assets/fonts/vt323-marks.txt"), "utf8");
    for (const ch of new Set("meowerse_meowsenger_auth_ui_")) {
      expect(covered, `missing "${ch}"`).toContain(ch);
    }
  });
});
