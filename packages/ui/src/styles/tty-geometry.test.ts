import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("B10: tty family meets the 44px control geometry", () => {
  it("the Wordmark link (a.mw-wordmark) has a min-height of --control-height", () => {
    const css = readFileSync(join(__dirname, "components.css"), "utf8");
    const rule = css.match(/a\.mw-wordmark\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain("min-height: var(--control-height)");
  });
});
