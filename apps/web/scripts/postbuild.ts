// Postbuild for meow.alxnko.dev (`bun run build` runs it after `astro build`):
//  1. refuses what the strict CSP would break: style="" attributes, data: URLs (assetsInlineLimit: 0)
//     and external stylesheets (the site CSS must be inlined: one hash);
//  2. hashes every inline <script>/<style> in dist/**/*.{html,svg} into ONE strict CSP with Trusted
//     Types, with connect-src from the project probes, and writes it into dist/_headers (__CSP__);
//  3. writes dist/sitemap.xml from the built pages.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildCsp, dataUrls, MAX_HEADER, probeOrigins, styleAttrs } from "../src/lib/csp";
import { pagePaths, sitemapXml } from "@meowerse/ui/seo";
import { SITE } from "../src/lib/site";

const root = process.cwd();
const dist = join(root, "dist");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const read = (f: string) => readFileSync(f, "utf8");
const files = walk(dist);
const html = files.filter((f) => f.endsWith(".html"));
const svg = files.filter((f) => f.endsWith(".svg"));
const css = files.filter((f) => f.endsWith(".css"));
const rel = (fs: string[]) => fs.map((f) => relative(dist, f)).join("\n  ");

const withStyle = html.filter((f) => styleAttrs(read(f)) > 0);
if (withStyle.length) throw new Error(`style="" attributes are blocked by the CSP:\n  ${rel(withStyle)}`);
const withData = [...html, ...css].filter((f) => dataUrls(read(f)).length > 0);
if (withData.length) throw new Error(`data: URLs are blocked by the CSP (keep assetsInlineLimit: 0):\n  ${rel(withData)}`);
const linked = html.filter((f) => /<link[^>]+rel="stylesheet"/.test(read(f)));
if (linked.length) throw new Error(`external stylesheets: the site CSS must be inlined (one hash):\n  ${rel(linked)}`);

const contentDir = join(root, "src/content/projects");
const projects = existsSync(contentDir)
  ? readdirSync(contentDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(read(join(contentDir, f))))
  : [];
const csp = buildCsp([...html, ...svg].map(read), probeOrigins(projects));
if (csp.length > MAX_HEADER) throw new Error(`the CSP is ${csp.length} characters; Cloudflare Pages allows ${MAX_HEADER}`);

const headersPath = join(dist, "_headers");
const slot = "Content-Security-Policy: __CSP__";
const headers = read(headersPath);
if (headers.split(slot).length !== 2) throw new Error(`dist/_headers needs exactly one "${slot}" line`);
writeFileSync(headersPath, headers.replace(slot, `Content-Security-Policy: ${csp}`));

const paths = pagePaths(html.map((f) => relative(dist, f)));
writeFileSync(join(dist, "sitemap.xml"), sitemapXml(SITE.url, paths));
console.log(`csp: ${csp.length} chars, ${(csp.match(/sha256-/g) ?? []).length} hashes → dist/_headers; sitemap: ${paths.length} pages`);
