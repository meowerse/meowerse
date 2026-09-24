/** dist-relative HTML files → site paths ("index.html" → "/", "p/auth/index.html" → "/p/auth/"); no 404. */
export function pagePaths(htmlFiles: string[]): string[] {
  return htmlFiles
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f !== "404.html" && f.endsWith("index.html") && !f.startsWith("_astro/"))
    .map((f) => `/${f.slice(0, -"index.html".length)}`)
    .sort();
}

export function sitemapXml(site: string, paths: string[]): string {
  const base = site.replace(/\/$/, "");
  const urls = paths.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
