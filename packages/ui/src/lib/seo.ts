// Search-engine signals for the meowerse static sites, with no React and no DOM: sitemaps, the
// public/private page classification behind canonical + noindex, the postbuild guard that checks the
// built HTML against it, and a `_headers` reader for tests and local serving. Build-time only — it is
// imported by Astro frontmatter (rendered at build) and by scripts/postbuild.ts, never by island code,
// so none of it ships to the browser. Import it as "@meowerse/ui/seo".

/**
 * How a site's pages are classified. Every built page must appear in exactly one list:
 *  - `public`: indexable, in the sitemap, gets a canonical link and this meta description;
 *  - `unlisted`: indexable (canonical + description) but left out of the sitemap — e.g. an app shell
 *    that redirects signed-out visitors;
 *  - `private`: `<meta name="robots" content="noindex">`, no canonical, never in the sitemap.
 * Paths are site paths as Astro's directory output serves them: "/", "/about/", and "/404".
 */
export type SeoPages = {
  public: Readonly<Record<string, string>>;
  unlisted?: Readonly<Record<string, string>>;
  private: readonly string[];
};

/** What one page's <head> must carry. */
export type PageSeo = { index: true; canonical: string; description: string } | { index: false };

// Astro emits these as files ("404.html"), not directories.
const FILE_PAGES = new Set(["/404", "/500"]);

/** A site origin with no trailing slash ("https://auth.alxnko.dev/" → "https://auth.alxnko.dev"). */
export function siteOrigin(site: string): string {
  const u = new URL(site);
  if (u.pathname !== "/" || u.search || u.hash) throw new Error(`site must be a bare origin, got ${site}`);
  return u.origin;
}

/**
 * A request or file path → the site path Astro serves the page at: "/about", "/about/" and
 * "/about/index.html" → "/about/"; "/404.html" and "/404/" → "/404"; "/" → "/".
 */
export function sitePath(pathname: string): string {
  let p = pathname.split("\\").join("/");
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "");
  const bare = p.length > 1 ? p.replace(/\/+$/, "") : p;
  if (FILE_PAGES.has(bare)) return bare;
  return bare.endsWith("/") ? bare : `${bare}/`;
}

/** dist-relative HTML files → site paths ("index.html" → "/", "p/auth/index.html" → "/p/auth/"); no 404. */
export function pagePaths(htmlFiles: string[]): string[] {
  return htmlFiles
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f !== "404.html" && f.endsWith("index.html") && !f.startsWith("_astro/"))
    .map((f) => `/${f.slice(0, -"index.html".length)}`)
    .sort();
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);

/** A sitemaps.org urlset: absolute <loc>s on `site`, directory URLs with a trailing slash, sorted, deduped. */
export function sitemapXml(site: string, paths: string[]): string {
  const base = siteOrigin(site);
  const locs = [...new Set(paths.map((p) => {
    if (!p.startsWith("/")) throw new Error(`sitemap paths must start with "/", got ${p}`);
    return sitePath(p);
  }))].sort();
  const urls = locs.map((p) => `  <url><loc>${xmlEscape(base + p)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** The paths that go in the sitemap: the public ones only. */
export function sitemapPaths(pages: SeoPages): string[] {
  return Object.keys(pages.public).sort();
}

/** The <head> signals for one page. Throws for a page nobody classified, so the build fails. */
export function pageSeo(site: string, pages: SeoPages, pathname: string): PageSeo {
  const path = sitePath(pathname);
  const description = pages.public[path] ?? pages.unlisted?.[path];
  if (description !== undefined) return { index: true, canonical: siteOrigin(site) + path, description };
  if (pages.private.includes(path)) return { index: false };
  throw new Error(`${path} is not classified: add it to the public, unlisted or private pages`);
}

const attr = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1]);

/**
 * The postbuild guard. `built` maps each built page's site path to its HTML. Returns every problem:
 * a classified path with no built page, a built page nobody classified, a path in two lists, or a
 * page whose HTML doesn't carry the signals its class needs.
 */
export function checkBuild(site: string, pages: SeoPages, built: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const lists: [string, string[]][] = [
    ["public", Object.keys(pages.public)],
    ["unlisted", Object.keys(pages.unlisted ?? {})],
    ["private", [...pages.private]],
  ];
  const classOf = new Map<string, string>();
  for (const [name, paths] of lists) {
    for (const p of paths) {
      if (sitePath(p) !== p) problems.push(`${p} (${name}) is not a site path; write it as ${sitePath(p)}`);
      if (classOf.has(p)) problems.push(`${p} is both ${classOf.get(p)} and ${name}`);
      else classOf.set(p, name);
      if (!(p in built)) problems.push(`${p} is ${name} but no page was built for it`);
    }
  }
  for (const [path, html] of Object.entries(built)) {
    const cls = classOf.get(path);
    if (!cls) { problems.push(`${path} was built but is not classified as public, unlisted or private`); continue; }
    const canonicals = attr(html, /<link\s+rel="canonical"\s+href="([^"]*)"/g);
    const noindex = /<meta\s+name="robots"\s+content="noindex"/.test(html);
    const descriptions = attr(html, /<meta\s+name="description"\s+content="([^"]*)"/g);
    if (cls === "private") {
      if (!noindex) problems.push(`${path} is private but has no <meta name="robots" content="noindex">`);
      if (canonicals.length) problems.push(`${path} is private but has a canonical link`);
    } else {
      const want = siteOrigin(site) + path;
      if (canonicals.length !== 1 || canonicals[0] !== want) problems.push(`${path} needs exactly one canonical link to ${want}`);
      if (noindex) problems.push(`${path} is ${cls} but carries noindex`);
      if (descriptions.length !== 1 || !descriptions[0]?.trim()) problems.push(`${path} needs exactly one non-empty meta description`);
    }
  }
  return problems;
}

// Cloudflare `_headers` (Pages and Workers static assets), as far as tests and local serving need it.
export type HeaderRule = { pattern: string; re: RegExp; headers: [string, string][] };

/** Path rules only: host-specific rules (`https://…`) never match a local request, so they're skipped. */
export function parseHeaders(src: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let cur: HeaderRule | null = null;
  for (const raw of src.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const pattern = raw.trim();
      if (!pattern.startsWith("/")) { cur = null; continue; }
      const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      cur = { pattern, re: new RegExp(`^${re}$`), headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = raw.indexOf(":");
      if (i > 0) cur.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
    }
  }
  return rules;
}

/** Headers for one path. Like Cloudflare, same-name headers from several matching rules are joined with ", ". */
export function headersFor(rules: HeaderRule[], path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    for (const [k, v] of r.headers) {
      const key = k.toLowerCase();
      out.set(key, out.has(key) ? `${out.get(key)}, ${v}` : v);
    }
  }
  return out;
}

/** The patterns of every rule that sets `header` for `path` — more than one means Cloudflare merges them. */
export function rulesSetting(rules: HeaderRule[], path: string, header: string): string[] {
  const h = header.toLowerCase();
  return rules.filter((r) => r.re.test(path) && r.headers.some(([k]) => k.toLowerCase() === h)).map((r) => r.pattern);
}
