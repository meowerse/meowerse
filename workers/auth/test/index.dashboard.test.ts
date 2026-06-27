import { test, expect } from "vitest";
import { handle } from "../src/index";
import { genSigningKeys, routedDb, type Route } from "./helpers";

async function env() {
  const keys = await genSigningKeys();
  return { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
}

const SESSION: Route = [
  /SELECT account_id, auth_time, csrf_token/,
  () => ({ rows: [{ account_id: "owner1", auth_time: 1000, csrf_token: "csrf1", amr: "pwd", idle_expires_at: 9e9, absolute_expires_at: 9e9, revoked_at: null }] }),
];
const NAME_FREE: Route = [/SELECT 1 FROM oauth_clients WHERE name/, () => ({ rows: [] })];

function deps(routes: Route[]) {
  return { getDb: () => routedDb(routes), clock: () => 1000 };
}

test("dev clients: requires a session", async () => {
  const e = await env();
  const noSess = await handle(new Request("https://iss/api/dev/clients", { method: "GET" }), e as never, deps([[/SELECT account_id, auth_time/, () => ({ rows: [] })]]) as never);
  expect(noSess.status).toBe(401);
});

test("create a public client (session + csrf), then list", async () => {
  const e = await env();
  const create = await handle(
    new Request("https://iss/api/dev/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" },
      body: JSON.stringify({ csrf: "csrf1", name: "my-app", client_type: "public", redirect_uris: "https://app.example/cb", scopes: "openid profile", verified_only: "true", offline: "1" }),
    }),
    e as never,
    deps([SESSION, NAME_FREE]) as never,
  );
  const cb = (await create.json()) as { ok: boolean; clientId: string };
  expect(create.status).toBe(200);
  expect(cb.clientId.startsWith("mw_")).toBe(true);

  const list = await handle(new Request("https://iss/api/dev/clients", { method: "GET", headers: { Cookie: "__Host-mw_sess=x" } }), e as never, deps([SESSION, [/FROM oauth_clients WHERE owner_account_id/, () => ({ rows: [] })]]) as never);
  expect(list.status).toBe(200);
});

test("create with an invalid name (valid session+csrf) → 400 from the validator", async () => {
  const e = await env();
  const r = await handle(
    new Request("https://iss/api/dev/clients", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" }, body: JSON.stringify({ csrf: "csrf1", name: "BAD", client_type: "public", redirect_uris: "https://app/cb" }) }),
    e as never,
    deps([SESSION, NAME_FREE]) as never,
  );
  expect(r.status).toBe(400);
});

test("create rejects a bad CSRF token", async () => {
  const e = await env();
  const r = await handle(
    new Request("https://iss/api/dev/clients", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" }, body: JSON.stringify({ csrf: "WRONG", name: "my-app", client_type: "public", redirect_uris: "https://app/cb" }) }),
    e as never,
    deps([SESSION, NAME_FREE]) as never,
  );
  expect(r.status).toBe(403);
});

test("dev: delete, rotate-secret (confidential vs public), and create a PAT", async () => {
  const e = await env();
  const del = await handle(
    new Request("https://iss/api/dev/clients/delete", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" }, body: JSON.stringify({ csrf: "csrf1", client_id: "mw_1" }) }),
    e as never,
    deps([SESSION, [/UPDATE oauth_clients SET status = 'disabled'/, () => ({ rows: [], rowsAffected: 1 })]]) as never,
  );
  expect(((await del.json()) as { ok: boolean }).ok).toBe(true);

  const rot = await handle(
    new Request("https://iss/api/dev/clients/rotate-secret", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" }, body: JSON.stringify({ csrf: "csrf1", client_id: "mw_1" }) }),
    e as never,
    deps([SESSION, [/SELECT client_type FROM oauth_clients/, () => ({ rows: [{ client_type: "confidential" }] })]]) as never,
  );
  expect((await rot.json()) as { clientSecret: string }).toMatchObject({ ok: true });

  const rotPub = await handle(
    new Request("https://iss/api/dev/clients/rotate-secret", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" }, body: JSON.stringify({ csrf: "csrf1", client_id: "mw_1" }) }),
    e as never,
    deps([SESSION, [/SELECT client_type FROM oauth_clients/, () => ({ rows: [{ client_type: "public" }] })]]) as never,
  );
  expect(rotPub.status).toBe(400);

  const tok = await handle(
    new Request("https://iss/api/dev/tokens", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" }, body: JSON.stringify({ csrf: "csrf1", label: "ci" }) }),
    e as never,
    deps([SESSION]) as never,
  );
  expect(((await tok.json()) as { token: string }).token.startsWith("mgmt_")).toBe(true);

  const unknown = await handle(
    new Request("https://iss/api/dev/whatever", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" }, body: JSON.stringify({ csrf: "csrf1" }) }),
    e as never,
    deps([SESSION]) as never,
  );
  expect(unknown.status).toBe(404);
});

test("mgmt upsert reports unchanged on an identical existing client", async () => {
  const e = await env();
  const routes: Route[] = [
    [/FROM management_tokens WHERE token_hash/, () => ({ rows: [{ owner_account_id: "owner1", revoked_at: null }] })],
    [/SELECT client_id, owner_account_id, allowed_scopes/, () => ({ rows: [{ client_id: "mw_1", owner_account_id: "owner1", allowed_scopes: '["openid"]', verified_only: 0, allow_offline_access: 0, display_name: "iac-app" }] })],
    [/redirect_uri FROM oauth_client_redirect_uris/, () => ({ rows: [{ redirect_uri: "https://app/cb" }] })],
  ];
  const r = await handle(
    new Request("https://iss/mgmt/v1/clients", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer mgmt_tok" }, body: JSON.stringify({ name: "iac-app", client_type: "public", redirect_uris: "https://app/cb", scopes: "openid" }) }),
    e as never,
    deps(routes) as never,
  );
  expect((await r.json()) as { unchanged: boolean }).toMatchObject({ unchanged: true });
});

test("management API: PAT-authed upsert by name; no token → 401", async () => {
  const e = await env();
  const noTok = await handle(new Request("https://iss/mgmt/v1/clients", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "iac-app" }) }), e as never, deps([[/FROM management_tokens WHERE token_hash/, () => ({ rows: [] })]]) as never);
  expect(noTok.status).toBe(401);

  const routes: Route[] = [
    [/FROM management_tokens WHERE token_hash/, () => ({ rows: [{ owner_account_id: "owner1", revoked_at: null }] })],
    [/SELECT client_id, owner_account_id, allowed_scopes/, () => ({ rows: [] })], // not existing → create
    NAME_FREE,
  ];
  const ok = await handle(
    new Request("https://iss/mgmt/v1/clients", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer mgmt_tok" }, body: JSON.stringify({ name: "iac-app", client_type: "public", redirect_uris: "https://app/cb", scopes: "openid" }) }),
    e as never,
    deps(routes) as never,
  );
  expect(ok.status).toBe(200);
  expect((await ok.json()) as { created: boolean }).toMatchObject({ created: true });
});

test("dev update client (session+csrf, owner-scoped)", async () => {
  const e = await env();
  const routes: Route[] = [SESSION, [/SELECT 1 FROM oauth_clients WHERE client_id .* AND owner_account_id/, () => ({ rows: [{ "1": 1 }] })]];
  const r = await handle(
    new Request("https://iss/api/dev/clients/update", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" }, body: JSON.stringify({ csrf: "csrf1", client_id: "mw_1", scopes: "openid profile", verified_only: "true", redirect_uris: "https://app/cb" }) }),
    e as never,
    deps(routes) as never,
  );
  expect(r.status).toBe(200);
  // not-owned → 400
  const nf = await handle(
    new Request("https://iss/api/dev/clients/update", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-mw_sess=x" }, body: JSON.stringify({ csrf: "csrf1", client_id: "mw_x", scopes: "openid" }) }),
    e as never,
    deps([SESSION, [/SELECT 1 FROM oauth_clients/, () => ({ rows: [] })]]) as never,
  );
  expect(nf.status).toBe(400);
});

test("mgmt rejects an invalid manifest (bad name) → 400", async () => {
  const e = await env();
  const routes: Route[] = [[/FROM management_tokens WHERE token_hash/, () => ({ rows: [{ owner_account_id: "owner1", revoked_at: null }] })]];
  const r = await handle(new Request("https://iss/mgmt/v1/clients", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer mgmt_tok" }, body: JSON.stringify({ name: "BAD", client_type: "public", redirect_uris: "https://app/cb" }) }), e as never, deps(routes) as never);
  expect(r.status).toBe(400);
});
