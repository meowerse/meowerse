import { describe, expect, it } from "vitest";
import { DEMO_SLUGS, DEMO_SOURCES } from "./demos";
import { COMPONENT_PAGES } from "./registry";

describe("interactive demos", () => {
  it("exist for exactly these components", () =>
    expect(DEMO_SLUGS).toEqual(["app-header", "auth-gate", "code", "confirm-dialog", "modal", "prompt", "radio-group", "recovery-codes", "theme-toggle", "toast-provider"]));
  it("cover every component that has nothing to show without interaction", () => {
    for (const p of COMPONENT_PAGES.filter((x) => x.interactiveOnly)) expect(DEMO_SLUGS, p.name).toContain(p.slug);
  });
  it("belong to real component pages and ship their own source", () => {
    const slugs = COMPONENT_PAGES.map((p) => p.slug);
    for (const s of DEMO_SLUGS) {
      expect(slugs).toContain(s);
      expect(DEMO_SOURCES[s]).toMatch(/export default function Demo\(\)/);
    }
  });
});
