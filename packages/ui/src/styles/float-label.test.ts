import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim())).filter(Boolean);

// Apps put their own `.mw-field__label` spans inside `.mw-field` (meowsenger-web): ui must never style that
// name, and every floating-label rule must only reach inside a `--float` root, so a default Field, Prompt or
// an app's own markup can never pick up the absolute positioning.
describe("labelPlacement=float styles", () => {
  it("never style the app-owned .mw-field__label / .mw-prompt__label names", () =>
    expect(selectors.filter((s) => /\.mw-(field|prompt)__label\b/.test(s))).toEqual([]));
  it("scope every __float-label selector under its --float root", () => {
    const float = selectors.filter((s) => s.includes("__float-label"));
    expect(float.length).toBeGreaterThan(5);
    expect(float.filter((s) => !/\.mw-(field|prompt)--float\b/.test(s))).toEqual([]);
  });
});
