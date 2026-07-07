import type { AuthClient } from "@meowerse/auth";
import { TXN_COOKIE } from "./session";

const SCOPES = "openid profile verified";

/** GET /auth/login — start Authorization-Code + PKCE, stash the txn in a cookie. */
export async function handleLogin(auth: AuthClient): Promise<Response> {
  const txn = await auth.buildAuthorizationUrl({ scope: SCOPES });
  const payload = JSON.stringify({ state: txn.state, nonce: txn.nonce, codeVerifier: txn.codeVerifier });
  // 10-minute httpOnly txn cookie; consumed + cleared at /auth/callback.
  const cookie = `${TXN_COOKIE}=${encodeURIComponent(payload)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
  return new Response(null, { status: 302, headers: { Location: txn.url, "Set-Cookie": cookie } });
}
