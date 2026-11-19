/**
 * The canonical string the auth-bot HMAC-signs and the auth worker verifies for
 * the internal Telegram confirm callback (spec §6). Lives in shared code so the
 * two sides can NEVER drift — a mismatch would silently break verification.
 * Order and separator are part of the contract.
 */
export interface InternalConfirmFields {
  nonce: string;
  telegramId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  ts: string;
}

export function internalConfirmString(p: InternalConfirmFields): string {
  return [p.nonce, p.telegramId, p.username, p.displayName, p.avatarUrl, p.ts].join("\n");
}

/**
 * 4-digit visual match code for the Telegram deep-link flow. Derived from the
 * nonce with HMAC(INTERNAL_HMAC_KEY, "tg-match|" + nonce) so the auth worker
 * (shown on the web page) and the bot (shown in Telegram) agree without any
 * extra state. Domain-separated from the confirm signature; the key never leaves
 * the two workers. The first 4 bytes mod 10000 (bias ≈ 2e-6, irrelevant for a
 * human-comparison code, not a secret).
 */
export async function tgMatchCode(key: string, nonce: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`tg-match|${nonce}`)));
  const n = ((sig[0]! << 24) | (sig[1]! << 16) | (sig[2]! << 8) | sig[3]!) >>> 0;
  return String(n % 10000).padStart(4, "0");
}
