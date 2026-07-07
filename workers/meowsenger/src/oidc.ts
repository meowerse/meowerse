import type { AuthClient } from "@meowerse/auth";
import { createSession, sessionCookie, clearCookie, TXN_COOKIE } from "./session";
import type { Env } from "./types";
import type { Deps } from "./deps";
import { readCookies } from "./security";
import { upsertUser, type UserInfo } from "./users";

const SCOPES = "openid profile verified";

/** GET /auth/login — start Authorization-Code + PKCE, stash the txn in a cookie. */
export async function handleLogin(auth: AuthClient): Promise<Response> {
  const txn = await auth.buildAuthorizationUrl({ scope: SCOPES });
  const payload = JSON.stringify({ state: txn.state, nonce: txn.nonce, codeVerifier: txn.codeVerifier });
  // 10-minute httpOnly txn cookie; consumed + cleared at /auth/callback.
  const cookie = `${TXN_COOKIE}=${encodeURIComponent(payload)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
  return new Response(null, { status: 302, headers: { Location: txn.url, "Set-Cookie": cookie } });
}

function redirectClearingTxn(location: string, extra: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const c of [clearCookie(TXN_COOKIE), ...extra]) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}
function bad(msg: string): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", clearCookie(TXN_COOKIE));
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers });
}

/** GET /auth/callback — validate state, exchange code, fetch userinfo, upsert, create session. */
export async function handleCallback(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const txnRaw = readCookies(req.headers.get("Cookie"))[TXN_COOKIE];
  if (!code || !state || !txnRaw) return bad("missing_params");

  let txn: { state: string; nonce: string; codeVerifier: string };
  try { txn = JSON.parse(decodeURIComponent(txnRaw)); } catch { return bad("bad_txn"); }
  if (txn.state !== state) return bad("state_mismatch");

  let step = "exchange";
  try {
    const auth = deps.auth();
    const tok = await auth.exchangeCode({ code, codeVerifier: txn.codeVerifier });
    if (tok.error || !tok.access_token || !tok.id_token) return bad("exchange_failed:" + (tok.error ?? "no_token"));

    step = "verify";
    const claims = await auth.verifyIdToken(tok.id_token, { nonce: txn.nonce });
    const sub = String(claims.sub);

    // Profile claims live in /userinfo (not the id_token). Fetch with the access token.
    step = "userinfo";
    const uiRes = await deps.fetchFn(`${env.OIDC_ISSUER}/userinfo`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!uiRes.ok) return bad("userinfo_failed:" + uiRes.status);
    const info = (await uiRes.json()) as UserInfo;

    step = "db";
    const now = deps.now();
    const db = deps.getDb();
    await upsertUser(db, { ...info, sub, verified: info.verified ?? claims.verified === true }, now);
    const id = deps.newId();
    await createSession(db, {
      id, userId: sub, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? null,
      accessExp: now + (tok.expires_in ?? 0) * 1000, now,
    });

    return redirectClearingTxn(`${env.WEB_ORIGIN}/app`, [sessionCookie(id)]);
  } catch (e) {
    // Never a silent 500: log server-side (wrangler tail), return a generic step code.
    console.error("callback_error@" + step + ":", (e as Error)?.stack ?? String(e));
    return bad("callback_error@" + step);
  }
}
