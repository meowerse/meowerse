import { test, expect } from "vitest";
import { consentDecision, getConsent, grantConsent, listGrants, revokeGrant } from "../src/consent";
import { routedDb } from "./helpers";

test("listGrants parses scopes (bad json → []); revokeGrant drops consent + kills app tokens", async () => {
  const db = routedDb([[/FROM consents WHERE account_id/, () => ({ rows: [{ client_id: "mw_1", approved_scope_snapshot: '["openid"]', updated_at: "t" }, { client_id: "mw_2", approved_scope_snapshot: "bad", updated_at: null }] })]]);
  const g = await listGrants(db, "a");
  expect(g[0]).toMatchObject({ clientId: "mw_1", approvedScopes: ["openid"], updatedAt: "t" });
  expect(g[1]?.approvedScopes).toEqual([]);

  const log: { sql: string; args: unknown[] }[] = [];
  await revokeGrant(routedDb([], log), "a", "mw_1");
  expect(log.some((c) => c.sql.includes("DELETE FROM consents"))).toBe(true);
  expect(log.some((c) => c.sql.includes("UPDATE access_tokens SET revoked_at"))).toBe(true);
  expect(log.some((c) => c.sql.includes("UPDATE refresh_tokens SET used_at"))).toBe(true);
});

const base = {
  requested: ["openid", "profile"],
  clientAllowed: ["openid", "profile", "telegram", "verified"],
  priorConsentScopes: null as string[] | null,
  priorMax: null as string[] | null,
  verifiedOnly: false,
  userVerified: false,
  firstParty: false,
};

test("verified-only + unverified user routes to verify_upgrade", () => {
  expect(consentDecision({ ...base, verifiedOnly: true, userVerified: false }).action).toBe("verify_upgrade");
  expect(consentDecision({ ...base, verifiedOnly: true, userVerified: true }).action).toBe("prompt");
});

test("first-party and prior-covering grants are silent; otherwise prompt", () => {
  expect(consentDecision({ ...base, firstParty: true }).action).toBe("silent");
  expect(consentDecision({ ...base, priorConsentScopes: ["openid", "profile", "telegram"] }).action).toBe("silent");
  expect(consentDecision({ ...base }).action).toBe("prompt");
  // prompt=consent forces a prompt even with a covering prior grant
  expect(
    consentDecision({ ...base, priorConsentScopes: ["openid", "profile"], prompt: "consent" }).action,
  ).toBe("prompt");
});

test("decision scope is the live intersection with client-allowed", () => {
  const d = consentDecision({ ...base, requested: ["openid", "profile", "telegram"], clientAllowed: ["openid", "profile"] });
  expect(d.scope).toEqual(["openid", "profile"]);
});

test("grantConsent unions max, caps to allowed, returns effective scope", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const scope = await grantConsent(routedDb([], log), {
    accountId: "acct_1",
    clientId: "mw_demo",
    requested: ["openid", "telegram"],
    clientAllowed: ["openid", "profile", "telegram"],
    priorMax: ["openid", "profile"],
  });
  expect(scope).toEqual(["openid", "telegram"]);
  const ins = log.find((c) => c.sql.includes("INSERT INTO consents"));
  expect(JSON.parse(String(ins?.args[2])).sort()).toEqual(["openid", "profile", "telegram"]); // scope_set_max union
});

test("getConsent parses stored JSON, null when absent", async () => {
  const db = routedDb([
    [/FROM consents WHERE/, () => ({ rows: [{ scope_set_max: '["openid","profile"]', approved_scope_snapshot: '["openid"]' }] })],
  ]);
  expect(await getConsent(db, "a", "c")).toEqual({ scopeSetMax: ["openid", "profile"], approvedSnapshot: ["openid"] });
  expect(await getConsent(routedDb([[/FROM consents/, () => ({ rows: [] })]]), "a", "c")).toBeNull();
});
