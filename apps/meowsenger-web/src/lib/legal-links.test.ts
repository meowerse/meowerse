import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = (f: string) => readFileSync(join(__dirname, "../pages", f), "utf8");

describe("meowsenger /privacy and /terms point at the shared pages", () => {
  it("privacy summarizes and links to the shared policy and terms", () => {
    const p = page("privacy.astro");
    expect(p).toContain('href="https://auth.alxnko.dev/privacy"');
    expect(p).toContain('href="https://auth.alxnko.dev/terms"');
    expect(p).toContain("Not end-to-end encrypted");
    expect(p).not.toContain("1,000,000");
    expect(p).toContain("within 24 hours");
    expect(p).toContain("stored message log is not wiped today");
    expect(p).toContain("passes to another member");
    expect(p).not.toContain("solely own");
    expect(p).toContain("receives mail only");
  });
  it("terms summarizes and links to the shared terms and policy", () => {
    const t = page("terms.astro");
    expect(t).toContain('href="https://auth.alxnko.dev/terms"');
    expect(t).toContain('href="https://auth.alxnko.dev/privacy"');
  });
  it("keeps the local URLs the footer links to", () => {
    const layout = readFileSync(join(__dirname, "../layouts/Layout.astro"), "utf8");
    expect(layout).toContain('href: "/privacy"');
    expect(layout).toContain('href: "/terms"');
  });
});
