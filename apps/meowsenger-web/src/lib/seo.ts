// The ONE list of which meowsenger.alxnko.dev pages search engines may index. It drives the sitemap
// (scripts/postbuild.ts), the canonical / noindex / description tags (layouts/Layout.astro) and the
// build guard that fails when a built page isn't classified here. Build-time only: imported from
// Astro frontmatter and the postbuild script, never from island code.
//
// There are no anonymously viewable chats: every chat API needs a session and /join sends signed-out
// visitors to sign in, so only the static pages below are listed — nothing dynamic.
import type { SeoPages } from "@meowerse/ui/seo";

export const SITE = "https://meowsenger.alxnko.dev";

export const PAGES = {
  public: {
    "/about/": "Meowsenger is real-time chat for the meowerse: direct messages, groups and channels, signed in with your meowerse account.",
    "/privacy/": "The meowsenger privacy policy: exactly what the service does with your data.",
    "/terms/": "The meowsenger terms of use.",
  },
  // The app shell: signed-out visitors are sent to sign in, so it stays out of the sitemap, but it
  // is the home page, so it keeps a canonical and isn't noindexed.
  unlisted: {
    "/": "Meowsenger: real-time chat for the meowerse — direct messages, groups and channels.",
  },
  private: ["/app/", "/join/", "/404"],
} as const satisfies SeoPages;
