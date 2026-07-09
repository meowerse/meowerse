import type { ReactNode } from "react";

/**
 * Format a message timestamp as a day-separator label: "today" / "yesterday" for
 * the two most recent calendar days, otherwise a short "Mon 5"-style date. Pure —
 * compares calendar days in the local timezone (not elapsed ms), so a message from
 * 11pm yesterday reads "yesterday", not "today".
 */
export function fmtDay(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// http(s):// links and bare www. links. `[^\s]+` grabs the whole run; trailing
// sentence punctuation is trimmed back off below so "see https://a.com." doesn't
// swallow the period into the href.
const URL_RE = /(?:https?:\/\/|www\.)[^\s]+/gi;
const TRAILING_RE = /[.,!?;:'")\]}>]+$/;

/**
 * Split a plain message body into an array of React nodes, turning URLs into safe
 * external anchors and leaving everything else as text. PURE + XSS-safe: only
 * http(s)/www runs match (never `javascript:`), the visible text and href both come
 * straight from the user string (React escapes them), and links carry
 * rel="noopener noreferrer". Never used with dangerouslySetInnerHTML.
 */
export function renderBody(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text)) !== null) {
    const start = match.index;
    let url = match[0];
    // Trim trailing punctuation that's almost never part of the link itself.
    let trailing = "";
    const tm = url.match(TRAILING_RE);
    if (tm) {
      trailing = tm[0];
      url = url.slice(0, url.length - trailing.length);
    }
    if (!url) continue; // pathological match of pure punctuation — skip
    if (start > last) nodes.push(text.slice(last, start));
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    nodes.push(
      <a key={`lnk-${key++}`} href={href} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    if (trailing) nodes.push(trailing);
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length > 0 ? nodes : [text];
}
