import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const m = JSON.parse(readFileSync(new URL("../../public/site.webmanifest", import.meta.url), "utf8"));

describe("site.webmanifest (iOS Home Screen web push needs standalone)", () => {
  it("is installable as a standalone app starting at /app", () => {
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/app");
    expect(m.scope).toBe("/");
    expect(m.id).toBe("/app");
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
  });
  it("has 192 and 512 icons that exist on disk", () => {
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    for (const i of m.icons) expect(() => readFileSync(new URL(`../../public${i.src}`, import.meta.url))).not.toThrow();
  });
});
