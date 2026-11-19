import { test, expect } from "vitest";
import {
  createClient,
  listClients,
  deleteClient,
  rotateSecret,
  createManagementToken,
  verifyManagementToken,
  upsertClientByName,
  updateClient,
  isRegisterableRedirect,
  brandOwnerIds,
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
  const db = routedDb([[/FROM oauth_clients WHERE owner_account_id/, () => ({ rows: [{ client_id: "mw_2", name: "b", display_name: null, client_type: "public", allowed_scopes: "[]", verified_only: 1, allow_offline_access: 1, status: "active" }] })]]);
  const list = await listClients(db, "o");
  expect(list[0]).toMatchObject({ clientId: "mw_2", displayName: null, verifiedOnly: true, allowOfflineAccess: true });
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

test("updateClient: owner-scoped; not-found + bad redirect rejected; updates scopes/verified/redirects", async () => {
  const owned: Route[] = [[/SELECT 1 FROM oauth_clients WHERE client_id .* AND owner_account_id/, () => ({ rows: [{ "1": 1 }] })]];
  const log: { sql: string; args: unknown[] }[] = [];
  const r = await updateClient(routedDb(owned, log), "o", { clientId: "mw_1", allowedScopes: ["openid", "profile"], verifiedOnly: true, redirectUris: ["https://app/cb"] });
  expect(r).toEqual({ ok: true });
  expect(log.some((c) => c.sql.includes("UPDATE oauth_clients SET"))).toBe(true);
  expect(log.some((c) => c.sql.includes("DELETE FROM oauth_client_redirect_uris"))).toBe(true);
  expect(log.some((c) => c.sql.includes("INSERT INTO oauth_client_redirect_uris"))).toBe(true);

  // minimal update (offline + displayName only; no scopes/verified/redirects) still UPDATEs, no redirect rewrite
  const log2: { sql: string; args: unknown[] }[] = [];
  expect((await updateClient(routedDb(owned, log2), "o", { clientId: "mw_1", allowOfflineAccess: true, displayName: "New" })).ok).toBe(true);
  expect(log2.some((c) => c.sql.includes("DELETE FROM oauth_client_redirect_uris"))).toBe(false);

  expect(await updateClient(routedDb([[/SELECT 1 FROM oauth_clients/, () => ({ rows: [] })]]), "o", { clientId: "mw_1" })).toEqual({ ok: false, error: "not_found" });
  expect((await updateClient(routedDb(owned), "o", { clientId: "mw_1", redirectUris: ["http://evil/cb"] })).error).toBe("invalid_redirect_uri");
  expect((await updateClient(routedDb(owned), "o", { clientId: "mw_1", redirectUris: [] })).error).toBe("redirect_uri_required");
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

test("first-party brand names are reserved for non-system owners (name and display name, normalised)", async () => {
  const base = { clientType: "public", redirectUris: ["https://x.example/cb"], allowedScopes: ["openid"] };
  for (const [name, displayName] of [["my-app", "Meowsenger"], ["my-app", "Meow-senger Official"], ["my-app", "ＭＥＯＷＥＲＳＥ"], ["meowerse-clone", "Clone"], ["my-app", "sun meow"]]) {
    const r = await createClient(routedDb([nameFree]), { ...base, ownerId: "acct_dev", name: name!, displayName });
    expect(r, `${name}/${displayName}`).toEqual({ ok: false, error: "reserved_name" });
  }
  // the update and the IaC upsert paths are guarded too
  const own: Route = [/SELECT 1 FROM oauth_clients WHERE client_id = \? AND owner_account_id/, () => ({ rows: [{ x: 1 }] })];
  expect(await updateClient(routedDb([own]), "acct_dev", { clientId: "mw_x", displayName: "Meowerse" })).toEqual({ ok: false, error: "reserved_name" });
  expect(await upsertClientByName(routedDb([nameFree]), "acct_dev", { ...base, name: "ok-name", displayName: "Meowsenger" })).toEqual({ error: "reserved_name" });
  // an ordinary name still registers
  const ok = await createClient(routedDb([nameFree]), { ...base, ownerId: "acct_dev", name: "my-app", displayName: "My Cat App" });
  expect(ok.ok).toBe(true);
});

test("M6 brand check: lookalikes (Cyrillic, 0/1/3, rn, vv, mixed script, combining marks) are rejected for ordinary owners", async () => {
  const base = { clientType: "public", redirectUris: ["https://x.example/cb"], allowedScopes: ["openid"] };
  const bad = ["Me\u043ewsenger", "M\u0435owsenger", "Meowsenger".replace("o", "0"), "m3owerse", "rneowerse", "meowe\u0301rse", "meow\uff53enger", "alxnk0", "a1xnko", "meovvsenger"];
  for (const dn of bad) {
    const r = await createClient(routedDb([nameFree]), { ...base, ownerId: "acct_dev", name: "my-app", displayName: dn });
    expect(r, dn).toEqual({ ok: false, error: "reserved_name" });
  }
  // plain non-brand names (incl. non-Latin) still register
  for (const dn of ["Мой кот", "猫アプリ", "Nekomancer", "My 1st app"]) {
    expect((await createClient(routedDb([nameFree]), { ...base, ownerId: "acct_dev", name: "my-app", displayName: dn })).ok, dn).toBe(true);
  }
});

test("M6 brand check: exempt owners (acct_system and BRAND_OWNER_ACCOUNT_IDS) may use brand names; others may not", async () => {
  const base = { clientType: "public", redirectUris: ["https://x.example/cb"], allowedScopes: ["openid"], name: "meowsenger", displayName: "Meowsenger" };
  expect((await createClient(routedDb([nameFree]), { ...base, ownerId: "acct_system" })).ok).toBe(true);
  expect(await createClient(routedDb([nameFree]), { ...base, ownerId: "acct_ops" })).toEqual({ ok: false, error: "reserved_name" });
  expect((await createClient(routedDb([nameFree]), { ...base, ownerId: "acct_ops" }, { brandOwners: brandOwnerIds(" acct_ops, acct_x ") })).ok).toBe(true);
  expect(brandOwnerIds("").size).toBe(0);
  expect(brandOwnerIds(undefined).size).toBe(0);
});

test("M6 brand check: re-sending a row's EXISTING name/display name is a no-op that still works; changing it to a brand does not", async () => {
  const own: Route = [/SELECT 1 FROM oauth_clients WHERE client_id = \? AND owner_account_id/, () => ({ rows: [{ x: 1 }] })];
  const sameDn: Route = [/SELECT display_name FROM oauth_clients WHERE client_id = \? AND display_name = \?/, (args) => ({ rows: args[1] === "Meowsenger" ? [{ display_name: "Meowsenger" }] : [] })];
  // dashboard edit resending the existing display name
  expect((await updateClient(routedDb([own, sameDn]), "acct_dev", { clientId: "mw_x", displayName: "Meowsenger" })).ok).toBe(true);
  // changing to a different brand name
  expect(await updateClient(routedDb([own, sameDn]), "acct_dev", { clientId: "mw_x", displayName: "Meowerse" })).toEqual({ ok: false, error: "reserved_name" });
  // IaC re-provision of an existing row with the same name + display name
  const row = { client_id: "mw_1", owner_account_id: "acct_dev", allowed_scopes: '["openid"]', verified_only: 0, allow_offline_access: 0, display_name: "Meowsenger" };
  const existing: Route = [/SELECT client_id, owner_account_id, allowed_scopes/, () => ({ rows: [row] })];
  const uris: Route = [/redirect_uri FROM oauth_client_redirect_uris/, () => ({ rows: [{ redirect_uri: "https://x.example/cb" }] })];
  const same = await upsertClientByName(routedDb([existing, uris]), "acct_dev", { name: "meowsenger", displayName: "Meowsenger", clientType: "public", redirectUris: ["https://x.example/cb"], allowedScopes: ["openid"] });
  expect(same).toMatchObject({ created: false, unchanged: true });
  // same row, display name changed to a different brand → rejected
  expect(await upsertClientByName(routedDb([existing, uris]), "acct_dev", { name: "meowsenger", displayName: "Meowerse", clientType: "public", redirectUris: ["https://x.example/cb"], allowedScopes: ["openid"] })).toEqual({ error: "reserved_name" });
});

test("brand check matching rule: other-script lookalikes and joined tokens are rejected, bilingual and near-miss names allowed", async () => {
  const base = { clientType: "public", redirectUris: ["https://x.example/cb"], allowedScopes: ["openid"] };
  const make = (displayName: string, ownerId = "acct_dev") => createClient(routedDb([nameFree]), { ...base, ownerId, name: "my-app", displayName });
  for (const dn of [
    "me\u0585wsenger", "me\u043ewsenger", "me0wsenger", "My Meowerse app", "Meow-senger", "m e o w s e n g e r", "MeowerseApp", "me\u0585wsenger Chat", "Meowsengers",
    "Meow\u200bsengers", "Xsun\u200bmeow", "Meow\u00adsengerz", "\u24dc\u24d4\u24de\u24e6\u24e2\u24d4\u24dd\u24d6\u24d4\u24e1",
    "me\u00f8wsenger", "\u0251lxnko", "a\u026bxnko", "moonme\u00f8w", "meowsenge\u027c", "me\u03bfwsenger",
    "\ua4dfeowsenger", "meowsen\ua4d6er", "sunmeo\ua4ea", "alxnk\ua4f3", "\ua4f2lxnko", "\u15f0eowsenger", "\u146deowsenger",
    "\u1d0d\u1d07\u1d0f\u1d21s\u1d07\u0274\u0262\u1d07\u0280", "\u0251\u026bxnk\u0254", "Meow\u200fsengers", "me\u0585wsen\u0563e\u0580",
  ]) {
    expect(await make(dn), dn).toEqual({ ok: false, error: "reserved_name" });
  }
  for (const dn of ["Мой Blog", "Meowers Events", "Meow Sengerfan", "Meow\u30c1\u30e3\u30c3\u30c8", "Meow\u30ab\u30d5\u30a7\u5e97", "Alx\u65e5\u672c\u8a9e", "Moon\u55b5\u55b5\u55b5\u55b5", "Cats \u{1F468}\u200d\u{1F469} club", "M\u00f6nster App", "Caf\u00e9 Moon", "Sun Meowing", "Meow \u0645\u0631\u062d\u0628\u0627", "Meow\u0633\u0644\u0627\u0645", "Alx\u05e9\u05dc\u05d5\u05dd", "Moon\u0645\u0627\u0647", "Meow\u200c\u0645\u06cc", "Moon\u200f\u05e9\u05dc\u05d5\u05dd", "Moonme\u65e5\u672c", "Moon\u0436\u0436\u0436\u0436"]) expect((await make(dn)).ok, dn).toBe(true);
  // exempt owners may still use brand names
  expect((await make("Meowerse", "acct_system")).ok).toBe(true);
  expect((await createClient(routedDb([nameFree]), { ...base, ownerId: "acct_ops", name: "my-app", displayName: "Meowerse" }, { brandOwners: brandOwnerIds("acct_ops") })).ok).toBe(true);
});
