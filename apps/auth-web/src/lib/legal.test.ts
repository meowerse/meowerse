import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTACTS, PARTNERS, POLICY_VERSION } from "./legal";

const page = (f: string) => readFileSync(join(__dirname, "../pages", f), "utf8");
const privacy = page("privacy.astro");
const terms = page("terms.astro");
const rendered = privacy + JSON.stringify(PARTNERS);
const legalSrc = readFileSync(join(__dirname, "legal.ts"), "utf8");

describe("shared privacy page copy", () => {
  it("shows the joke exactly once, with the punchline and the real list straight after", () => {
    expect(privacy.match(/1,000,000 trusted partners/g)).toHaveLength(1);
    expect(privacy.match(/Just kidding\. We can barely afford our servers\./g)).toHaveLength(1);
    expect(privacy.match(/We highly value your privacy 💚/g)).toHaveLength(1);
    const i = privacy.indexOf("1,000,000 trusted partners");
    expect(privacy.indexOf("Just kidding", i)).toBeGreaterThan(i);
    expect(privacy.indexOf("Here is the real list of who gets what, and why.", i)).toBeGreaterThan(privacy.indexOf("Just kidding"));
    expect(privacy).toContain('class="joke"');
    expect(terms).not.toContain("1,000,000");
  });
  it("states no numeric recipient count outside the joke", () => {
    const noJoke = rendered.replace(/1,000,000 trusted partners/, "");
    expect(noJoke).not.toMatch(/\b\d[\d,]*\+?\s+(trusted\s+)?(partners|recipients|third parties)/i);
  });
  it("has every live partner row and no analytics rows yet", () => {
    const names = PARTNERS.map((p) => p.partner);
    for (const n of ["Cloudflare", "Cloudflare Turnstile", "Turso", "Telegram", "push service", "Hetzner", "Mojang / MineSkin", "Cloudflare Email Routing", "Google (Gmail)", "Us ("]) {
      expect(names.some((x) => x.includes(n)), n).toBe(true);
    }
    for (const p of PARTNERS) for (const f of [p.partner, p.why, p.gets, p.when]) expect(f.length).toBeGreaterThan(0);
    expect(rendered).not.toMatch(/Google Analytics|Cloudflare Web Analytics/i);
  });
  it("carries the version, the retention rules and the deletion text with its KEEP IN SYNC marker", () => {
    expect(POLICY_VERSION).toBe("v1, 2026-10-31");
    expect(privacy).toContain("365 days");
    expect(privacy).toContain("30 days after they expire");
    expect(privacy).toContain("KEEP IN SYNC");
    expect(privacy).toContain("ACCOUNT_DELETE_ENABLED");
    expect(privacy).toContain("Nothing is deleted from an email");
    expect(privacy).toMatch(/at least 16/);
    expect(privacy).toMatch(/supervisory authority/);
  });
  it("lists the role addresses and no personal email address", () => {
    expect(CONTACTS).toEqual({ privacy: "privacy@alxnko.dev", security: "security@alxnko.dev", general: "contact@alxnko.dev" });
    for (const k of ["privacy", "security", "general"] as const) expect(privacy, k).toContain(`CONTACTS.${k}`);
    expect(terms).toContain("CONTACTS.general");
    const roles: string[] = Object.values(CONTACTS);
    for (const src of [privacy, terms, legalSrc]) {
      for (const m of src.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []) expect(roles, `unexpected address ${m}`).toContain(m);
    }
    expect(privacy + terms + legalSrc).not.toMatch(/gmail\.com|@gmail|@proton|@icloud/i);
  });
  it("states analytics as today's state, with placeholders for the next release, not a permanent promise", () => {
    expect(privacy).toContain("Today we run no analytics");
    expect(privacy).not.toMatch(/never (use|run|load) analytics|no third-party trackers\./i);
    expect(privacy).toContain("TODAY-ONLY");
    expect(legalSrc).toContain("NEXT RELEASE");
  });
  it("collapses the partner table into stacked cards under 600px", () => {
    expect(privacy).toMatch(/@media \(max-width: 599px\)/);
    expect(privacy).toContain("data-label");
  });
  it("has no scripts", () => {
    expect(privacy).not.toContain("<script");
    expect(terms).not.toContain("<script");
  });
});

describe("shared terms page copy", () => {
  it("has a shared section plus a section per service", () => {
    for (const s of ["accounts", "acceptable use", "no warranty", "changes and contact", "Meowsenger", "meow-sim", "Minecraft server"]) expect(terms, s).toContain(s);
    expect(terms).toContain("not end-to-end encrypted");
  });
});
