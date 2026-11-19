import { test, expect } from "vitest";
import { handle, rlKey } from "../src/index";
import { genSigningKeys, memStore } from "./helpers";

async function fx(extra: Record<string, string> = {}) {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web", STATE_SECRET: "s", ...extra };
  return { store, env, deps: { getDb: () => store.db, clock: () => 1000 } };
}
const login = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://iss${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ username: "someone", password: "abcdefghijkl" }) });

test("M1: every rate-limit 429 carries Retry-After", async () => {
  const cases: [string, number, () => Request][] = [
    ["token", 120, () => new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })],
    ["authorize", 120, () => new Request("https://iss/authorize?client_id=x")],
    ["tgstatus", 120, () => new Request("https://iss/tg/status")],
    ["avatar", 120, () => new Request("https://iss/avatar/acct_x")],
    ["login", 10, () => login("/login")],
    ["signup", 20, () => login("/signup")],
    ["tgstart", 30, () => new Request("https://iss/tg/start", { method: "POST" })],
    ["tgverify", 30, () => new Request("https://iss/tg/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })],
  ];
  for (const [tag, limit, mk] of cases) {
    const { store, env, deps } = await fx();
    store.tables.rate_limits!.push({ bucket: `${tag}:` + (await rlKey(env as never, mk(), tag)), count: limit, window_start: 1000 });
    const r = await handle(mk(), env as never, deps as never);
    expect(r.status, tag).toBe(429);
    expect(Number(r.headers.get("Retry-After")), tag).toBeGreaterThan(0);
  }
});

test("M10: rate-limit buckets are keyed by HMAC, not unsalted sha256(IP|tag)", async () => {
  const { store, env, deps } = await fx();
  await handle(new Request("https://iss/authorize?client_id=x", { headers: { "CF-Connecting-IP": "203.0.113.9" } }), env as never, deps as never);
  const b = String(store.tables.rate_limits![0]!.bucket);
  const { sha256Hex } = await import("../src/crypto");
  expect(b).not.toBe("authorize:" + (await sha256Hex("203.0.113.9|authorize")));
  // a different secret yields a different key
  const k1 = await rlKey(env as never, new Request("https://iss/", { headers: { "CF-Connecting-IP": "1.2.3.4" } }), "login");
  const k2 = await rlKey({ ...env, STATE_SECRET: "other" } as never, new Request("https://iss/", { headers: { "CF-Connecting-IP": "1.2.3.4" } }), "login");
  expect(k1).not.toBe(k2);
});

test("M4: login/signup reject a foreign, opaque or cross-site Origin; same-origin, UI origin and no Origin pass the guard", async () => {
  for (const path of ["/login", "/signup"]) {
    for (const h of [{ Origin: "https://evil.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "http://localhost:9999" }]) {
      const { env, deps } = await fx();
      const r = await handle(login(path, h), env as never, deps as never);
      expect(r.status, `${path} ${JSON.stringify(h)}`).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe("bad_origin");
    }
    for (const h of [{ Origin: "https://iss" }, { Origin: "https://web" }, {}]) {
      const { env, deps } = await fx();
      const r = await handle(login(path, h), env as never, deps as never);
      expect(r.status, `${path} ${JSON.stringify(h)}`).not.toBe(403);
    }
  }
});

test("M9: production-like config without STATE_SECRET fails closed (no fallback); dev/test config still works", async () => {
  const keys = JSON.stringify(await genSigningKeys());
  const mk = async (env: Record<string, string>) => {
    const store = memStore();
    return handle(new Request("https://auth.alxnko.dev/authorize?client_id=mw_demo&redirect_uri=http%3A%2F%2Flocalhost%3A4321%2Fcallback&response_type=code&scope=openid&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"), env as never, { getDb: () => store.db, clock: () => 1000 } as never);
  };
  // `handle` throws; the default fetch wrapper turns that into a 500. Nothing is ever signed with a fallback secret.
  await expect(mk({ AUTH_SIGNING_KEYS: keys, ISSUER: "https://auth.alxnko.dev" })).rejects.toThrow("STATE_SECRET");
  await expect(mk({ AUTH_SIGNING_KEYS: keys })).rejects.toThrow("STATE_SECRET");
  await expect(mk({ AUTH_SIGNING_KEYS: keys, ISSUER: "https://iss", SKIP_MIGRATIONS: "1" })).rejects.toThrow("STATE_SECRET");
  // No "looks like production" heuristic: a staging-style issuer without STATE_SECRET also fails closed.
  await expect(mk({ AUTH_SIGNING_KEYS: keys, ISSUER: "https://staging.example.test" })).rejects.toThrow("STATE_SECRET");
  const withSecret = await mk({ AUTH_SIGNING_KEYS: keys, ISSUER: "https://auth.alxnko.dev", STATE_SECRET: "x" });
  expect(withSecret.status).toBe(302);
  const dev = await mk({ AUTH_SIGNING_KEYS: keys, ISSUER: "http://localhost:8787", AUTH_DEV: "1" });
  expect(dev.status).toBe(302);
});
