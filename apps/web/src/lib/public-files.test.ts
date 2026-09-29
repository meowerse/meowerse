import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import tokens from "@meowerse/ui/tokens.json";
import { SITE } from "./site";

const pub = (f: string) => readFileSync(join(__dirname, "../../public", f), "utf8");

describe("public files (W-08, W-19)", () => {
  it("the manifest is complete", () => {
    const m = JSON.parse(pub("site.webmanifest"));
    expect(m).toMatchObject({ name: "meowerse", id: "/", start_url: "/", display: "standalone" });
    expect(m.description.length).toBeGreaterThan(20);
  });
  it("the manifest matches the site: the page's own description and dark background (packages/brand/scripts/build.sh writes it)", () => {
    const m = JSON.parse(pub("site.webmanifest"));
    expect(m.description).toBe(SITE.description);
    expect(m.theme_color).toBe(tokens.semantic.dark.bg);
    expect(m.background_color).toBe(tokens.semantic.dark.bg);
  });
  it("robots.txt points at the sitemap", () => expect(pub("robots.txt")).toContain("Sitemap: https://meow.alxnko.dev/sitemap.xml"));
  it("security.txt is canonical for this host", () =>
    expect(pub(".well-known/security.txt")).toContain("Canonical: https://meow.alxnko.dev/.well-known/security.txt"));
  it("_headers has the CSP slot and the security headers", () => {
    const h = pub("_headers");
    expect(h.split("Content-Security-Policy: __CSP__")).toHaveLength(2);
    for (const k of ["Strict-Transport-Security: max-age=31536000; includeSubDomains; preload", "Permissions-Policy:",
      "Cross-Origin-Opener-Policy: same-origin", "X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer"])
      expect(h).toContain(k);
    expect(h).toContain("https://:project.pages.dev/*\n  X-Robots-Tag: noindex");
  });
});
