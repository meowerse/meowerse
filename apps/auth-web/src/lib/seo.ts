// The ONE list of which auth.alxnko.dev pages search engines may index. It drives the sitemap
// (scripts/postbuild.ts), the canonical / noindex / description tags (layouts/Layout.astro) and the
// build guard that fails when a built page isn't classified here. Build-time only: imported from
// Astro frontmatter and the postbuild script, never from island code.
//
// The landing page is the search entry; the sign-in / sign-up / consent flows and everything
// session-bearing are noindex (they're reached from the landing page or from an app, never from search).
import type { SeoPages } from "@meowerse/ui/seo";

export const SITE = "https://auth.alxnko.dev";

export const PAGES = {
  public: {
    "/": "One meowerse account for every meowerse app: sign in with a username or Telegram and choose what each app may see.",
    "/about/": "What meowerse accounts is: single sign-on for the meowerse apps, with optional Telegram verification and per-app consent.",
    "/docs/": "Connect an app to meowerse accounts: a standard OpenID Connect provider with PKCE, ES256-signed tokens and an SDK.",
    "/privacy/": "The meowerse accounts privacy policy: exactly what the service does with your data.",
    "/terms/": "The meowerse accounts terms of use.",
  },
  private: ["/login/", "/signup/", "/consent/", "/verify/", "/error/", "/account/", "/developers/", "/dashboard/", "/404"],
} as const satisfies SeoPages;
