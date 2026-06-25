import type { SigningKeyRecord } from "../src/keys";
import type { DbClient } from "../src/types";

type Row = Record<string, unknown>;
type DbResult = { rows: Row[]; rowsAffected?: number; lastInsertRowid?: number };
export type Route = [RegExp, (args: unknown[]) => DbResult | void];

/**
 * A statement-routed fake DbClient. Each route is [pattern, handler]; the first
 * pattern that matches the SQL wins, and the handler returns rows (or void →
 * empty). Every call is appended to `log` so tests can assert what ran. Keeps
 * DB-dependent unit tests declarative without a real Turso.
 */
export function routedDb(routes: Route[], log: { sql: string; args: unknown[] }[] = []): DbClient {
  return {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? [] : stmt.args;
      log.push({ sql, args });
      for (const [re, fn] of routes) {
        if (re.test(sql)) return fn(args) ?? { rows: [] };
      }
      return { rows: [] };
    },
  };
}

/** Generate a real P-256 keypair and wrap it as AUTH_SIGNING_KEYS records (test-only). */
export async function genSigningKeys(kid = "k1", status: SigningKeyRecord["status"] = "active"): Promise<SigningKeyRecord[]> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return [{ kid, status, privateJwk, publicJwk }];
}
