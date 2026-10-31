import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Owner decision D7: Cloudflare Web Analytics. The zone injects beacon.min.js; the CSP allows exactly that path
// (script) and the RUM collector (connect), and nothing else from Cloudflare Insights.
const csp = (): string => {
  const line = readFileSync(join(__dirname, "../../public/_headers"), "utf8").split("\n").find((l) => l.includes("Content-Security-Policy:"));
  return line ?? "";
};
const directive = (name: string): string => (csp().split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) ?? "");

describe("_headers CSP allows the Cloudflare Web Analytics beacon, narrowly", () => {
  it("script-src allows only the beacon path", () => {
    expect(directive("script-src").split(" ")).toContain("https://static.cloudflareinsights.com/beacon.min.js/");
    expect(directive("script-src").split(" ")).not.toContain("https://static.cloudflareinsights.com");
  });
  it("connect-src allows the RUM collector origin", () => {
    expect(directive("connect-src").split(" ")).toContain("https://cloudflareinsights.com");
  });
  it("keeps frame-ancestors 'none'", () => {
    expect(csp()).toContain("frame-ancestors 'none'");
  });
});
