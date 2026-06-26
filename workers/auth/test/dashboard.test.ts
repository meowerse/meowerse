import { test, expect } from "vitest";
import {
  createClient,
  listClients,
  deleteClient,
  rotateSecret,
  createManagementToken,
  verifyManagementToken,
  upsertClientByName,
  isRegisterableRedirect,
} from "../src/dashboard";
import { sha256Hex } from "../src/crypto";
import { routedDb, type Route } from "./helpers";

const FAST = { rounds: 1, iter: 500 };
// dashboard uses default hash params for secrets; keep tests fast by accepting the cost is small (rounds 6 only on confidential creates)

const nameFree: Route = [/SELECT 1 FROM oauth_clients WHERE name/, () => ({ rows: [] })];

test("isRegisterableRedirect: https ok, loopback http ok, junk rejected", () => {
  expect(isRegisterableRedirect("https://app.example/cb")).toBe(true);
  expect(isRegisterableRedirect("http://127.0.0.1:5/cb")).toBe(true);
  expect(isRegisterableRedirect("http://evil.example/cb")).toBe(false);
  expect(isRegisterableRedirect("https://app.example/cb#frag")).toBe(false);
  expect(isRegisterableRedirect("https://a.example/*")).toBe(false);
  expect(isRegisterableRedirect("not a url")).toBe(false);
  expect(isRegisterableRedirect("https://user:pass@app/cb")).toBe(false); // userinfo
});

test("listClients tolerates a null display_name", async () => {
  const db = routedDb([[/FROM oauth_clients WHERE owner_account_id/, () => ({ rows: [{ client_id: "mw_2", name: "b", display_name: null, client_type: "public", allowed_scopes: "[]", verified_only: 1, status: "active" }] })]]);
  const list = await listClients(db, "o");
  expect(list[0]).toMatchObject({ clientId: "mw_2", displayName: null, verifiedOnly: true });
});

test("createClient validates name/type/redirects before writing", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([nameFree], log);
  expect(await createClient(db, { ownerId: "o", name: "AB", clientType: "public", redirectUris: ["https://x/cb"], allowedScopes: ["openid"] })).toEqual({ ok: false, error: "invalid_name" });
  expect((await createClient(db, { ownerId: "o", name: "good-app", clientType: "weird", redirectUris: ["https://x/cb"], allowedScopes: [] })).ok).toBe(false);
  expect((await createClient(db, { ownerId: "o", name: "good-app", clientType: "public", redirectUris: [], allowedScopes: [] })).ok).toBe(false);
  expect((await createClient(db, { ownerId: "o", name: "good-app", clientType: "public", redirectUris: ["http://evil/cb"], allowedScopes: [] })).ok).toBe(false);
  expect(log.some((c) => c.sql.includes("INSERT INTO oauth_clients"))).toBe(false);
});

test("createClient public: no secret; confidential: one-time secret; openid forced", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const pub = await createClient(routedDb([nameFree], log), { ownerId: "o", name: "pub-app", clientType: "public", redirectUris: ["https://x/cb"], allowedScopes: ["profile"] });
  expect(pub.ok).toBe(true);
  if (pub.ok) expect(pub.clientSecret).toBeUndefined();
  const ins = log.find((c) => c.sql.includes("INSERT INTO oauth_clients"));
  expect(JSON.parse(String(ins?.args[5]))).toContain("openid"); // forced

  const conf = await createClient(routedDb([nameFree]), { ownerId: "o", name: "conf-app", clientType: "confidential", redirectUris: ["https://x/cb"], allowedScopes: ["openid"] });
  expect(conf.ok).toBe(true);
  if (conf.ok) expect(conf.clientSecret?.startsWith("mws_")).toBe(true);
});

test("createClient honors displayName + verified-only + offline flags", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const r = await createClient(routedDb([nameFree], log), { ownerId: "o", name: "flag-app", displayName: "Flag", clientType: "public", redirectUris: ["https://x/cb"], allowedScopes: ["openid", "profile"], verifiedOnly: true, allowOfflineAccess: true });
  expect(r.ok).toBe(true);
  const ins = log.find((c) => c.sql.includes("INSERT INTO oauth_clients"));
  expect(ins?.args[4]).toBe("Flag");
  expect(ins?.args[6]).toBe(1); // allow_offline_access
  expect(ins?.args[7]).toBe(1); // verified_only
});

test("upsert updates when only redirect_uris differ; rejects invalid name/redirect", async () => {
  const existRoutes: Route[] = [
    [/SELECT client_id, owner_account_id, allowed_scopes/, () => ({ rows: [{ client_id: "mw_1", owner_account_id: "o", allowed_scopes: '["openid"]', verified_only: 0, allow_offline_access: 0, display_name: "iac-app" }] })],
    [/redirect_uri FROM oauth_client_redirect_uris/, () => ({ rows: [{ redirect_uri: "https://old/cb" }] })],
  ];
  const log: { sql: string; args: unknown[] }[] = [];
  const r = await upsertClientByName(routedDb(existRoutes, log), "o", { name: "iac-app", clientType: "public", redirectUris: ["https://new/cb"], allowedScopes: ["openid"] });
  expect(r).toMatchObject({ unchanged: false, created: false });
  expect(log.some((c) => c.sql.includes("DELETE FROM oauth_client_redirect_uris"))).toBe(true);

  expect(await upsertClientByName(routedDb([]), "o", { name: "BAD", clientType: "public", redirectUris: ["https://x/cb"], allowedScopes: [] })).toEqual({ error: "invalid_name" });
  expect(await upsertClientByName(routedDb([]), "o", { name: "ok-app", clientType: "public", redirectUris: ["http://evil/cb"], allowedScopes: [] })).toEqual({ error: "invalid_redirect_uri" });
});

test("createClient rejects a taken name", async () => {
  const taken: Route = [/SELECT 1 FROM oauth_clients WHERE name/, () => ({ rows: [{ "1": 1 }] })];
  expect(await createClient(routedDb([taken]), { ownerId: "o", name: "taken-app", clientType: "public", redirectUris: ["https://x/cb"], allowedScopes: [] })).toEqual({ ok: false, error: "name_taken" });
});

test("listClients maps rows", async () => {
  const db = routedDb([[/FROM oauth_clients WHERE owner_account_id/, () => ({ rows: [{ client_id: "mw_1", name: "a", display_name: "A", client_type: "public", allowed_scopes: '["openid"]', verified_only: 0, status: "active" }] })]]);
  const list = await listClients(db, "o");
  expect(list[0]).toMatchObject({ clientId: "mw_1", allowedScopes: ["openid"], verifiedOnly: false });
});

test("deleteClient soft-deletes + cascade revokes when owned", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const owned = routedDb([[/UPDATE oauth_clients SET status = 'disabled'/, () => ({ rows: [], rowsAffected: 1 })]], log);
  expect(await deleteClient(owned, "o", "mw_1")).toBe(true);
  expect(log.some((c) => c.sql.includes("DELETE FROM consents"))).toBe(true);
  expect(log.some((c) => c.sql.includes("UPDATE access_tokens SET revoked_at"))).toBe(true);

  const notOwned = routedDb([[/UPDATE oauth_clients SET status = 'disabled'/, () => ({ rows: [], rowsAffected: 0 })]]);
  expect(await deleteClient(notOwned, "o", "mw_1")).toBe(false);
});

test("rotateSecret only for owned confidential clients", async () => {
  const conf = routedDb([[/SELECT client_type FROM oauth_clients/, () => ({ rows: [{ client_type: "confidential" }] })]]);
  const r = await rotateSecret(conf, "o", "mw_1");
  expect(r.ok).toBe(true);
  expect(r.clientSecret?.startsWith("mws_")).toBe(true);

  const pub = routedDb([[/SELECT client_type FROM oauth_clients/, () => ({ rows: [{ client_type: "public" }] })]]);
  expect((await rotateSecret(pub, "o", "mw_1")).ok).toBe(false);
  const missing = routedDb([[/SELECT client_type FROM oauth_clients/, () => ({ rows: [] })]]);
  expect((await rotateSecret(missing, "o", "mw_1")).ok).toBe(false);
});

test("management tokens: create + verify; revoked/unknown → null", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const tok = await createManagementToken(routedDb([], log), "o", "ci");
  expect(tok.startsWith("mgmt_")).toBe(true);
  const ins = log.find((c) => c.sql.includes("INSERT INTO management_tokens"));
  expect(ins?.args[0]).toBe(await sha256Hex(tok));

  const valid = routedDb([[/FROM management_tokens WHERE token_hash/, () => ({ rows: [{ owner_account_id: "o", revoked_at: null }] })]]);
  expect(await verifyManagementToken(valid, tok)).toBe("o");
  const revoked = routedDb([[/FROM management_tokens WHERE token_hash/, () => ({ rows: [{ owner_account_id: "o", revoked_at: "2026" }] })]]);
  expect(await verifyManagementToken(revoked, tok)).toBeNull();
  expect(await verifyManagementToken(routedDb([]), "")).toBeNull();
});

test("upsertClientByName: create when new, unchanged on identical, update on diff, not_owner guard", async () => {
  // new → create
  const created = await upsertClientByName(routedDb([[/FROM oauth_clients WHERE name/, () => ({ rows: [] })], nameFree]), "o", { name: "iac-app", clientType: "public", redirectUris: ["https://x/cb"], allowedScopes: ["openid"] });
  expect(created).toMatchObject({ created: true });

  // identical → unchanged
  const existRoutes: Route[] = [
    [/SELECT client_id, owner_account_id, allowed_scopes/, () => ({ rows: [{ client_id: "mw_1", owner_account_id: "o", allowed_scopes: '["openid"]', verified_only: 0, allow_offline_access: 0, display_name: "iac-app" }] })],
    [/redirect_uri FROM oauth_client_redirect_uris/, () => ({ rows: [{ redirect_uri: "https://x/cb" }] })],
  ];
  const unchanged = await upsertClientByName(routedDb(existRoutes), "o", { name: "iac-app", clientType: "public", redirectUris: ["https://x/cb"], allowedScopes: ["openid"] });
  expect(unchanged).toMatchObject({ unchanged: true, clientId: "mw_1" });

  // different scopes → update
  const log: { sql: string; args: unknown[] }[] = [];
  const updated = await upsertClientByName(routedDb(existRoutes, log), "o", { name: "iac-app", clientType: "public", redirectUris: ["https://x/cb"], allowedScopes: ["openid", "profile"] });
  expect(updated).toMatchObject({ created: false, unchanged: false });
  expect(log.some((c) => c.sql.includes("UPDATE oauth_clients SET allowed_scopes"))).toBe(true);

  // owned by someone else → not_owner
  const foreign = await upsertClientByName(routedDb([[/SELECT client_id, owner_account_id, allowed_scopes/, () => ({ rows: [{ client_id: "mw_1", owner_account_id: "other", allowed_scopes: "[]" }] })]]), "o", { name: "iac-app", clientType: "public", redirectUris: ["https://x/cb"], allowedScopes: [] });
  expect(foreign).toEqual({ error: "not_owner" });
});
