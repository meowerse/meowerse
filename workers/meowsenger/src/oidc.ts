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
  // 30-minute httpOnly txn cookie; consumed + cleared at /auth/callback.
  const cookie = `${TXN_COOKIE}=${encodeURIComponent(payload)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1800`;
  return new Response(null, { status: 302, headers: { Location: txn.url, "Set-Cookie": cookie } });
}

function redirectClearingTxn(location: string, extra: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const c of [clearCookie(TXN_COOKIE), ...extra]) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function bad(msg: string, req?: Request): Response {
  const isHtml = req?.headers.get("Accept")?.includes("text/html");
  if (isHtml) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — Meowerse</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #090a0f; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 1.5rem; box-sizing: border-box;
    }
    .card {
      background: #12131a; border: 1px solid #232533; border-radius: 12px; padding: 2rem;
      max-width: 400px; width: 100%; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
    p { color: #9496a8; font-size: 0.9375rem; line-height: 1.5; margin: 0 0 1.5rem; }
    .btn {
      display: inline-block; width: 100%; box-sizing: border-box; padding: 0.75rem 1rem;
      background: #4f46e5; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 500;
    }
    .btn:hover { background: #4338ca; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Login session expired</h1>
    <p>Your authentication request timed out or cookies were reset. Please sign in again to continue.</p>
    <a href="/auth/login" class="btn">Sign in with Meowerse</a>
  </div>
</body>
</html>`;
    const headers = new Headers({
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": clearCookie(TXN_COOKIE),
    });
    return new Response(html, { status: 400, headers });
  }

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
  const isHtml = req.headers.get("Accept")?.includes("text/html");

  if (!code || !state || !txnRaw) {
    // If the browser doesn't have the transaction cookie (e.g. login took longer than
    // cookie TTL, was initiated in another tab, or cookies reset), redirect to /auth/login
    // to restart the handshake. If the user already authenticated with the IdP, this
    // completes seamlessly in one roundtrip.
    if (isHtml && !url.searchParams.has("retry")) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${env.WEB_ORIGIN}/auth/login?retry=1`,
          "Set-Cookie": clearCookie(TXN_COOKIE),
        },
      });
    }
    return bad("missing_params", req);
  }

  let txn: { state: string; nonce: string; codeVerifier: string };
  try { txn = JSON.parse(decodeURIComponent(txnRaw)); } catch { return bad("bad_txn", req); }
  if (txn.state !== state) {
    if (isHtml && !url.searchParams.has("retry")) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${env.WEB_ORIGIN}/auth/login?retry=1`,
          "Set-Cookie": clearCookie(TXN_COOKIE),
        },
      });
    }
    return bad("state_mismatch", req);
  }

  let step = "exchange";
  try {
    const auth = deps.auth();
    const tok = await auth.exchangeCode({ code, codeVerifier: txn.codeVerifier });
    if (tok.error || !tok.access_token || !tok.id_token) return bad("exchange_failed:" + (tok.error ?? "no_token"), req);

    step = "verify";
    const claims = await auth.verifyIdToken(tok.id_token, { nonce: txn.nonce });
    const sub = String(claims.sub);

    // Profile claims live in /userinfo (not the id_token). Fetch with the access token.
    step = "userinfo";
    const uiRes = await deps.fetchFn(`${env.OIDC_ISSUER}/userinfo`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!uiRes.ok) return bad("userinfo_failed:" + uiRes.status, req);
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
    return bad("callback_error@" + step, req);
  }
}
