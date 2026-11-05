// Single source of truth for which auth-web links may carry `data-astro-prefetch`.
// Astro is configured with prefetchAll:false, so ONLY links spread with prefetchAttr() prefetch.
// Allowlist (fail closed): public, prerendered, side-effect-free pages that are also cacheable
// (public/_headers). /developers is deliberately absent: it is served no-store. Everything else
// (login, signup, consent, verify, account, dashboard, error, authorize, logout, /api/*, OIDC,
// cross-origin) is a session, CSRF, Turnstile or OIDC flow and must never be prefetched.
export const PREFETCH_ALLOWED: ReadonlySet<string> = new Set(["/", "/about", "/docs", "/privacy", "/terms"]);

/** Reduce an href to a comparable same-origin path, or null if it is not a plain same-origin path. */
function normalisePath(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
  const path = href.split(/[?#]/, 1)[0] ?? "";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function isPrefetchable(href: string): boolean {
  const path = normalisePath(href);
  return path !== null && PREFETCH_ALLOWED.has(path);
}

/** Spread onto an <a>: {...prefetchAttr(href)}. Empty object when the target is not allowlisted. */
export function prefetchAttr(href: string): { "data-astro-prefetch"?: "hover" } {
  return isPrefetchable(href) ? { "data-astro-prefetch": "hover" } : {};
}
