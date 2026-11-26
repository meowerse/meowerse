import { expect, test } from "vitest";
// @ts-ignore -- this package has no @types/node; vitest runs it in node
import { readFileSync } from "node:fs";
import { DEFAULT_ORIGINS } from "./security";

// Strip // and /* */ comments outside strings, then trailing commas, so the shipped jsonc parses.
function parseJsonc(src: string): any {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i]!;
      else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// A dev origin must never ship: production CORS is https on our zones only.
const PROD_HOST = /^([a-z0-9-]+\.)*alxnko\.(dev|eu\.org)$/;
function assertProdOrigins(list: string) {
  const origins = list.split(",").map((o) => o.trim());
  expect(origins.length).toBeGreaterThan(0);
  for (const o of origins) {
    const u = new URL(o);
    expect(u.protocol, o).toBe("https:");
    expect(u.hostname, o).toMatch(PROD_HOST);
    expect(o, o).not.toMatch(/localhost|127\.0\.0\.1|\.local\b|workers\.dev/);
  }
}

test("production wrangler CORS_ORIGINS is https-only on the alxnko zones", () => {
  const cfg = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assertProdOrigins(cfg.vars.CORS_ORIGINS);
  expect(cfg.vars.ALLOW_LOCALHOST_CORS).toBeUndefined();
});

test("fallback DEFAULT_ORIGINS is https-only on the alxnko zones", () => {
  assertProdOrigins(DEFAULT_ORIGINS);
});
