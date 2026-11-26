import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_ORIGINS } from "../src/security";

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

// Strip // and /* */ comments outside strings, then trailing commas, so the shipped jsonc can be parsed.
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

test("the shipped wrangler config enables account self-deletion (privacy/terms v4 describe it as live)", () => {
  const cfg = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  // index.ts accountDeleteEnabled() accepts exactly "1" or "true"; a drift here would silently turn deletion off in production.
  expect(["1", "true"]).toContain(cfg.vars.ACCOUNT_DELETE_ENABLED);
});

test("production vars never trust localhost or enable dev mode", () => {
  const cfg = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assertProdOrigins(cfg.vars.CORS_ORIGINS);
  assertProdOrigins(DEFAULT_ORIGINS);
  expect(cfg.vars.AUTH_DEV).toBeUndefined();
});
