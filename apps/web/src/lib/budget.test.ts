import { describe, expect, it } from "vitest";
import { BUDGETS, dynamicTargets, gz, pageAssets, resolveJs, staticClosure } from "./budget";

const files: Record<string, string> = {
  "_astro/page.a.js": 'import{x}from"./shared.b.js";import"./side.c.js";const r=()=>import("./renderer.d.js");',
  "_astro/shared.b.js": "export const x=1;",
  "_astro/side.c.js": "console.log(1)",
  "_astro/renderer.d.js": 'import"./gl.e.js";',
  "_astro/gl.e.js": "export{}",
};
const read = (p: string) => files[p];

describe("budget", () => {
  it("reads a page's inline code, module entries, islands and font preloads", () => {
    const a = pageAssets(`<head><link rel="preload" href="/_astro/f.woff2" as="font" type="font/woff2" crossorigin><style>p{}</style>
      <script>theme()</script><script type="application/ld+json">{}</script></head>
      <body><script type="module" src="/_astro/page.a.js"></script>
      <astro-island uid="1" component-url="/_astro/Demo.x.js" renderer-url="/_astro/client.y.js" ssr></astro-island></body>`);
    expect(a).toEqual({
      inlineJs: "theme()", inlineCss: "p{}", entries: ["_astro/page.a.js"],
      islands: ["_astro/Demo.x.js", "_astro/client.y.js"], preloads: ["_astro/f.woff2"],
    });
  });
  it("resolves relative imports inside _astro", () => {
    expect(resolveJs("_astro/page.a.js", "./shared.b.js")).toBe("_astro/shared.b.js");
    expect(resolveJs("_astro/x/y.js", "../z.js")).toBe("_astro/z.js");
  });
  it("follows static imports only; dynamic imports are the lazy part", () => {
    const initial = staticClosure(["_astro/page.a.js"], read);
    expect([...initial].sort()).toEqual(["_astro/page.a.js", "_astro/shared.b.js", "_astro/side.c.js"]);
    const lazy = dynamicTargets(initial, read);
    expect([...lazy]).toEqual(["_astro/renderer.d.js"]);
    expect([...staticClosure([...lazy], read)].sort()).toEqual(["_astro/gl.e.js", "_astro/renderer.d.js"]);
  });
  it("resolves root-absolute specifiers and skips files that aren't in dist", () => {
    expect(resolveJs("_astro/x/y.js", "/_astro/z.js")).toBe("_astro/z.js");
    const gone: Record<string, string> = { "_astro/a.js": 'import"./missing.js";const r=()=>import("./lazy.js");' };
    expect([...staticClosure(["_astro/a.js", "_astro/nope.js"], (p) => gone[p])]).toEqual(["_astro/a.js"]);
    expect([...dynamicTargets(["_astro/a.js", "_astro/nope.js"], (p) => gone[p])]).toEqual(["_astro/lazy.js"]);
  });
  it("reads template-literal specifiers too (Rolldown emits import(`./x.js`))", () => {
    const tl: Record<string, string> = {
      "_astro/a.js": "import{t as e}from`./b.js`;const r=()=>import(`./c.js`);",
      "_astro/b.js": "export{}",
      "_astro/c.js": "export{}",
    };
    const initial = staticClosure(["_astro/a.js"], (p) => tl[p]);
    expect([...initial].sort()).toEqual(["_astro/a.js", "_astro/b.js"]);
    expect([...dynamicTargets(initial, (p) => tl[p])]).toEqual(["_astro/c.js"]);
  });
  it("measures gzip -9 and carries the ceilings from the plan", () => {
    expect(gz("a".repeat(1000))).toBeLessThan(40);
    expect(BUDGETS).toEqual({
      criticalJs: 8 * 1024, allJsNoIslands: 12 * 1024, islandJs: 90 * 1024, inlineCss: 14 * 1024,
      html: 25 * 1024, htmlUi: 40 * 1024, preloadFonts: 24 * 1024, siteFonts: 60 * 1024,
      renderer: 3 * 1024, catBin: 10 * 1024, poster: 6 * 1024,
    });
  });
});
