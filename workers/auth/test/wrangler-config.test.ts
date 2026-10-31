import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

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
