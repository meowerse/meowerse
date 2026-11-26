// Postbuild for meowsenger.alxnko.dev (`bun run build` runs it after `astro build`): checks every built
// page against the public/unlisted/private classification in src/lib/seo.ts (a new page must be
// classified; each page must carry the canonical or noindex its class needs) and writes dist/sitemap.xml
// from the public pages. Any problem fails the build, as does /app's eager JS going over its gzip budget.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { checkBuild, sitemapPaths, sitemapXml, sitePath } from "@meowerse/ui/seo";
import { PAGES, SITE } from "../src/lib/seo";
import { bundleReport, EAGER_JS_GZIP_BUDGET } from "../perf/bundle";

const dist = join(process.cwd(), "dist");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const html = walk(dist).map((f) => relative(dist, f)).filter((f) => f.endsWith(".html") && !f.startsWith("_astro"));
const built = Object.fromEntries(html.map((f) => [sitePath(f), readFileSync(join(dist, f), "utf8")]));
const dupes = html.filter((f, i) => html.findIndex((g) => sitePath(g) === sitePath(f)) !== i);
if (dupes.length) throw new Error(`built files that map to an already-built page: ${dupes.join(", ")}`);
const problems = checkBuild(SITE, PAGES, built);
if (problems.length) throw new Error(`search-engine signals:\n  ${problems.join("\n  ")}`);
const report = bundleReport(dist);
const eager = report.eagerJsGzip;
if (report.eagerJs.length === 0 || eager === 0) throw new Error("bundle budget: no eager JS found for /app (dist/app/index.html markers changed?); refusing to pass vacuously");
if (eager > EAGER_JS_GZIP_BUDGET) throw new Error(`/app eager JS is ${eager} B gzip, over the ${EAGER_JS_GZIP_BUDGET} B budget (perf/bundle.ts): lazy-load the new code`);
console.log(`bundle: /app eager JS ${eager} B gzip (budget ${EAGER_JS_GZIP_BUDGET})`);
const paths = sitemapPaths(PAGES);
writeFileSync(join(dist, "sitemap.xml"), sitemapXml(SITE, paths));
console.log(`seo: ${Object.keys(built).length} pages classified; sitemap: ${paths.length} pages`);
