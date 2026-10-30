// Copy that tests assert on, shared by /privacy and /terms. Keep every claim true of the running system:
// each row names the code/config it was checked against in the PR that wrote it.
export const POLICY_VERSION = "v1, 2026-10-31";

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
  { partner: "Cloudflare", why: "runs all our websites and servers (Pages, Workers, D1, Durable Objects)", gets: "every request: IP address, browser info, the page or API you asked for", when: "always (hosting)" },
  { partner: "Cloudflare Turnstile", why: "stops bots at sign-up and sign-in", gets: "a browser check", when: "when you sign up or sign in" },
  { partner: "Turso", why: "stores accounts", gets: "your account: username, display name, avatar link, password hash, recovery-code hashes, Telegram link, sessions, app consents", when: "if you have an account" },
  { partner: "Telegram", why: "optional sign-in", gets: "your Telegram ID, username, name and avatar link", when: "only if you use Telegram sign-in or link Telegram" },
  { partner: "Your browser's push service (Google, Mozilla or Apple, depending on your browser)", why: "delivers Meowsenger notifications", gets: "a wake-up ping with no message content, plus your device's push address", when: "only if you turn on notifications" },
  { partner: "Hetzner", why: "runs the meow-sim server", gets: "your connection (IP address) while you watch the sim", when: "when you open sim" },
  { partner: "Mojang / MineSkin (via SkinsRestorer)", why: "Minecraft skins", gets: "your Minecraft username, to fetch its skin", when: "when you join the Minecraft server" },
  { partner: "Cloudflare Email Routing", why: "receives and forwards messages sent to our role addresses", gets: "the messages you send to privacy@, security@ or contact@alxnko.dev (sender address, subject, content)", when: "only if you email us" },
  { partner: "Google (Gmail)", why: "stores the forwarded messages in the owner's mailbox", gets: "the same forwarded messages", when: "only if you email us" },
  { partner: "Us (alxnko.dev, meow, auth, Meowsenger, sim, Minecraft)", why: "the services themselves", gets: "what each service needs; see \"what each service keeps\"", when: "when you use them" },
];
