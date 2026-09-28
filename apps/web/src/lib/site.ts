import tokens from "@meowerse/ui/tokens.json";
import navData from "./nav.json";
import { isCurrent } from "./nav-match";

export const SITE = {
  url: "https://meow.alxnko.dev/",
  name: "meowerse",
  description: "Small, fast web apps by alxnko: one account, a messenger, and the design system they share.",
  legal: "meowerse — a personal project by alxnko. no ads, no analytics, no trackers.",
  source: "https://github.com/meowerse/meowerse",
  themeColor: { dark: tokens.semantic.dark.bg, light: tokens.semantic.light.bg },
} as const;

export type NavLink = { label: string; href: string; match: string };
// C3 (pre-flight ruling): /ui/ is added to NAV now that T7 has built the page (it was withheld until
// then so the strict link checker never had to point at a page that didn't exist yet).
// NAV's data lives in ./nav.json (plain {label, href, match} entries, no imports) so
// tests/e2e/shell.spec.ts can read it with JSON.parse and assert aria-current against the exact
// same entries this exports — not a hand-maintained copy that could silently drift.
export const NAV: readonly NavLink[] = navData as readonly NavLink[];

// C3: "playground" (/ui/playground/) was added by T10, once that page existed.
export const FOOTER_LINKS = [
  { label: "projects", href: "/#projects" },
  { label: "ui docs", href: "/ui/" },
  { label: "playground", href: "/ui/playground/" },
];

export { isCurrent };

/** Another origin (mailto: is not "external": it never gets a target). */
export function isExternal(href: string): boolean {
  if (href.startsWith("mailto:")) return false;
  return new URL(href, SITE.url).origin !== new URL(SITE.url).origin;
}

/** External links open in a new tab without leaking the opener or the referrer. */
export function linkAttrs(href: string): { target?: "_blank"; rel?: string } {
  return isExternal(href) ? { target: "_blank", rel: "noopener noreferrer" } : {};
}
