import type { Deps } from "./db";
import { sha256Hex } from "./crypto";

/**
 * Security audit trail (SEC-2). One row per security-relevant outcome, written at
 * the HTTP layer AFTER the outcome is known. What is stored is deliberately
 * minimal: the event name, the account/client ids, a TRUNCATED client IP and a
 * short hash of the User-Agent. Never passwords, recovery codes, auth codes,
 * tokens, session/CSRF ids, attempted usernames, full IPs or raw user agents.
 */
export type AuditEvent =
  | "signup"
  | "login.ok"
  | "login.fail"
  | "logout"
  | "password.change"
  | "recovery.regenerate"
  | "telegram.login"
  | "telegram.link"
  | "telegram.unlink"
  | "consent.grant"
  | "consent.revoke"
  | "token.reuse_detected"
  | "token.code_replay"
  | "token.revoke"
  | "client.create"
  | "client.update"
  | "client.delete"
  | "client.secret_rotate"
  | "mgmt_token.create"
  | "account.delete";

const HEX4 = /^[0-9a-fA-F]{1,4}$/;

function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Expand an IPv6 literal to exactly 8 numeric hextets, or null if malformed. */
function parseIPv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4) -> two hextets.
  const lastColon = s.lastIndexOf(":");
  if (lastColon >= 0 && s.indexOf(".", lastColon) >= 0) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string): string[] | null => {
    if (h === "") return [];
    const g = h.split(":");
    return g.every((x) => HEX4.test(x)) ? g : null;
  };
  const head = toGroups(halves[0]!);
  if (!head) return null;
  let groups: string[];
  if (halves.length === 2) {
    const tail = toGroups(halves[1]!);
    if (!tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Truncate a client IP so the audit log never holds a full address.
 * IPv4 `a.b.c.d` -> `a.b.c.0/24`. IPv6 -> first three hextets after expanding
 * `::`, lowercase with no leading zeros, in the canonical form `x:y:z::/48`
 * (so `2001:db8::1` -> `2001:db8:0::/48`). IPv4-mapped IPv6 is treated as IPv4.
 * Empty or unparseable input -> null.
 */
export function truncIp(ip: string | null): string | null {
  if (!ip) return null;
  const s = ip.trim();
  if (!s) return null;
  const v4 = parseIPv4(s);
  if (v4) return `${v4[0]}.${v4[1]}.${v4[2]}.0/24`;
  const v6 = parseIPv6(s);
  if (!v6) return null;
  if (v6.slice(0, 5).every((h) => h === 0) && v6[5] === 0xffff) {
    return `${v6[6]! >> 8}.${v6[6]! & 255}.${v6[7]! >> 8}.0/24`;
  }
  return `${v6[0]!.toString(16)}:${v6[1]!.toString(16)}:${v6[2]!.toString(16)}::/48`;
}

/** First 16 hex chars of SHA-256(UTF-8 user agent); empty -> null. */
export async function uaHash(ua: string | null): Promise<string | null> {
  if (!ua) return null;
  return (await sha256Hex(ua)).slice(0, 16);
}

/**
 * Record one audit event. NEVER throws and NEVER affects the response: any
 * failure is swallowed and logged as `audit_write_failed <event>` only. With an
 * ExecutionContext the write is scheduled via `waitUntil` (off the response
 * path); without one (tests) it is awaited so assertions are deterministic.
 * Retention (365 days) is NOT handled here: the daily cron in housekeeping.ts prunes old rows.
 */
export async function recordAudit(
  deps: Deps,
  req: Request,
  e: { event: AuditEvent; accountId?: string | null; clientId?: string | null },
  opts?: { network?: boolean },
): Promise<void> {
  const network = opts?.network ?? true;
  const work = async (): Promise<void> => {
    try {
      const db = deps.getDb();
      // network:false → the request is from a service (e.g. the auth bot), not the user: store NULLs.
      const ip = network ? truncIp(req.headers.get("CF-Connecting-IP")) : null;
      const ua = network ? await uaHash(req.headers.get("User-Agent")) : null;
      await db.execute({
        sql: "INSERT INTO audit_log (event, account_id, client_id, ip_trunc, ua_hash) VALUES (?, ?, ?, ?, ?)",
        args: [e.event, e.accountId ?? null, e.clientId ?? null, ip, ua],
      });
    } catch {
      console.error("audit_write_failed", e.event);
    }
  };
  try {
    if (deps.ctx) {
      deps.ctx.waitUntil(work());
      return;
    }
    await work();
  } catch {
    console.error("audit_write_failed", e.event);
  }
}
