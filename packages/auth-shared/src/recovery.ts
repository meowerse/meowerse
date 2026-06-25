/**
 * One-time recovery codes (spec §7). Exactly 8 by default, each 10 Crockford
 * base32 chars (~50 bits) formatted `XXXXX-XXXXX`. Crockford excludes I L O U,
 * so {@link normalizeRecoveryCode} can fold a user's ambiguous typing back to
 * the canonical alphabet before hashing/compare.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I L O U)

export function genRecoveryCodes(n = 8): string[] {
  const codes = new Set<string>();
  while (codes.size < n) {
    codes.add(formatCode(randomGroup() + randomGroup()));
  }
  return [...codes];
}

function randomGroup(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET.charAt(b & 31);
  return s;
}

function formatCode(ten: string): string {
  return ten.slice(0, 5) + "-" + ten.slice(5, 10);
}

/**
 * Canonicalize a user-entered recovery code: upper-case, strip spaces/dashes,
 * and map Crockford-ambiguous glyphs (O→0, I/L→1, U→V) so a code typed with the
 * "wrong" lookalike still matches what we hashed.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}
