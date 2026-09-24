// Strict CSP for a static site: every inline <script>/<style> the build emitted, hashed (spec §9, B26).
// Pure functions; scripts/postbuild.ts does the file I/O.
import { createHash } from "node:crypto";

export const MAX_HEADER = 2000; // Cloudflare Pages: max characters per _headers header value

export const sha256 = (s: string): string =>
  `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

const EXECUTABLE = new Set(["module", "text/javascript", "application/javascript"]);

/** Inline script bodies (no src=, an executable type) and style bodies, exactly as the browser hashes them. */
export function inlineBlocks(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? "", body = m[2] ?? "";
    if (/\ssrc\s*=/i.test(attrs) || body === "") continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !EXECUTABLE.has(type)) continue; // data blocks (JSON-LD) never run, so CSP never checks them
    scripts.push(body);
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) styles.push(m[1] ?? "");
  return { scripts, styles };
}

/** `style="…"` attributes: hashes can't allow them, so the build must emit none. */
export function styleAttrs(html: string): number {
  return (html.match(/<[a-z][^>]*\sstyle\s*=/gi) ?? []).length;
}

/** data: URLs in src/href attributes or CSS url(): img-src/font-src 'self' blocks them. */
export function dataUrls(src: string): string[] {
  return src.match(/(?:src|href)\s*=\s*["']data:[^"']*|url\(\s*["']?data:[^)]*/gi) ?? [];
}

export const TRUSTED_TYPES = ["require-trusted-types-for 'script'", "trusted-types 'none'"] as const;

type ProbeLike = { status?: { kind?: string; url?: string } };

/** connect-src origins: exactly the services the pages probe (content/projects/*.json). */
export function probeOrigins(projects: ProbeLike[]): string[] {
  const set = new Set<string>();
  for (const p of projects) if (p.status?.kind === "probe" && p.status.url) set.add(new URL(p.status.url).origin);
  return [...set].sort();
}

/** One policy for every page (the 404 included): the union of all inline hashes. */
export function buildCsp(docs: string[], connect: string[] = []): string {
  const scripts = new Set<string>(), styles = new Set<string>();
  for (const d of docs) {
    const b = inlineBlocks(d);
    b.scripts.forEach((x) => scripts.add(sha256(x)));
    b.styles.forEach((x) => styles.add(sha256(x)));
  }
  const list = (xs: Iterable<string>) => [...xs].sort().map((x) => ` ${x}`).join("");
  return [
    "default-src 'none'",
    `script-src 'self'${list(scripts)}`,
    `style-src 'self'${list(styles)}`,
    "img-src 'self'",
    "font-src 'self'",
    `connect-src 'self'${list(connect)}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    ...TRUSTED_TYPES,
  ].join("; ");
}
