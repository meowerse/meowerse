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
    // groups/channels only: direct members are both 'member' (chats.ts:66) and non-owner leave returns early (members.ts:145).
    expect(p).toContain("last member leaves a group or channel");
    expect(p).toContain("Direct chats are never deleted");
    expect(p).not.toContain("when the last member leaves a chat its stored");
    expect(p).toContain("passes to its oldest admin, or else its oldest member"); // members.ts leave()
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
