import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_KINDS, CONTACTS, PARTNERS, POLICY_VERSION, SCOPES } from "./legal";

const page = (f: string) => readFileSync(join(__dirname, "../pages", f), "utf8");
const privacy = page("privacy.astro");
const terms = page("terms.astro");
const rendered = privacy + JSON.stringify(PARTNERS) + JSON.stringify(APP_KINDS) + JSON.stringify(SCOPES);
const table = readFileSync(join(__dirname, "../components/LegalTable.astro"), "utf8");
const tokens = readFileSync(join(__dirname, "../../../../packages/ui/src/styles/tokens.gen.css"), "utf8");
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
    for (const n of ["Cloudflare", "Cloudflare Turnstile", "Turso", "Telegram", "push service", "Hetzner", "Mojang / MineSkin", "bStats", "Cloudflare Email Routing", "Google (Gmail)", "Us ("]) {
      expect(names.some((x) => x.includes(n)), n).toBe(true);
    }
    for (const p of PARTNERS) for (const f of [p.partner, p.why, p.gets, p.when]) expect(f.length).toBeGreaterThan(0);
    expect(rendered).not.toMatch(/Google Analytics|Cloudflare Web Analytics/i);
  });
  it("carries the version, the retention rules and the deletion text with its KEEP IN SYNC marker", () => {
    expect(POLICY_VERSION).toBe("v1, 2026-10-30");
    expect(privacy).toContain("365 days");
    expect(privacy).toContain("30 days after they expire");
    expect(privacy).toContain("KEEP IN SYNC");
    expect(privacy).toContain("ACCOUNT_DELETE_ENABLED");
    expect(privacy).toContain("Nothing is deleted from an email");
    expect(privacy).toMatch(/16 is the minimum age/);
    expect(privacy).toMatch(/do not verify age/);
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
  it("collapses tables into stacked cards under 600px and keeps table semantics with explicit roles", () => {
    expect(table).toMatch(/@media \(max-width: 599px\)/);
    expect(table).toContain("data-label");
    for (const r of ['role="table"', 'role="row"', 'role="rowheader"', 'role="cell"', 'role="columnheader"']) expect(table, r).toContain(r);
  });
  it("keeps the muted joke text readable (>= 4.5:1) in every theme", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };
    const fg = [...tokens.matchAll(/--c-fg-muted:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]!);
    const bg = [...tokens.matchAll(/--c-surface:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]!);
    expect(fg.length).toBeGreaterThan(1);
    expect(fg.length).toBe(bg.length);
    fg.forEach((f, i) => expect(ratio(f, bg[i]!), `${f} on ${bg[i]}`).toBeGreaterThanOrEqual(4.5));
  });
  it("has no scripts", () => {
    expect(privacy).not.toContain("<script");
    expect(terms).not.toContain("<script");
  });
});

describe("shared privacy page: recipients, retention and honest state", () => {
  it("separates infrastructure, first-party apps and third-party apps, with scopes and what they release", () => {
    expect(APP_KINDS.map((k) => k.kind).join("|")).toMatch(/Infrastructure.*First-party.*Third-party/);
    const fp = APP_KINDS.find((k) => k.kind.startsWith("First-party"))!;
    expect(fp.who).toContain("Meowsenger");
    expect(fp.consent).toContain("silently");
    const tp = APP_KINDS.find((k) => k.kind.startsWith("Third-party"))!;
    expect(tp.consent).toContain("consent screen");
    expect(tp.who).toContain("our approval");
    expect(tp.control).toContain("revoke on your account page");
    expect(tp.control).toContain("independent controllers");
    expect(SCOPES.map((r) => r.scope)).toEqual(["openid", "profile", "telegram", "verified", "offline_access"]);
    const all = JSON.stringify(SCOPES);
    for (const w of ["username", "display name", "Telegram ID", "Telegram username", "verified"]) expect(all, w).toContain(w);
  });
  it("says Meowsenger is not end-to-end encrypted and what the server does with messages", () => {
    expect(privacy).toContain("Not end-to-end encrypted");
    for (const w of ["in-chat search", "join a chat later", "previews"]) expect(privacy, w).toContain(w);
  });
  it("states the real Meowsenger deletion and retention behaviour", () => {
    expect(privacy).toContain("within 24 hours");
    expect(privacy).toContain("about 24 hours later");
    expect(privacy).toContain("stored message log is not wiped today");
    expect(privacy).toContain("ownership passes to another member");
    expect(privacy).not.toContain("solely own");
    expect(privacy).toContain("Reactions");
    expect(privacy).toContain("140 characters");
    expect(privacy).toContain("last connected");
    expect(privacy).toContain("add you to groups");
  });
  it("states backups, rate-limit retention and corrected auth retention", () => {
    expect(privacy).toContain("Time Travel");
    expect(privacy).toContain("7 days");
    expect(privacy).toContain("our database provider's backup window");
    expect(privacy).toContain("offline copies");
    expect(privacy).toContain("unsalted SHA-256");
    expect(privacy).toContain("pseudonymous, not anonymous");
    expect(privacy).toContain("deleted after 7 days without activity");
    expect(privacy).toContain("about 60 days");
    expect(privacy).toContain("so up to about 31 days after you signed in");
    expect(privacy).toContain("last 60 seconds");
  });
  it("discloses the Minecraft facts and home hosting, and not a blanket Cloudflare claim", () => {
    for (const w of ["log-ips=true", "online-mode=false", "bcrypt", "registered from", "Simple Voice Chat", "operator's home"]) expect(privacy, w).toContain(w);
    expect(JSON.stringify(PARTNERS)).not.toContain("runs all our websites and servers");
    expect(JSON.stringify(PARTNERS)).toContain("NOT behind Cloudflare");
    const bstats = PARTNERS.find((p) => p.partner.startsWith("bStats"))!;
    expect(bstats.gets).toContain("not your name or IP");
  });
  it("discloses Turnstile IP, Telegram directions, the public avatar address and the Turso region", () => {
    const get = (n: string) => PARTNERS.find((p) => p.partner.includes(n))!;
    expect(get("Turnstile").gets).toContain("IP address");
    expect(get("Turnstile").why).toContain("script");
    expect(get("Telegram").gets).toContain("RECEIVE");
    expect(get("Telegram").gets).toContain("anyone who has your account ID");
    expect(get("Turso").why).toContain("eu-west-1");
    expect(get("Turso").gets).toContain("audit log");
  });
  it("says role addresses only receive mail and does not promise replies from them", () => {
    expect(privacy).toContain("only receive mail");
    expect(privacy).toContain("may come from a different address");
    expect(privacy).not.toMatch(/we will reply|reply from privacy@/i);
  });
  it("keeps the terms' age wording honest", () => {
    expect(terms).toContain("We do not check your age today");
  });
});

describe("shared terms page copy", () => {
  it("has a shared section plus a section per service", () => {
    for (const s of ["accounts", "acceptable use", "no warranty", "changes and contact", "Meowsenger", "meow-sim", "Minecraft server"]) expect(terms, s).toContain(s);
    expect(terms).toContain("not end-to-end encrypted");
  });
});
