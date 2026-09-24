// Lab and e2e only: serve dist/ the way Cloudflare Pages does for this site: the real dist/_headers
// (CSP included), /dir → /dir/ redirects, directory indexes, the 404 page with a 404 status, and gzip
// (the CDN compresses; Lighthouse must see it). Usage: bun scripts/serve-dist.ts [port]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";
import { headersFor, parseHeaders } from "../src/lib/headers";

const dist = join(process.cwd(), "dist");
const port = Number(process.argv[2] ?? 4371);
const rules = parseHeaders(readFileSync(join(dist, "_headers"), "utf8"));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".bin": "application/octet-stream",
};
const COMPRESS = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".txt", ".xml"]);

type Hit = { file: string; status: number } | { location: string };
function resolve(pathname: string): Hit {
  const relPath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const f = join(dist, relPath);
  if (!f.startsWith(dist)) return { file: join(dist, "404.html"), status: 404 };
  if (existsSync(f) && statSync(f).isFile()) return { file: f, status: 200 };
  if (existsSync(join(f, "index.html")))
    return pathname.endsWith("/") ? { file: join(f, "index.html"), status: 200 } : { location: `${pathname}/` };
  return { file: join(dist, "404.html"), status: 404 };
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const hit = resolve(url.pathname);
  if ("location" in hit) { res.writeHead(308, { location: hit.location + url.search }); res.end(); return; }
  const headers: Record<string, string> = Object.fromEntries(headersFor(rules, url.pathname));
  const ext = extname(hit.file);
  headers["content-type"] = TYPES[ext] ?? "application/octet-stream";
  let body: Buffer = readFileSync(hit.file);
  if (COMPRESS.has(ext) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    body = gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers["vary"] = "Accept-Encoding";
  }
  res.writeHead(hit.status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}).listen(port, "127.0.0.1", () => console.log(`serving dist/ with _headers on http://127.0.0.1:${port}`));
