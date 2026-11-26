// The ONE list of which meowsenger.alxnko.dev pages search engines may index. It drives the sitemap
// (scripts/postbuild.ts), the canonical / noindex / description tags (layouts/Layout.astro) and the
// build guard that fails when a built page isn't classified here. Build-time only: imported from
// Astro frontmatter and the postbuild script, never from island code.
//
// There are no anonymously viewable chats: every chat API needs a session and /join sends signed-out
// visitors to sign in, so only the static pages below are listed — nothing dynamic. "/" is the public
// landing page; the app shell lives at /app/ (private).
import type { SeoPages } from "@meowerse/ui/seo";

export const SITE = "https://meowsenger.alxnko.dev";

export const PAGES = {
  public: {
    "/": "Meowsenger: real-time chat for the meowerse — direct messages, groups and channels, signed in with your meowerse account.",
    "/about/": "Meowsenger is real-time chat for the meowerse: direct messages, groups and channels, signed in with your meowerse account.",
    "/privacy/": "What Meowsenger keeps about you and your chats, how deletion works today, and a link to the full meowerse privacy policy.",
    "/terms/": "Meowsenger terms of use in short, with a link to the full meowerse terms.",
  },
  unlisted: {},
  private: ["/app/", "/join/", "/404"],
} as const satisfies SeoPages;
