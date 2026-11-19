// Speculation Rules (Chromium): same-origin navigations are prerendered/prefetched on hover, so the click
// lands on an already-loaded page. Delivered by the `Speculation-Rules` response header pointing at a
// same-origin JSON file (scripts/postbuild.ts writes it), NOT an inline <script type="speculationrules">:
// that would need the CSP's `inline-speculation-rules` token. No script, no CSP change. Other browsers
// ignore the header.
export const SPECULATION_PATH = "/speculation-rules.json";
export const SPECULATION_CONTENT_TYPE = "application/speculationrules+json";

/** href_matches patterns are URLPattern pathnames resolved against the page's own origin: "/*" can
 *  only ever match same-origin URLs, so nothing cross-origin (auth.alxnko.dev…) is speculated. */
export const SAME_ORIGIN = "/*";

/** Heavy WebGL/demo pages: prefetch only, a prerender would build a GPU context nobody may visit. */
export const HEAVY_PATHS = ["/ui/cat3d*", "/ui/playground*"];

/** Never speculated, whatever the tier: state-changing/session paths and non-HTML assets. */
export const NEVER_PATHS = [
  "/logout*", "/signout*", "/sign-out*", "/log-out*", "/api/*", "/auth/*", "/cdn-cgi/*",
  "/*.(xml|txt|ico|svg|png|webp|jpg|jpeg|gif|json|webmanifest|woff2|css|js|bin)",
];

/** Links that are not plain same-tab navigations. */
export const NEVER_SELECTORS = ["[rel~=nofollow]", "[target=_blank]", "[download]"];

const where = (extraNot: string[] = []) => ({
  and: [
    { href_matches: SAME_ORIGIN },
    { not: { href_matches: [...NEVER_PATHS, ...extraNot] } },
    { not: { selector_matches: NEVER_SELECTORS } },
  ],
});

export const SPECULATION_RULES = {
  prerender: [{ source: "document", eagerness: "moderate", where: where(HEAVY_PATHS) }],
  // Fallback tier (the browser may refuse a prerender: memory, Save-Data) and the only tier for heavy pages.
  prefetch: [{ source: "document", eagerness: "moderate", where: where() }],
} as const;

export const speculationJson = (): string => `${JSON.stringify(SPECULATION_RULES, null, 2)}\n`;
