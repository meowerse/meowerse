// Copy that tests assert on, shared by /privacy and /terms. Keep every claim true of the running system:
// each row names the code/config it was checked against in the PR that wrote it.
export const POLICY_VERSION = "v1, 2026-10-30";

export const CONTACTS = {
  privacy: "privacy@alxnko.dev",
  security: "security@alxnko.dev",
  general: "contact@alxnko.dev",
} as const;

export interface Partner {
  partner: string;
  why: string;
  gets: string;
  when: string;
}

// Only partners that are LIVE today. Analytics, consent and membership rows are added in the same
// release that turns each feature on (never before).
// NEXT RELEASE: insert "Cloudflare Web Analytics" and "Google Analytics" (consent-gated; Google's data-sharing settings
// may let Google use the data for its own purposes, say so plainly) right after the "Cloudflare" row below, and
// replace the "today" analytics section in privacy.astro.
export const PARTNERS: readonly Partner[] = [
  { partner: "Cloudflare", why: "hosts our websites and web services (Pages, Workers, D1, Durable Objects). The Minecraft server is NOT behind Cloudflare", gets: "every request to those sites: IP address, browser info, the page or API you asked for. Cloudflare keeps short-lived edge request logs", when: "always (hosting)" },
  { partner: "Cloudflare Turnstile", why: "stops bots at sign-up and sign-in; its script loads in your browser from challenges.cloudflare.com", gets: "your IP address (we pass it on to check the result), plus whatever the browser check collects", when: "when you sign up or sign in" },
  { partner: "Turso", why: "stores the meowerse accounts database (region: AWS eu-west-1, Ireland)", gets: "your account: username, display name, avatar link, password hash, recovery-code hashes, Telegram link, sessions, app consents, the security audit log (truncated IP, browser hash) and abuse-counter hashes", when: "if you have an account" },
  { partner: "Telegram", why: "optional sign-in, and our Telegram bot", gets: "we RECEIVE your Telegram ID, username, name and photo from Telegram when you use Telegram login. Telegram receives your use of our bot. Our public /avatar/<account id> address also fetches your current Telegram photo from Telegram on demand and serves it to anyone who has your account ID", when: "only if you use Telegram sign-in or link Telegram" },
  { partner: "Your browser's push service (Google, Mozilla or Apple, depending on your browser)", why: "delivers Meowsenger notifications", gets: "a wake-up ping with no message content, plus your device's push address", when: "only if you turn on notifications" },
  { partner: "Hetzner", why: "runs the meow-sim server", gets: "your connection (IP address) while you watch the sim", when: "when you open sim" },
  { partner: "Mojang / MineSkin (via SkinsRestorer)", why: "Minecraft skins", gets: "your Minecraft username, to fetch its skin", when: "when you join the Minecraft server" },
  { partner: "bStats (bstats.org)", why: "anonymous plugin and server statistics; bStats is built into most of the server's plugins", gets: "statistics about the server and its plugins (a random server ID, versions, counts), not your name or IP", when: "continuously, while the Minecraft server runs" },
  { partner: "FastStats (inside the NexusCore plugin)", why: "plugin usage statistics and error reports; error reporting is switched on in the plugin's settings (submitErrors=true)", gets: "plugin usage data and error reports, which may contain player names", when: "while the Minecraft server runs" },
  { partner: "Cloudflare Email Routing", why: "receives and forwards messages sent to our role addresses", gets: "the messages you send to privacy@, security@ or contact@alxnko.dev (sender address, subject, content)", when: "only if you email us" },
  { partner: "Google (Gmail)", why: "stores the forwarded messages in the owner's mailbox", gets: "the same forwarded messages", when: "only if you email us" },
  { partner: "Us (alxnko.dev, meow, auth, Meowsenger, sim, Minecraft)", why: "the services themselves", gets: "what each service needs; see \"what each service keeps\"", when: "when you use them" },
];

export interface AppKind {
  kind: string;
  who: string;
  consent: string;
  gets: string;
  control: string;
}

// Apps that sign you in with your meowerse account. Checked against workers/auth: consent.ts (first_party =>
// silent; in production no client has first_party=1 as of 2026-10-30, Meowsenger included), userinfo.ts + token.ts (claims), db.ts (first_party is admin-set in the database; the only seeded
// client, mw_demo, is third-party), workers/meowsenger/auth.config.ts (Meowsenger's registration).
export const APP_KINDS: readonly AppKind[] = [
  { kind: "Infrastructure providers", who: "Cloudflare, Turso, Hetzner and the others in the table above", consent: "not apps: they run the service for us", gets: "only what the table above lists", control: "see the table" },
  { kind: "First-party apps (ours)", who: "none today. The service supports marking our own apps first-party (only we can, in the database, never through the public app registration), but no app is marked that way, so Meowsenger and our other apps ask for your approval like any other app", consent: "a first-party app would be authorized silently, with no consent screen; we will update this policy before marking any app first-party", gets: "the scopes the app is registered for", control: "revoke on your account page, or sign out" },
  { kind: "Our own apps", who: "Meowsenger (meowsenger.alxnko.dev), run by us", consent: "you see the consent screen and approve it, like a third-party app", gets: "openid, profile and verified only (it does not ask for offline access, so it gets no refresh token)", control: "revoke on your account page at any time" },
  { kind: "Third-party apps (anyone else)", who: "apps run by other people. Anyone with a meowerse account can register an app, and we do not review apps", consent: "you see a consent screen listing what the app asks for. Only approve apps you trust", gets: "only the scopes you approved", control: "revoke on your account page at any time. These apps are independent controllers: what they do with data after you approve is governed by their own privacy policy, not this one" },
];

export interface ScopeRow {
  scope: string;
  gets: string;
  note: string;
}

export const SCOPES: readonly ScopeRow[] = [
  { scope: "openid", gets: "your stable account ID and when you signed in", note: "always included" },
  { scope: "profile", gets: "your username, display name, and a picture link", note: "the picture is your Telegram photo, only if Telegram is linked" },
  { scope: "telegram", gets: "your Telegram ID and Telegram username", note: "only if Telegram is linked" },
  { scope: "verified", gets: "whether your account is verified (a yes or no)", note: "verified means Telegram is linked" },
  { scope: "offline_access", gets: "the ability to stay signed in without asking you again", note: "refresh tokens: idle 14 days, 30 days at most" },
];
