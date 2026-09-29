// Cloudflare Pages `_headers`, as far as local serving needs it (scripts/serve-dist.ts).
export type HeaderRule = { re: RegExp; headers: [string, string][] };

/** Path rules only: host-specific rules (`https://…`) never match a local request, so they're skipped. */
export function parseHeaders(src: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let cur: HeaderRule | null = null;
  for (const raw of src.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const pat = raw.trim();
      if (!pat.startsWith("/")) { cur = null; continue; }
      const re = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      cur = { re: new RegExp(`^${re}$`), headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = raw.indexOf(":");
      if (i > 0) cur.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
    }
  }
  return rules;
}

/** Headers for one path. Like Pages, same-name headers from several matching rules are joined with ", ". */
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
