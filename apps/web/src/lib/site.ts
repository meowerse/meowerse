import tokens from "@meowerse/ui/tokens.json";

export const SITE = {
  url: "https://meow.alxnko.dev/",
  name: "meowerse",
  description: "Small, fast web apps by alxnko: one account, a messenger, and the design system they share.",
  legal: "meowerse — a personal project by alxnko. no ads, no analytics, no trackers.",
  source: "https://github.com/meowerse/meowerse",
  themeColor: { dark: tokens.semantic.dark.bg, light: tokens.semantic.light.bg },
} as const;

export type NavLink = { label: string; href: string; match: string };
// C3 (pre-flight ruling): /ui/ doesn't exist as a page until T7 builds it, so its NAV entry is added
// there, not here. The link checker stays strict, so no link to a page that doesn't exist yet ships.
export const NAV: readonly NavLink[] = [
  { label: "projects", href: "/#projects", match: "/p/" },
];

// C3: same reasoning — "ui docs" (/ui/) and "playground" (/ui/playground/) are added by T7 and T10.
export const FOOTER_LINKS = [
  { label: "projects", href: "/#projects" },
];

export const isCurrent = (pathname: string, match: string): boolean => pathname.startsWith(match);

/** Another origin (mailto: is not "external": it never gets a target). */
export function isExternal(href: string): boolean {
  if (href.startsWith("mailto:")) return false;
  return new URL(href, SITE.url).origin !== new URL(SITE.url).origin;
}

/** External links open in a new tab without leaking the opener or the referrer. */
export function linkAttrs(href: string): { target?: "_blank"; rel?: string } {
  return isExternal(href) ? { target: "_blank", rel: "noopener noreferrer" } : {};
}
