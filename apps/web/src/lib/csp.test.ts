import { describe, expect, it } from "vitest";
import { buildCsp, dataUrls, inlineBlocks, MAX_HEADER, probeOrigins, sha256, styleAttrs } from "./csp";

describe("csp", () => {
  it("hashes like the browser (sha256, base64)", () =>
    expect(sha256("a")).toBe("'sha256-ypeBEsobvcr6wjGzmiPcTaeG7/gUfE5yuYB3ha/uSLs='"));
  it("collects inline scripts and styles, skipping src= scripts and non-executable data blocks", () => {
    const html = `<script>a()</script><script type="module">b()</script><script src="/x.js"></script>
      <script type="application/ld+json">{"x":1}</script><script></script><style>p{}</style>`;
    expect(inlineBlocks(html)).toEqual({ scripts: ["a()", "b()"], styles: ["p{}"] });
  });
  it("counts style attributes and finds data: URLs", () => {
    expect(styleAttrs('<p style="color:red">x</p><div>ok</div>')).toBe(1);
    // Fix round 1 (minor): the zero-style="" path — postbuild.ts's happy path — was untested.
    expect(styleAttrs("<p>x</p><div>ok</div>")).toBe(0);
    expect(dataUrls('<img src="data:image/png;base64,AA"> a{background:url("data:image/svg+xml,x")}')).toHaveLength(2);
    expect(dataUrls('<img src="/cat.webp">')).toEqual([]);
  });
  it("builds one strict policy with Trusted Types and the probe origins", () => {
    const csp = buildCsp(["<script>a()</script><style>p{}</style>", "<script>a()</script>"], ["https://b.example", "https://a.example"]);
    expect(csp).toContain(`script-src 'self' ${sha256("a()")};`);
    expect(csp).toContain(`style-src 'self' ${sha256("p{}")};`);
    expect(csp).toContain("connect-src 'self' https://a.example https://b.example;");
    for (const d of ["default-src 'none'", "img-src 'self'", "font-src 'self'", "base-uri 'none'", "form-action 'none'",
      "frame-ancestors 'none'", "upgrade-insecure-requests", "require-trusted-types-for 'script'", "trusted-types 'none'"])
      expect(csp).toContain(d);
    expect(csp).not.toMatch(/unsafe-(inline|eval)/);
    expect(MAX_HEADER).toBe(2000);
  });
  it("takes connect-src origins from probe statuses only, deduplicated", () =>
    expect(probeOrigins([
      { status: { kind: "probe", url: "https://auth.alxnko.dev/.well-known/openid-configuration" } },
      { status: { kind: "probe", url: "https://auth.alxnko.dev/other" } },
      { status: { kind: "static" } },
      {},
    ])).toEqual(["https://auth.alxnko.dev"]));
});
