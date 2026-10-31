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
  it("has every live partner row, including cookieless Cloudflare Web Analytics, and no Google Analytics", () => {
    const names = PARTNERS.map((p) => p.partner);
    for (const n of ["Cloudflare", "Cloudflare Web Analytics", "Cloudflare Turnstile", "Turso", "Telegram", "push service", "Hetzner", "Mojang / MineSkin", "bStats", "FastStats", "synkdev.cc", "Cloudflare Email Routing", "Google (Gmail)", "Us ("]) {
      expect(names.some((x) => x.includes(n)), n).toBe(true);
    }
    for (const p of PARTNERS) for (const f of [p.partner, p.why, p.gets, p.when]) expect(f.length).toBeGreaterThan(0);
    const i = names.indexOf("Cloudflare");
    expect(names[i + 1]).toBe("Cloudflare Web Analytics");
    expect(PARTNERS[i + 1]?.gets).toMatch(/No cookies and no cross-site identifier/);
    expect(rendered).toMatch(/Cloudflare Web Analytics/);
    expect(rendered).not.toMatch(/Google Analytics/i);
  });
  it("carries the version, the retention rules and the deletion text with its KEEP IN SYNC marker", () => {
    expect(POLICY_VERSION).toBe("v3, 2026-10-31");
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
    expect(privacy).toContain("Our websites use Cloudflare Web Analytics");
    expect(privacy).toContain("No other analytics or tracking scripts run on our websites today");
    expect(privacy).toContain("bStats and FastStats; see the Minecraft section");
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
    expect(APP_KINDS.map((k) => k.kind).join("|")).toMatch(/Infrastructure.*First-party.*Our own apps.*Third-party/);
    const fp = APP_KINDS.find((k) => k.kind.startsWith("First-party"))!;
    expect(fp.who).toContain("none today");
    expect(fp.consent).toContain("silently");
    const ours = APP_KINDS.find((k) => k.kind === "Our own apps")!;
    expect(ours.who).toContain("Meowsenger");
    expect(ours.consent).toContain("consent screen");
    // workers/meowsenger/src/oidc.ts:8 SCOPES = "openid profile verified"; refresh tokens need offline_access (auth index.ts:594).
    expect(ours.gets).toContain("openid, profile and verified only");
    expect(ours.gets).not.toMatch(/stay signed in/);
    const tp = APP_KINDS.find((k) => k.kind.startsWith("Third-party"))!;
    expect(tp.consent).toContain("consent screen");
    // workers/auth/src/index.ts:883 -> dashboard.ts:68 registers apps as status 'active'; clients.ts:23 only checks 'active'.
    expect(tp.who).toContain("Anyone with a meowerse account can register an app");
    expect(tp.who).toContain("we do not review apps");
    expect(tp.consent).toContain("Only approve apps you trust");
    expect(JSON.stringify(APP_KINDS)).not.toMatch(/\bour approval|if we approve/i);
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
  it("pins the corrected Meowsenger chat/reaction facts", () => {
    // chats.ts:66 both direct members are 'member'; members.ts:145 non-owner leave returns early.
    expect(privacy).toContain("Direct chats are never deleted");
    expect(privacy).not.toContain("When the last member leaves, the chat disappears");
    // conversation.ts:742 purges orphan reactions after the message row is hard-deleted.
    expect(privacy).toContain("Reactions on a deleted message are purged along with the message row");
    expect(privacy).not.toContain("Reactions and the record of who created a chat are not removed");
  });
  it("states the verified backup windows", () => {
    // developers.cloudflare.com/durable-objects/api/sqlite-storage-api/: PITR "past 30 days"; turso.tech/pricing: Free "1 day".
    expect(privacy).toContain("up to 30 days");
    expect(privacy).toContain("SQLite-backed Cloudflare Durable Objects");
    expect(privacy).toContain("We are on Turso's free plan, whose restore window is 1 day");
    expect(privacy).not.toContain("our database provider's backup window");
  });
  it("describes Minecraft plugin reporting and logs without Minekube", () => {
    // No Minekube jar is installed (plugins/connect/config.yml is a leftover).
    expect(rendered + terms).not.toMatch(/minekube/i);
    const fs = PARTNERS.find((p) => p.partner.startsWith("FastStats"))!;
    expect(fs.partner).toContain("NexusCore");
    expect(fs.why).toContain("submitErrors=false");
    expect(fs.gets).toContain("not their names");
    expect(fs.gets).toContain("IP address (from the connection itself)");
    expect(fs.gets).not.toContain("error reports");
    expect(PARTNERS.find((p) => p.partner.startsWith("synkdev.cc"))!.gets).toContain("no player data");
    expect(PARTNERS.find((p) => p.partner.startsWith("bStats"))!.why).toContain("built into most of the server's plugins");
    expect(privacy).toContain("kept for 30 days and then deleted automatically");
    expect(privacy).toContain("does not remember a login by IP address");
    expect(privacy).toContain("chat and commands");
    expect(privacy).toContain("voice-chat group (any distance)");
    expect(privacy).toContain("kept in the operator's Gmail mailbox, with no automatic deletion today");
  });
  it("states rate-limit cleanup and the step-up counter", () => {
    expect(privacy).toContain("daily cleanup after about 7 days without activity (up to about 8)");
    expect(privacy).toContain("step-up) counter is not removed when an account is deleted");
  });
  it("scopes the table CSS under .mw-prose and keeps the label out of the screen-reader text", () => {
    expect(table).toContain('content: attr(data-label) ": " / ""');
    const css = table.split("<style")[1]!;
    for (const line of css.split("\n").filter((l) => /^\s*\.(?!mw-prose)legal-table/.test(l))) expect(line).toBe("");
    expect(css).toContain(".mw-prose .legal-table th, .mw-prose .legal-table td { white-space: normal;");
  });
  it("states backups, rate-limit retention and corrected auth retention", () => {
    expect(privacy).toContain("Time Travel");
    expect(privacy).toContain("7 days");
    expect(privacy).toContain("offline copies");
    expect(privacy).toContain("unsalted SHA-256");
    expect(privacy).toContain("pseudonymous, not anonymous");
    expect(privacy).toContain("after about 7 days without activity");
    expect(privacy).toContain("about 60 days");
    expect(privacy).toContain("so up to about 31 days after you signed in");
    expect(privacy).toContain("last 60 seconds");
  });
  it("discloses the Minecraft facts and self-managed hosting, and not a blanket Cloudflare claim", () => {
    for (const w of ["log-ips=true", "online-mode=false", "bcrypt", "registered from", "Simple Voice Chat", "manages directly"]) expect(privacy, w).toContain(w);
    expect(privacy).not.toContain("operator's home");
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

// These read the code the copy describes, so a change there fails here instead of leaving the page wrong.
describe("privacy copy stays anchored to the code it describes", () => {
  const repo = (f: string) => readFileSync(join(__dirname, "../../../..", f), "utf8");
  it("Meowsenger asks for exactly openid, profile and verified (no offline access)", () => {
    expect(repo("workers/meowsenger/src/oidc.ts")).toMatch(/const SCOPES = "openid profile verified";/);
  });
  it("registered apps are active immediately (no review), as the third-party row says", () => {
    // createClient's INSERT lists "first_party, status" last and binds them to the literals 0, 'active'.
    expect(repo("workers/auth/src/dashboard.ts")).toMatch(/first_party, status",\s*\n\s*"[^"]*0, 'active'"/);
    expect(privacy).not.toContain("built into many plugins");
    expect(APP_KINDS.find((k) => k.kind.startsWith("Third-party"))!.who).toMatch(/do not review/);
  });
  it("rate-limit retention is 7 days in housekeeping, matching the page", () => {
    const hk = repo("workers/auth/src/housekeeping.ts");
    expect(hk).toContain("export const RATE_LIMIT_RETENTION = 7 * 86400;");
    expect(hk).toContain('"COALESCE(last_at, window_start) < ?"');
  });
  it("every .legal-table selector is scoped under .mw-prose, with a label fallback for old browsers", () => {
    const css = table.split("<style")[1]!.split(">").slice(1).join(">").split("</style")[0]!;
    for (const sel of css.match(/[^{}]+(?=\{)/g)!.flatMap((s) => s.split(",")).filter((s) => s.includes(".legal-table"))) {
      expect(sel.trim(), sel).toMatch(/^(@media[^]*\s)?\.mw-prose \.legal-table/);
    }
    expect(table).toContain('content: attr(data-label) ": "; content: attr(data-label) ": " / ""');
  });
});

describe("brand spelling", () => {
  it("says meowerse, never meowverse (owner, 2026-10-31)", () => {
    for (const f of ["src/pages/privacy.astro", "src/pages/terms.astro", "src/lib/seo.ts", "src/lib/legal.ts"]) {
      expect(readFileSync(join(__dirname, "../..", f), "utf8"), f).not.toMatch(/meowverse/i);
    }
  });
});
