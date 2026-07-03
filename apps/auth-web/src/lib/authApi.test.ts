import { afterEach, describe, expect, it, test, vi } from "vitest";
import {
  deleteAccount,
  postSignup,
  postLogin,
  postConsent,
  getPending,
  nextLocation,
  tgStart,
  tgStatus,
  listClients,
  createClient,
  getAccount,
  postAccountPassword,
  getGrants,
  revokeGrant,
  unlinkTelegram,
  regenerateRecoveryCodes,
  deleteClient,
  rotateClientSecret,
  postManagementToken,
} from "./authApi";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockJson(value: unknown, init?: ResponseInit) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(value), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("postSignup POSTs credentialed JSON and parses", async () => {
  const fetchMock = mockJson({ ok: true, recoveryCodes: ["A", "B"], csrf: "c", next: { action: "consent" } });
  const out = await postSignup("http://x", "neko", "password1234");
  const [url, opts] = fetchMock.mock.calls[0];
  expect(url).toBe("http://x/signup");
  expect(opts.method).toBe("POST");
  expect(opts.credentials).toBe("include");
  expect(JSON.parse(opts.body)).toEqual({ username: "neko", password: "password1234" });
  expect(out.recoveryCodes).toEqual(["A", "B"]);
});

test("postLogin and postConsent hit the right endpoints", async () => {
  const a = mockJson({ ok: true, next: { action: "redirect", url: "https://app/cb?code=1" } });
  await postLogin("http://x", "neko", "password1234");
  expect(a.mock.calls[0][0]).toBe("http://x/login");

  const b = mockJson({ redirect: "https://app/cb?code=1" });
  const res = await postConsent("http://x", "allow", "csrf1");
  expect(b.mock.calls[0][0]).toBe("http://x/consent");
  expect(JSON.parse(b.mock.calls[0][1].body)).toEqual({ decision: "allow", csrf: "csrf1" });
  expect(res.redirect).toContain("code=1");
});

test("getPending GETs credentialed", async () => {
  const m = mockJson({ client: { name: "Demo", logo: null }, scope: ["openid"], csrf: "c" });
  const p = await getPending("http://x");
  expect(m.mock.calls[0][0]).toBe("http://x/authorize/pending");
  expect(m.mock.calls[0][1].credentials).toBe("include");
  expect(p.client?.name).toBe("Demo");
});

test("tgStart POSTs and tgStatus GETs credentialed", async () => {
  const a = mockJson({ ticketId: "tkt_1", deepLink: "https://t.me/bot?start=n" });
  const s = await tgStart("http://x");
  expect(a.mock.calls[0][0]).toBe("http://x/tg/start");
  expect(a.mock.calls[0][1].credentials).toBe("include");
  expect(s.ticketId).toBe("tkt_1");

  const b = mockJson({ ready: true, next: { action: "redirect", url: "https://app/cb" } });
  const st = await tgStatus("http://x", "tkt_1");
  expect(b.mock.calls[0][0]).toBe("http://x/tg/status?ticket=tkt_1");
  expect(st.ready).toBe(true);
});

test("listClients GETs and createClient POSTs the manifest", async () => {
  const a = mockJson({ clients: [{ clientId: "mw_1", name: "a", displayName: null, clientType: "public", allowedScopes: ["openid"], verifiedOnly: false, status: "active" }], csrf: "c" });
  const l = await listClients("http://x");
  expect(a.mock.calls[0][0]).toBe("http://x/api/dev/clients");
  expect(l.csrf).toBe("c");

  const b = mockJson({ ok: true, clientId: "mw_2" });
  const r = await createClient("http://x", { csrf: "c", name: "my-app", client_type: "public", redirect_uris: "https://app/cb", scopes: "openid" });
  expect(b.mock.calls[0][0]).toBe("http://x/api/dev/clients");
  expect(b.mock.calls[0][1].method).toBe("POST");
  expect(r.clientId).toBe("mw_2");
});

test("account helpers hit the right endpoints", async () => {
  const a = mockJson({ username: "neko", verified: false, hasPassword: true, telegram: { linked: false, username: null }, recoveryRemaining: 8, csrf: "c" });
  expect((await getAccount("http://x")).username).toBe("neko");
  expect(a.mock.calls[0][0]).toBe("http://x/api/account");

  const pw = mockJson({ ok: true });
  await postAccountPassword("http://x", "c", "old", "new");
  expect(pw.mock.calls[0][0]).toBe("http://x/api/account/password");
  expect(JSON.parse(pw.mock.calls[0][1].body)).toMatchObject({ current_password: "old", new_password: "new" });

  const gr = mockJson({ grants: [{ clientId: "mw_1", approvedScopes: ["openid"], updatedAt: null }] });
  expect((await getGrants("http://x")).grants?.length).toBe(1);
  expect(gr.mock.calls[0][0]).toBe("http://x/api/account/grants");

  const rv = mockJson({ ok: true });
  await revokeGrant("http://x", "c", "mw_1");
  expect(rv.mock.calls[0][0]).toBe("http://x/api/account/grants/revoke");

  const ul = mockJson({ ok: true });
  await unlinkTelegram("http://x", "c");
  expect(ul.mock.calls[0][0]).toBe("http://x/api/account/telegram/unlink");

  const rc = mockJson({ recoveryCodes: ["A", "B"] });
  expect((await regenerateRecoveryCodes("http://x", "c")).recoveryCodes?.length).toBe(2);
  expect(rc.mock.calls[0][0]).toBe("http://x/api/account/recovery-codes");
});

test("dashboard mutation helpers + tg kind + granular consent scopes", async () => {
  const del = mockJson({ ok: true });
  await deleteClient("http://x", "c", "mw_1");
  expect(del.mock.calls[0][0]).toBe("http://x/api/dev/clients/delete");

  const rot = mockJson({ ok: true, clientSecret: "mws_new" });
  expect((await rotateClientSecret("http://x", "c", "mw_1")).clientSecret).toBe("mws_new");
  expect(rot.mock.calls[0][0]).toBe("http://x/api/dev/clients/rotate-secret");

  const mt = mockJson({ token: "mgmt_t" });
  expect((await postManagementToken("http://x", "c")).token).toBe("mgmt_t");
  expect(mt.mock.calls[0][0]).toBe("http://x/api/dev/tokens");

  const tg = mockJson({ ticketId: "t", deepLink: "d" });
  await tgStart("http://x", "VERIFY_EXISTING");
  expect(JSON.parse(tg.mock.calls[0][1].body)).toEqual({ kind: "VERIFY_EXISTING" });

  const cons = mockJson({ redirect: "https://app/cb" });
  await postConsent("http://x", "allow", "c", ["openid", "profile"]);
  expect(JSON.parse(cons.mock.calls[0][1].body)).toMatchObject({ decision: "allow", scopes: "openid profile" });
});

test("nextLocation maps every action", () => {
  expect(nextLocation({ action: "redirect", url: "https://app/cb" })).toBe("https://app/cb");
  expect(nextLocation({ action: "redirect" })).toBe("/account"); // redirect without url falls through
  expect(nextLocation({ action: "consent" })).toBe("/consent");
  expect(nextLocation({ action: "verify_required" })).toBe("/verify");
  expect(nextLocation({ action: "done" })).toBe("/account");
  expect(nextLocation(undefined)).toBe("/account");
});

describe("authApi status-aware GET", () => {
  it("maps a 401 to {error:'no_session'} instead of parsing the body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    expect(await getAccount("https://api")).toEqual({ error: "no_session" });
  });
  it("maps a non-ok non-401 to {error:'http'}", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    expect(await getAccount("https://api")).toEqual({ error: "http" });
  });
  it("deleteAccount posts csrf + confirm", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await deleteAccount("https://api", "csrf1", "neko");
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ csrf: "csrf1", confirm: "neko" });
  });
});
