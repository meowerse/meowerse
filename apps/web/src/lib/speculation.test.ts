import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";
import { HEAVY_PATHS, NEVER_PATHS, NEVER_SELECTORS, SPECULATION_CONTENT_TYPE, SPECULATION_PATH, SPECULATION_RULES, speculationJson } from "./speculation";

const BASE = "https://meow.alxnko.dev/";
type Cond = Record<string, unknown>;
type Link = { href: string; attrs?: Record<string, string> };

// A tiny evaluator of the document-rule `where` grammar we use (and/not/href_matches/selector_matches),
// with the browser's semantics: a pattern string is resolved against the page's own URL.
function matches(c: Cond, l: Link): boolean {
  if ("and" in c) return (c.and as Cond[]).every((x) => matches(x, l));
  if ("or" in c) return (c.or as Cond[]).some((x) => matches(x, l));
  if ("not" in c) return !matches(c.not as Cond, l);
  if ("href_matches" in c) return [c.href_matches as string | string[]].flat().some((p) => new URLPattern(p, BASE).test(new URL(l.href, BASE).href));
  if ("selector_matches" in c) {
    const a = l.attrs ?? {};
    return [c.selector_matches as string | string[]].flat().some((s) => {
      const m = /^\[(\w+)(?:(~?)=([^\]]+))?\]$/.exec(s)!; // [attr], [attr=v], [attr~=v]
      const v = a[m[1]!];
      if (v === undefined) return false;
      return m[3] === undefined || (m[2] ? v.split(/\s+/).includes(m[3]) : v === m[3]);
    });
  }
  throw new Error(`unsupported condition ${JSON.stringify(c)}`);
}
const tier = (name: "prerender" | "prefetch", l: Link) => SPECULATION_RULES[name].some((r) => matches(r.where, l));

describe("speculation rules", () => {
  it("serialises to valid JSON that round-trips, with document rules at moderate eagerness only", () => {
    const parsed = JSON.parse(speculationJson());
    expect(parsed).toEqual(JSON.parse(JSON.stringify(SPECULATION_RULES)));
    expect(Object.keys(parsed).sort()).toEqual(["prefetch", "prerender"]);
    for (const rule of [...parsed.prerender, ...parsed.prefetch]) {
      expect(rule.source).toBe("document");
      expect(rule.eagerness).toBe("moderate");
      expect(rule.urls).toBeUndefined();
    }
    expect(SPECULATION_PATH).toBe("/speculation-rules.json");
    expect(SPECULATION_CONTENT_TYPE).toBe("application/speculationrules+json");
  });

  it("speculates same-origin pages: prerender and prefetch", () => {
    for (const href of ["/", "/ui/", "/p/auth/", "/ui/components/modal/?x=1", "https://meow.alxnko.dev/ui/"]) {
      expect(tier("prerender", { href }), href).toBe(true);
      expect(tier("prefetch", { href }), href).toBe(true);
    }
  });

  it("never speculates another origin (auth.alxnko.dev, any scheme or subdomain)", () => {
    for (const href of ["https://auth.alxnko.dev/", "https://auth.alxnko.dev/login", "https://example.com/", "http://meow.alxnko.dev/", "https://sub.meow.alxnko.dev/"]) {
      expect(tier("prerender", { href }), href).toBe(false);
      expect(tier("prefetch", { href }), href).toBe(false);
    }
  });

  it("only prefetches the heavy WebGL/demo pages", () => {
    for (const href of ["/ui/cat3d/", "/ui/playground/", "/ui/playground/?c=modal"]) {
      expect(tier("prerender", { href }), href).toBe(false);
      expect(tier("prefetch", { href }), href).toBe(true);
    }
    expect(HEAVY_PATHS).toEqual(["/ui/cat3d*", "/ui/playground*"]);
  });

  it("never speculates logout/state-changing paths or non-HTML assets", () => {
    for (const href of ["/logout/", "/signout", "/sign-out/", "/log-out/", "/api/session", "/auth/callback", "/cdn-cgi/rum",
      "/sitemap.xml", "/robots.txt", "/favicon.ico", "/favicon.svg", "/icon-512.png", "/x.webp", "/site.webmanifest", "/f.woff2", "/data.json", "/_astro/a.js", "/a.css"]) {
      expect(tier("prerender", { href }), href).toBe(false);
      expect(tier("prefetch", { href }), href).toBe(false);
    }
    expect(NEVER_PATHS.length).toBeGreaterThan(0);
  });

  it("never speculates new-tab, nofollow or download links", () => {
    for (const attrs of <Record<string, string>[]>[{ target: "_blank" }, { rel: "nofollow" }, { rel: "noopener nofollow" }, { download: "" }]) {
      expect(tier("prerender", { href: "/ui/", attrs }), JSON.stringify(attrs)).toBe(false);
      expect(tier("prefetch", { href: "/ui/", attrs }), JSON.stringify(attrs)).toBe(false);
    }
    expect(tier("prerender", { href: "/ui/", attrs: { rel: "noopener", target: "_self" } })).toBe(true);
    expect(NEVER_SELECTORS).toEqual(["[rel~=nofollow]", "[target=_blank]", "[download]"]);
  });

  it("needs no CSP token: the policy is unchanged by it and still has no unsafe tokens", () => {
    const csp = buildCsp(["<script>a()</script>"]);
    expect(csp).not.toMatch(/speculation|unsafe-|wasm|strict-dynamic/);
    expect(csp).toContain("require-trusted-types-for 'script'; trusted-types 'none'");
    expect(csp).toContain("default-src 'none'");
  });
});
