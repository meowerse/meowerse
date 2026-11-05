import { describe, expect, it } from "vitest";
import { isPrefetchable, linkProps, prefetchAttr, PREFETCH_ALLOWED } from "./prefetch";

const FORBIDDEN = ["/login", "/signup", "/consent", "/verify", "/account", "/dashboard", "/error", "/authorize", "/logout", "/developers", "/api/session", "/.well-known/openid-configuration", "/token", "/userinfo", "/jwks.json"];

describe("prefetch allowlist", () => {
  it("allows the public static pages, with query, hash and trailing slash", () => {
    for (const p of ["/", "/about", "/docs", "/privacy", "/terms"]) {
      expect(isPrefetchable(p)).toBe(true);
      expect(isPrefetchable(`${p === "/" ? "" : p}/`)).toBe(true);
      expect(isPrefetchable(`${p}?x=1#y`)).toBe(true);
      expect(prefetchAttr(p)).toEqual({ "data-astro-prefetch": "hover" });
    }
  });
  it("refuses every forbidden path in all spellings", () => {
    for (const p of FORBIDDEN) {
      for (const v of [p, `${p}/`, `${p}//`, `${p}?next=%2Fabout`, `${p}#x`, p.toUpperCase(), `/${p.slice(1, 2).toUpperCase()}${p.slice(2)}`, `${p}/child`]) {
        expect(isPrefetchable(v), v).toBe(false);
        expect(prefetchAttr(v), v).toEqual({});
      }
    }
  });
  it("refuses cross-origin, protocol-relative, scheme, relative and odd hrefs", () => {
    for (const h of ["https://auth.alxnko.dev/about", "//evil.example/about", "mailto:a@b.c", "about", "", "/\\about", "/about/../login", "/ABOUT", "/about%2Flogin", "javascript:0"]) {
      expect(isPrefetchable(h), h).toBe(false);
    }
  });
  it("allowlist contains no forbidden path", () => {
    for (const p of FORBIDDEN) expect(PREFETCH_ALLOWED.has(p)).toBe(false);
  });
});

describe("linkProps", () => {
  it("returns href plus the attribute only for allowlisted targets (trailing slash tolerated)", () => {
    expect(linkProps("/docs/")).toEqual({ href: "/docs/", "data-astro-prefetch": "hover" });
    expect(linkProps("/login")).toEqual({ href: "/login" });
  });
});
