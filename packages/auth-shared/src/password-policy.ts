/**
 * Password policy (spec §7): NFKC-normalize, then 12–128 chars. The 128 cap is a
 * security control, not UX — it bounds PBKDF2 input so a megabyte password can't
 * be used to amplify hashing CPU into a DoS. No composition/rotation rules
 * (modern guidance); breach screening (HIBP) is enforced separately at the worker.
 */
export type PasswordResult = { ok: true; password: string } | { ok: false; error: string };

export function validatePassword(input: unknown): PasswordResult {
  if (typeof input !== "string") return { ok: false, error: "password must be a string" };
  const pw = input.normalize("NFKC");
  if (pw.length < 12) return { ok: false, error: "password must be at least 12 characters" };
  if (pw.length > 128) return { ok: false, error: "password must be at most 128 characters" };
  return { ok: true, password: pw };
}
