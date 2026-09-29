import { describe, expect, it } from "vitest";
import { headersFor, parseHeaders } from "./headers";

const SRC = `# comment
/*
  X-A: 1
  Cache-Control: public
https://:project.pages.dev/*
  X-Robots-Tag: noindex
/_astro/*
  Cache-Control: immutable
`;

describe("_headers parsing", () => {
  it("applies path rules, joins same-name headers like Pages, and skips host rules", () => {
    const rules = parseHeaders(SRC);
    expect(rules).toHaveLength(2);
    expect(Object.fromEntries(headersFor(rules, "/"))).toEqual({ "x-a": "1", "cache-control": "public" });
    expect(headersFor(rules, "/_astro/a.js").get("cache-control")).toBe("public, immutable");
    expect(headersFor(rules, "/").has("x-robots-tag")).toBe(false);
  });
  // Fix round 1 (minor): a stray indented line with no colon (i === -1) must not become a header.
  it("skips a header line without a colon", () => {
    const rules = parseHeaders("/*\n  garbage\n  X-A: 1\n");
    expect(Object.fromEntries(headersFor(rules, "/"))).toEqual({ "x-a": "1" });
  });
});
