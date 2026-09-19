import type { Env } from "./types";
import { type Deps, ensureSchema, prodDeps } from "./db";
import { corsHeaders, securityHeaders, hostCookie, clearHostCookie, parseCookies, validateCsrf, randomId } from "./security";
import { sha256Hex } from "./crypto";
import { parseSigningKeys, getActiveKey, buildJwks } from "./keys";
import { verifyJwt } from "./jwt";
import { discoveryDoc } from "./oidc";
import { getClient, authenticateClient } from "./clients";
import {
  parseAuthorizeQuery,
  validateAuthorizeParams,
  signRequest,
  verifyRequest,
  type AuthorizeRequest,
} from "./authorize";
import { signup, loginVerify, deriveVerified, DEFAULT_DUMMY_PHC, getAccountInfo, getAccountDetail, changePassword, regenerateRecoveryCodes, deleteAccount } from "./accounts";
import { issueSession, lookupSession, rotateSession, revokeSession, whoami, rollIdle } from "./session";
import { consentDecision, getConsent, grantConsent, listGrants, revokeGrant } from "./consent";
import { createAuthCode, exchangeCode, mintTokens, accessTokenInsert, revokeAccessToken, introspect } from "./token";
import { refreshTokenInsert, rotateRefresh } from "./refresh";
import {
  verifyLoginWidget,
  verifyInternalConfirm,
  signInOrSignUpTelegram,
  linkTelegramToAccount,
  createTicket,
  findPendingTicketByNonce,
  consumeTicket,
  getTicket,
  unlinkTelegram,
  TICKET_TTL,
} from "./telegram";
import { constantTimeEqual, b64urlDecode } from "@meowerse/auth-shared";
import {
  createClient,
  listClients,
  deleteClient,
  rotateSecret,
  updateClient,
  createManagementToken,
  verifyManagementToken,
  upsertClientByName,
} from "./dashboard";
import { userinfoClaims } from "./userinfo";
import { handleAvatar } from "./avatar";
import { checkRateLimit } from "./ratelimit";
import { turnstileGate } from "./turnstile";

const TKT_TTL = 900; // signed authorize request object lifetime (seconds)
const SESS_COOKIE = "mw_sess";
const TKT_COOKIE = "mw_tkt";

const SECURITY_TXT = `Contact: mailto:Alexnekokyn@gmail.com
Expires: 2027-12-31T23:59:59.000Z
Preferred-Languages: en, ru
Canonical: https://auth.alxnko.dev/.well-known/security.txt
Policy: https://auth.alxnko.dev/privacy
`;

const ROBOTS_TXT = `User-agent: *
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: ChatGPT-User
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: anthropic-ai
Disallow: /

User-agent: Claude-Web
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Google-Extended
Disallow: /
`;

function now(deps: Deps): number {
  return deps.clock ? deps.clock() : Math.floor(Date.now() / 1000);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function htmlError(status: number, message: string, cors: Record<string, string>): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Auth error</title></head><body><h1>Authorization error</h1><p>${message}</p></body></html>`;
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(), ...cors } });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...headers } });
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("Content-Type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const body = (await req.json()) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) if (v != null) out[k] = String(v);
      return out;
    }
    const form = await req.formData();
    const out: Record<string, string> = {};
    for (const [k, v] of form.entries()) out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

/** Append query params to a (validated) redirect_uri. */
function appendParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

function issuer(env: Env): string {
  return env.ISSUER ?? "https://auth.alxnko.dev";
}
function webOrigin(env: Env): string {
  return env.WEB_ORIGIN ?? "https://auth.alxnko.dev";
}
function stateSecret(env: Env): string {
  return env.STATE_SECRET ?? env.AUTH_SIGNING_KEYS ?? "dev-state-secret";
}

interface Signing {
  active: { kid: string; key: CryptoKey };
  jwks: { keys: JsonWebKey[] };
}
// Memoize per isolate, keyed by the raw key material: parsing the JWK set +
// importing the CryptoKey + building the JWKS ran on EVERY /token, /userinfo and
// /jwks call. Keys only change on a secret rotation (which restarts the isolate
// with a new AUTH_SIGNING_KEYS), so the string key also self-invalidates.
let signingCache: { keysStr: string; signing: Signing } | null = null;
async function getSigning(env: Env): Promise<Signing> {
  const keysStr = env.AUTH_SIGNING_KEYS ?? "[]";
  if (signingCache && signingCache.keysStr === keysStr) return signingCache.signing;
  const keys = parseSigningKeys(keysStr);
  const signing = { active: await getActiveKey(keys), jwks: buildJwks(keys) };
  signingCache = { keysStr, signing };
  return signing;
}

/** Mint a code for an authenticated+consented request and return the redirect URL. */
async function mintCodeRedirect(
  deps: Deps,
  env: Env,
  request: AuthorizeRequest,
  accountId: string,
  sessionIdHash: string,
  authTime: number,
  scope: string[],
): Promise<string> {
  const code = await createAuthCode(deps.getDb(), {
    request,
    accountId,
    sessionIdHash,
    scope,
    authTime,
    now: now(deps),
  });
  return appendParams(request.redirectUri, { code, state: request.state, iss: issuer(env) });
}

interface NextStep {
  action: "done" | "redirect" | "consent" | "verify_required";
  url?: string;
  client?: { name: string; logo: string | null };
  scope?: string[];
}

/**
 * After login/signup, resolve what happens next given the pending authorize
 * request (in the __Host-mw_tkt cookie) and the now-authenticated session.
 */
async function resolveNext(deps: Deps, env: Env, tkt: string | undefined, accountId: string, sessionIdHash: string, authTime: number): Promise<NextStep> {
  if (!tkt) return { action: "done" };
  const envlp = await verifyRequest(tkt, stateSecret(env), now(deps));
  if (!envlp) return { action: "done" };
  const request = envlp.r;
  const db = deps.getDb();
  const client = await getClient(db, request.clientId);
  if (!client || client.status !== "active") return { action: "done" };
  // `verified` only affects the decision when it can matter (verified-only client,
  // or the `verified` scope is in play). Otherwise skip the standalone Turso hop.
  const verified =
    client.verifiedOnly || request.scope.includes("verified") ? await deriveVerified(db, accountId) : false;
  const consent = await getConsent(db, accountId, request.clientId);
  const decision = consentDecision({
    requested: request.scope,
    clientAllowed: client.allowedScopes,
    priorConsentScopes: consent?.approvedSnapshot ?? null,
    priorMax: consent?.scopeSetMax ?? null,
    prompt: request.prompt,
    verifiedOnly: client.verifiedOnly,
    userVerified: verified,
    firstParty: client.firstParty,
  });
  if (decision.action === "verify_upgrade") return { action: "verify_required" };
  if (decision.action === "silent") {
    const url = await mintCodeRedirect(deps, env, request, accountId, sessionIdHash, authTime, decision.scope);
    return { action: "redirect", url };
  }
  return { action: "consent", client: { name: client.displayName ?? client.clientId, logo: client.logoUrl }, scope: request.scope };
}

// --- Route handlers ---------------------------------------------------------

async function handleAuthorize(req: Request, env: Env, deps: Deps, cors: Record<string, string>, ctx?: ExecutionContext): Promise<Response> {
  // Cheap in-worker second line behind the edge WAF (same shape as /token).
  if (!(await ipThrottle(req, deps, "authorize", 120, 60))) return json({ error: "rate_limited" }, 429, cors);
  const url = new URL(req.url);
  const params = parseAuthorizeQuery(url);
  const db = deps.getDb();
  const client = await getClient(db, params.client_id);
  const v = validateAuthorizeParams(params, client);

  if (v.kind === "fatal") return htmlError(400, `Invalid request: ${v.reason}.`, cors);
  if (v.kind === "redirect_error") {
    return redirect(appendParams(params.redirect_uri, { error: v.error, state: v.state, iss: issuer(env) }), securityHeaders());
  }

  const request = v.request;
  const cookies = parseCookies(req.headers.get("Cookie"));
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps), ctx);
  const promptNone = (request.prompt ?? "").split(/\s+/).includes("none");

  if (session) {
    const verified =
      client!.verifiedOnly || request.scope.includes("verified") ? await deriveVerified(db, session.accountId) : false;
    const consent = await getConsent(db, session.accountId, request.clientId);
    const decision = consentDecision({
      requested: request.scope,
      clientAllowed: client!.allowedScopes,
      priorConsentScopes: consent?.approvedSnapshot ?? null,
      priorMax: consent?.scopeSetMax ?? null,
      prompt: request.prompt,
      verifiedOnly: client!.verifiedOnly,
      userVerified: verified,
      firstParty: client!.firstParty,
    });
    if (decision.action === "silent") {
      const idHash = await sha256Hex(cookies[`__Host-${SESS_COOKIE}`]!);
      const loc = await mintCodeRedirect(deps, env, request, session.accountId, idHash, session.authTime, decision.scope);
      return redirect(loc, securityHeaders());
    }
    if (promptNone) {
      const error = decision.action === "verify_upgrade" ? "interaction_required" : "consent_required";
      return redirect(appendParams(request.redirectUri, { error, state: request.state, iss: issuer(env) }), securityHeaders());
    }
    // needs consent or verify-upgrade → carry the request to the UI
    const tkt = await signRequest({ r: request, o: randomId(16), exp: now(deps) + TKT_TTL }, stateSecret(env));
    const dest = decision.action === "verify_upgrade" ? "/verify" : "/consent";
    return redirect(`${webOrigin(env)}${dest}`, { ...securityHeaders(), "Set-Cookie": hostCookie(TKT_COOKIE, tkt, { maxAge: TKT_TTL }) });
  }

  if (promptNone) {
    return redirect(appendParams(request.redirectUri, { error: "login_required", state: request.state, iss: issuer(env) }), securityHeaders());
  }
  // logged out → stash request, send to the login UI
  const tkt = await signRequest({ r: request, o: randomId(16), exp: now(deps) + TKT_TTL }, stateSecret(env));
  return redirect(`${webOrigin(env)}/login`, { ...securityHeaders(), "Set-Cookie": hostCookie(TKT_COOKIE, tkt, { maxAge: TKT_TTL }) });
}

async function handleSignup(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const p = await readParams(req);
  const db = deps.getDb();
  const ipHash = await sha256Hex((req.headers.get("CF-Connecting-IP") ?? "") + "|signup");
  const rl = await checkRateLimit(db, `signup:${ipHash}`, { limit: 20, windowSec: 3600, now: now(deps) });
  if (!rl.allowed) return json({ error: "rate_limited" }, 429, cors);
  // Bot gate (before the expensive PBKDF2). No-op unless TURNSTILE_SECRET_KEY is set.
  if (!(await turnstileGate(env, p, req.headers.get("CF-Connecting-IP"), deps.fetch))) {
    return json({ error: "turnstile_failed" }, 403, cors);
  }

  const res = await signup(db, { username: p.username ?? "", password: p.password ?? "", displayName: p.displayName });
  if (!res.ok) return json({ error: res.error }, 400, cors);

  const sess = await issueSession(db, { accountId: res.accountId, amr: "pwd", authTime: now(deps), now: now(deps) });
  const cookies = parseCookies(req.headers.get("Cookie"));
  const next = await resolveNext(deps, env, cookies[`__Host-${TKT_COOKIE}`], res.accountId, sess.idHash, now(deps));
  return json({ ok: true, recoveryCodes: res.recoveryCodes, csrf: sess.csrf, next }, 200, {
    ...cors,
    ...securityHeaders(),
    "Set-Cookie": hostCookie(SESS_COOKIE, sess.rawId, { maxAge: 30 * 24 * 3600 }),
  });
}

async function handleLogin(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const p = await readParams(req);
  const db = deps.getDb();
  // Bot gate FIRST, so a gated bot never reaches (or writes to) the rate_limits
  // table. No-op unless TURNSTILE_SECRET_KEY is set.
  if (!(await turnstileGate(env, p, req.headers.get("CF-Connecting-IP"), deps.fetch))) {
    return json({ error: "turnstile_failed" }, 403, cors);
  }
  // Key the limiter on the CLIENT IP, not sha256(username): a username-keyed bucket
  // lets an attacker mint unbounded distinct rows (write amplification) and lock
  // out victims by username; per-IP bounds the write surface and the abuser.
  const ipHash = await sha256Hex((req.headers.get("CF-Connecting-IP") ?? "") + "|login");
  const rl = await checkRateLimit(db, `login:${ipHash}`, { limit: 10, windowSec: 900, now: now(deps) });
  if (!rl.allowed) return json({ error: "rate_limited" }, 429, cors);

  const res = await loginVerify(db, { username: p.username ?? "", password: p.password ?? "" }, { dummyPhc: DEFAULT_DUMMY_PHC });
  if (!res.ok) return json({ error: "invalid_credentials" }, 401, cors);

  const cookies = parseCookies(req.headers.get("Cookie"));
  const existing = cookies[`__Host-${SESS_COOKIE}`];
  const sess = existing
    ? (await rotateSession(db, existing, { now: now(deps), authTime: now(deps) })) ??
      (await issueSession(db, { accountId: res.accountId, amr: "pwd", authTime: now(deps), now: now(deps) }))
    : await issueSession(db, { accountId: res.accountId, amr: "pwd", authTime: now(deps), now: now(deps) });

  const next = await resolveNext(deps, env, cookies[`__Host-${TKT_COOKIE}`], res.accountId, sess.idHash, now(deps));
  return json({ ok: true, csrf: sess.csrf, next }, 200, {
    ...cors,
    ...securityHeaders(),
    "Set-Cookie": hostCookie(SESS_COOKIE, sess.rawId, { maxAge: 30 * 24 * 3600 }),
  });
}

async function handleConsent(req: Request, env: Env, deps: Deps, cors: Record<string, string>, ctx?: ExecutionContext): Promise<Response> {
  const p = await readParams(req);
  const db = deps.getDb();
  const cookies = parseCookies(req.headers.get("Cookie"));
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps), ctx);
  if (!session) return json({ error: "no_session" }, 401, cors);
  if (!validateCsrf(p.csrf ?? "", session.csrf)) return json({ error: "bad_csrf" }, 403, cors);

  const tkt = cookies[`__Host-${TKT_COOKIE}`];
  const envlp = tkt ? await verifyRequest(tkt, stateSecret(env), now(deps)) : null;
  if (!envlp) return json({ error: "no_request" }, 400, cors);
  const request = envlp.r;
  const client = await getClient(db, request.clientId);
  if (!client || client.status !== "active") return json({ error: "unknown_client" }, 400, cors);

  const clearTkt = clearHostCookie(TKT_COOKIE);
  if (p.decision !== "allow") {
    const loc = appendParams(request.redirectUri, { error: "access_denied", state: request.state, iss: issuer(env) });
    return json({ redirect: loc }, 200, { ...cors, ...securityHeaders(), "Set-Cookie": clearTkt });
  }

  // Only verified-only clients gate on `verified` here → skip the hop otherwise.
  const verified = client.verifiedOnly ? await deriveVerified(db, session.accountId) : false;
  if (client.verifiedOnly && !verified) return json({ error: "verification_required" }, 403, cors);
  // Granular consent (R20): grant only the scopes the user checked. `openid` is
  // always kept; absent `scopes` means accept-all (backward compatible).
  const approvedRaw = p.scopes !== undefined ? splitList(p.scopes) : request.scope;
  const approved = request.scope.filter((s) => s === "openid" || approvedRaw.includes(s));
  const consent = await getConsent(db, session.accountId, request.clientId);
  const scope = await grantConsent(db, {
    accountId: session.accountId,
    clientId: request.clientId,
    requested: approved,
    clientAllowed: client.allowedScopes,
    priorMax: consent?.scopeSetMax ?? null,
  });
  const idHash = await sha256Hex(cookies[`__Host-${SESS_COOKIE}`]!);
  const loc = await mintCodeRedirect(deps, env, request, session.accountId, idHash, session.authTime, scope);
  return json({ redirect: loc }, 200, { ...cors, ...securityHeaders(), "Set-Cookie": clearTkt });
}

/** GET the pending authorize request so the consent UI can render it on a fresh load. */
async function handlePending(req: Request, env: Env, deps: Deps, cors: Record<string, string>, ctx?: ExecutionContext): Promise<Response> {
  const db = deps.getDb();
  const cookies = parseCookies(req.headers.get("Cookie"));
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps), ctx);
  if (!session) return json({ error: "no_session" }, 401, cors);
  const tkt = cookies[`__Host-${TKT_COOKIE}`];
  const envlp = tkt ? await verifyRequest(tkt, stateSecret(env), now(deps)) : null;
  if (!envlp) return json({ error: "no_request" }, 400, cors);
  const client = await getClient(db, envlp.r.clientId);
  if (!client || client.status !== "active") return json({ error: "unknown_client" }, 400, cors);
  return json(
    { client: { name: client.displayName ?? client.clientId, logo: client.logoUrl }, scope: envlp.r.scope, csrf: session.csrf },
    200,
    { ...cors, ...securityHeaders() },
  );
}

/** Mint the token response (id+access, optional refresh) and persist the jti. */
async function mintResponse(
  env: Env,
  deps: Deps,
  cors: Record<string, string>,
  noStore: Record<string, string>,
  i: { accountId: string; clientId: string; scope: string[]; nonce: string | null; authTime: number; family: string; issueRefresh?: boolean; refreshToken?: string },
): Promise<Response> {
  const db = deps.getDb();
  // The id_token only carries `verified` when the `verified` scope was granted,
  // so only then is the standalone live-verified hop needed.
  const verified = i.scope.includes("verified") ? await deriveVerified(db, i.accountId) : false;
  const signing = await getSigning(env);
  const t = now(deps);
  const tokens = await mintTokens({
    accountId: i.accountId,
    clientId: i.clientId,
    scope: i.scope,
    nonce: i.nonce,
    authTime: i.authTime,
    verified,
    issuer: issuer(env),
    resourceAud: env.RESOURCE_AUD ?? "https://api.meow.alxnko.dev",
    signingKey: signing.active.key,
    kid: signing.active.kid,
    family: i.family,
    now: t,
  });
  const { jti: _jti, ...body } = tokens;
  void _jti;
  const accessStmt = accessTokenInsert({ jti: tokens.jti, accountId: i.accountId, clientId: i.clientId, scope: i.scope, family: i.family, now: t });
  let refresh = i.refreshToken;
  if (i.issueRefresh && !refresh) {
    // Offline-token pair: the access jti + the new refresh row are both known up
    // front (not a CAS) → one batch instead of two INSERT round-trips.
    const { stmt: refreshStmt, token } = await refreshTokenInsert({ accountId: i.accountId, clientId: i.clientId, scope: i.scope, family: i.family, now: t });
    refresh = token;
    await db.batch([accessStmt, refreshStmt]);
  } else {
    await db.execute(accessStmt);
  }
  return json(refresh ? { ...body, refresh_token: refresh } : body, 200, { ...cors, ...noStore });
}

/** Parse client credentials from HTTP Basic (RFC 6749 §2.3.1) or the request body. */
function parseClientAuth(req: Request, p: Record<string, string>): { clientId: string; clientSecret?: string } {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const i = decoded.indexOf(":");
      if (i >= 0) return { clientId: decodeURIComponent(decoded.slice(0, i)), clientSecret: decodeURIComponent(decoded.slice(i + 1)) };
    } catch {
      /* fall through to body */
    }
  }
  return { clientId: p.client_id ?? "", clientSecret: p.client_secret };
}

/** Per-IP write throttle behind the edge limiter (spec §10/#10). */
async function ipThrottle(req: Request, deps: Deps, tag: string, limit: number, windowSec: number): Promise<boolean> {
  const ipHash = await sha256Hex((req.headers.get("CF-Connecting-IP") ?? "") + "|" + tag);
  const rl = await checkRateLimit(deps.getDb(), `${tag}:${ipHash}`, { limit, windowSec, now: now(deps) });
  return rl.allowed;
}

async function handleToken(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const p = await readParams(req);
  const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };
  const db = deps.getDb();
  if (!(await ipThrottle(req, deps, "token", 120, 60))) return json({ error: "rate_limited" }, 429, { ...cors, ...noStore });
  const { clientId, clientSecret } = parseClientAuth(req, p);

  // Authenticate the client: confidential clients MUST present a valid secret;
  // public clients pass (PKCE is their proof). Closes the leaked-refresh-token
  // replay and "confidential isn't confidential" holes.
  const ca = await authenticateClient(db, clientId, clientSecret);
  if (!ca.ok) return json({ error: "invalid_client" }, 401, { ...cors, ...noStore, "WWW-Authenticate": "Basic" });

  if (p.grant_type === "authorization_code") {
    const ex = await exchangeCode(db, { code: p.code ?? "", verifier: p.code_verifier ?? "", clientId, redirectUri: p.redirect_uri ?? "", now: now(deps) });
    if (!ex.ok) return json({ error: ex.error }, 400, { ...cors, ...noStore });
    return mintResponse(env, deps, cors, noStore, {
      accountId: ex.accountId,
      clientId,
      scope: ex.scope,
      nonce: ex.nonce,
      authTime: ex.authTime,
      family: ex.family,
      issueRefresh: ex.scope.includes("offline_access"),
    });
  }

  if (p.grant_type === "refresh_token") {
    const rot = await rotateRefresh(db, { token: p.refresh_token ?? "", clientId, now: now(deps) });
    if (!rot.ok) return json({ error: rot.error }, 400, { ...cors, ...noStore });
    return mintResponse(env, deps, cors, noStore, {
      accountId: rot.accountId,
      clientId,
      scope: rot.scope,
      nonce: null,
      authTime: now(deps),
      family: rot.family,
      refreshToken: rot.newRefresh,
    });
  }

  return json({ error: "unsupported_grant_type" }, 400, { ...cors, ...noStore });
}

const TGOWN_COOKIE = "mw_tgown";

/** POST /tg/start — mint a deep-link ticket bound to this browser (spec §6). */
async function handleTgStart(req: Request, env: Env, deps: Deps, cors: Record<string, string>, ctx?: ExecutionContext): Promise<Response> {
  if (!(await ipThrottle(req, deps, "tgstart", 30, 600))) return json({ error: "rate_limited" }, 429, cors);
  const db = deps.getDb();
  const p = await readParams(req);
  const kind = p.kind === "VERIFY_EXISTING" ? "VERIFY_EXISTING" : "SIGNIN_OR_SIGNUP";
  const cookies = parseCookies(req.headers.get("Cookie"));
  let accountId: string | null = null;
  if (kind === "VERIFY_EXISTING") {
    const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps), ctx);
    if (!session) return json({ error: "no_session" }, 401, cors);
    accountId = session.accountId;
  }
  const ownerSecret = randomId(32);
  const t = await createTicket(db, { kind, ownerHash: await sha256Hex(ownerSecret), accountId, now: now(deps) });
  const botUser = env.BOT_USERNAME ?? "meowerse_auth_bot";
  return json({ ticketId: t.ticketId, deepLink: `https://t.me/${botUser}?start=${t.nonce}` }, 200, {
    ...cors,
    ...securityHeaders(),
    "Set-Cookie": hostCookie(TGOWN_COOKIE, ownerSecret, { maxAge: TICKET_TTL }),
  });
}

/** POST /internal/tg/confirm — HMAC-signed callback from the auth-bot worker (no cookies). */
async function handleTgConfirm(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const body = await readParams(req);
  const sig = req.headers.get("X-Signature") ?? "";
  if (!env.INTERNAL_HMAC_KEY || !(await verifyInternalConfirm(body, sig, env.INTERNAL_HMAC_KEY, now(deps)))) {
    return json({ error: "unauthorized" }, 401, cors);
  }
  const db = deps.getDb();
  const ticket = await findPendingTicketByNonce(db, body.nonce ?? "", now(deps));
  if (!ticket) return json({ error: "invalid_ticket" }, 400, cors);
  const tg = {
    telegramId: body.telegram_id ?? "",
    username: body.username || null,
    displayName: body.display_name || null,
    avatarUrl: body.avatar_url || null,
  };
  let accountId: string;
  if (ticket.kind === "VERIFY_EXISTING") {
    if (!ticket.account_id) return json({ error: "invalid_ticket" }, 400, cors);
    const r = await linkTelegramToAccount(db, ticket.account_id, tg);
    if (!r.ok) return json({ error: r.error }, 409, cors);
    accountId = ticket.account_id;
  } else {
    accountId = (await signInOrSignUpTelegram(db, tg)).accountId;
  }
  if (!(await consumeTicket(db, ticket.ticket_id, accountId))) return json({ error: "already_consumed" }, 409, cors);
  return json({ ok: true }, 200, cors);
}

/** GET /tg/status?ticket=ID — owner-bound poll; on consume, issue the session. */
async function handleTgStatus(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  // Cheap in-worker second line for the poll endpoint (same shape as /token).
  if (!(await ipThrottle(req, deps, "tgstatus", 120, 60))) return json({ error: "rate_limited" }, 429, cors);
  const db = deps.getDb();
  const ticketId = new URL(req.url).searchParams.get("ticket") ?? "";
  const cookies = parseCookies(req.headers.get("Cookie"));
  const owner = cookies[`__Host-${TGOWN_COOKIE}`];
  const ticket = await getTicket(db, ticketId);
  // owner mismatch / unconsumed → "not ready" (never leak; ticket_id grants nothing)
  if (!ticket || !owner || !constantTimeEqual(await sha256Hex(owner), ticket.owner_hash)) return json({ ready: false }, 200, cors);
  if (ticket.status !== "consumed" || !ticket.account_id) return json({ ready: false }, 200, cors);
  const sess = await issueSession(db, { accountId: ticket.account_id, amr: "tg", authTime: now(deps), now: now(deps) });
  const next = await resolveNext(deps, env, cookies[`__Host-${TKT_COOKIE}`], ticket.account_id, sess.idHash, now(deps));
  return json({ ready: true, csrf: sess.csrf, next }, 200, {
    ...cors,
    ...securityHeaders(),
    "Set-Cookie": hostCookie(SESS_COOKIE, sess.rawId, { maxAge: 30 * 24 * 3600 }),
  });
}

/** POST /tg/widget — Telegram Login Widget sign-in/up. */
async function handleTgWidget(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const data = await readParams(req);
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "telegram_unconfigured" }, 503, cors);
  const v = await verifyLoginWidget(data, env.TELEGRAM_BOT_TOKEN, now(deps));
  if (!v.ok || !v.telegram) return json({ error: "invalid" }, 401, cors);
  const db = deps.getDb();
  const r = await signInOrSignUpTelegram(db, v.telegram);
  const sess = await issueSession(db, { accountId: r.accountId, amr: "tg", authTime: now(deps), now: now(deps) });
  const cookies = parseCookies(req.headers.get("Cookie"));
  const next = await resolveNext(deps, env, cookies[`__Host-${TKT_COOKIE}`], r.accountId, sess.idHash, now(deps));
  return json({ ok: true, csrf: sess.csrf, next }, 200, {
    ...cors,
    ...securityHeaders(),
    "Set-Cookie": hostCookie(SESS_COOKIE, sess.rawId, { maxAge: 30 * 24 * 3600 }),
  });
}

async function handleUserinfo(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" };
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "invalid_token" }, 401, { ...cors, ...noStore });
  const resourceAud = env.RESOURCE_AUD ?? "https://api.meow.alxnko.dev";
  try {
    const signing = await getSigning(env);
    const { header, payload } = await verifyJwt(token, signing.jwks, { iss: issuer(env), aud: resourceAud, now: now(deps) });
    const res = await userinfoClaims(deps.getDb(), { header, payload, resourceAud, issuer: issuer(env) });
    if (!res.ok) return json({ error: "invalid_token" }, 401, { ...cors, ...noStore });
    return json(res.claims, 200, { ...cors, ...noStore });
  } catch {
    return json({ error: "invalid_token" }, 401, { ...cors, ...noStore });
  }
}

/** Best-effort decode of a JWT payload — NO signature check (see resolvePostLogout). */
function decodeJwtPayload(jwt: string | null): Record<string, unknown> | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]!))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * OIDC RP-Initiated Logout return target. We use the client's registered
 * redirect_uris as the post-logout allowlist. `id_token_hint` is only a HINT to
 * pick WHICH client's allowlist to consult — it is not trusted as a credential,
 * so its signature isn't verified: the real guard is allowlist membership, and
 * redirect_uris are owner-controlled URLs already trusted for that client. An
 * attacker can only land the user on a URL some legitimate client registered.
 * ponytail: reuses redirect_uris as the allowlist; add a dedicated
 * post_logout_redirect_uris table only if apps need distinct logout URLs.
 */
async function resolvePostLogout(deps: Deps, hint: string | null, uri: string | null, state: string | null): Promise<string | null> {
  if (!uri) return null;
  const payload = decodeJwtPayload(hint);
  const clientId = typeof payload?.aud === "string" ? payload.aud : typeof payload?.azp === "string" ? payload.azp : null;
  if (!clientId) return null;
  const client = await getClient(deps.getDb(), clientId);
  if (!client || client.status !== "active" || !client.redirectUris.includes(uri)) return null;
  return state ? appendParams(uri, { state }) : uri;
}

async function handleLogout(req: Request, env: Env, deps: Deps, _cors: Record<string, string>): Promise<Response> {
  const url = new URL(req.url);
  const cookies = parseCookies(req.headers.get("Cookie"));
  const raw = cookies[`__Host-${SESS_COOKIE}`];
  if (raw) await revokeSession(deps.getDb(), raw);
  const dest =
    (await resolvePostLogout(
      deps,
      url.searchParams.get("id_token_hint"),
      url.searchParams.get("post_logout_redirect_uri"),
      url.searchParams.get("state"),
    )) ?? webOrigin(env);
  return redirect(dest, { ...securityHeaders(), "Set-Cookie": clearHostCookie(SESS_COOKIE) });
}

// Revoke/introspect are confidential-client-only (RFC 7009/7662 require client
// auth). This closes the cross-client token oracle + revoke-by-jti DoS.
async function authedConfidentialClient(req: Request, deps: Deps, p: Record<string, string>): Promise<string | null> {
  const { clientId, clientSecret } = parseClientAuth(req, p);
  const ca = await authenticateClient(deps.getDb(), clientId, clientSecret);
  return ca.ok && ca.clientType === "confidential" ? clientId : null;
}

async function handleRevoke(req: Request, _env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const p = await readParams(req);
  const clientId = await authedConfidentialClient(req, deps, p);
  if (!clientId) return json({ error: "invalid_client" }, 401, { ...cors, "WWW-Authenticate": "Basic" });
  if (p.token) await revokeAccessToken(deps.getDb(), p.token, clientId);
  return json({}, 200, cors); // RFC 7009: always 200 after client auth
}

async function handleIntrospect(req: Request, _env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const p = await readParams(req);
  const clientId = await authedConfidentialClient(req, deps, p);
  if (!clientId) return json({ error: "invalid_client" }, 401, { ...cors, "WWW-Authenticate": "Basic" });
  const res = p.token ? await introspect(deps.getDb(), p.token, now(deps), clientId) : { active: false };
  return json(res, 200, cors);
}

function splitList(v: string | undefined): string[] {
  return (v ?? "").split(/[\s,]+/).filter(Boolean);
}
function asBool(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

/** Developer dashboard API (session-authed, owner-scoped). Spec §8. */
async function handleDev(req: Request, env: Env, deps: Deps, cors: Record<string, string>, sub: string, ctx?: ExecutionContext): Promise<Response> {
  const db = deps.getDb();
  const cookies = parseCookies(req.headers.get("Cookie"));
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps), ctx);
  if (!session) return json({ error: "no_session" }, 401, cors);

  if (sub === "clients" && req.method === "GET") {
    return json({ clients: await listClients(db, session.accountId), csrf: session.csrf }, 200, { ...cors, ...securityHeaders() });
  }
  const p = await readParams(req);
  if (!validateCsrf(p.csrf ?? "", session.csrf)) return json({ error: "bad_csrf" }, 403, cors);

  if (sub === "clients") {
    const res = await createClient(db, {
      ownerId: session.accountId,
      name: p.name ?? "",
      displayName: p.display_name,
      clientType: p.client_type ?? "public",
      redirectUris: splitList(p.redirect_uris),
      allowedScopes: splitList(p.scopes),
      verifiedOnly: asBool(p.verified_only),
      allowOfflineAccess: asBool(p.offline),
    });
    return res.ok ? json(res, 200, { ...cors, ...securityHeaders() }) : json({ error: res.error }, 400, cors);
  }
  if (sub === "clients/delete") {
    return json({ ok: await deleteClient(db, session.accountId, p.client_id ?? "") }, 200, cors);
  }
  if (sub === "clients/rotate-secret") {
    const r = await rotateSecret(db, session.accountId, p.client_id ?? "");
    return r.ok ? json(r, 200, { ...cors, ...securityHeaders() }) : json({ error: "not_rotatable" }, 400, cors);
  }
  if (sub === "clients/update") {
    const r = await updateClient(db, session.accountId, {
      clientId: p.client_id ?? "",
      redirectUris: p.redirect_uris !== undefined ? splitList(p.redirect_uris) : undefined,
      allowedScopes: p.scopes !== undefined ? splitList(p.scopes) : undefined,
      verifiedOnly: p.verified_only !== undefined ? asBool(p.verified_only) : undefined,
      displayName: p.display_name,
    });
    return r.ok ? json({ ok: true }, 200, cors) : json({ error: r.error }, 400, cors);
  }
  if (sub === "tokens") {
    const token = await createManagementToken(db, session.accountId, p.label);
    return json({ token }, 200, { ...cors, ...securityHeaders() });
  }
  return json({ error: "not_found" }, 404, cors);
}

/** Run a side-effect off the response path when we have an ExecutionContext
 *  (prod), else just fire it (tests) — never block the response on it. */
function defer(ctx: ExecutionContext | undefined, p: Promise<unknown>): void {
  if (ctx) ctx.waitUntil(p);
  else void Promise.resolve(p).catch(() => {});
}

/** Cheap whoami for the web header + client route guards. Always 200. One
 *  collapsed query validates the session + reads the display fields + live
 *  `verified`; the idle-window roll is fired off the response path. */
async function handleSession(req: Request, env: Env, deps: Deps, cors: Record<string, string>, ctx?: ExecutionContext): Promise<Response> {
  const db = deps.getDb();
  const t = now(deps);
  const who = await whoami(db, parseCookies(req.headers.get("Cookie"))[`__Host-${SESS_COOKIE}`], t);
  if (!who) return json({ authenticated: false }, 200, { ...cors, ...securityHeaders() });
  defer(ctx, rollIdle(db, who.idHash, t)); // keep-alive write, off the critical path
  return json(
    { authenticated: true, username: who.username ?? who.displayName ?? "you", verified: who.verified },
    200,
    { ...cors, ...securityHeaders() },
  );
}

/** End-user account self-service (session+CSRF authed, owner = the session). Spec R14. */
async function handleAccount(req: Request, env: Env, deps: Deps, cors: Record<string, string>, sub: string, ctx?: ExecutionContext): Promise<Response> {
  const db = deps.getDb();
  const cookies = parseCookies(req.headers.get("Cookie"));
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps), ctx);
  if (!session) return json({ error: "no_session" }, 401, cors);
  const accountId = session.accountId;

  if (sub === "" && req.method === "GET") {
    const detail = await getAccountDetail(db, accountId); // profile + verified + telegram + recovery in ONE query
    if (!detail) return json({ error: "not_found" }, 404, cors);
    return json({ ...detail, csrf: session.csrf }, 200, { ...cors, ...securityHeaders() });
  }
  if (sub === "grants" && req.method === "GET") {
    return json({ grants: await listGrants(db, accountId) }, 200, { ...cors, ...securityHeaders() });
  }

  const p = await readParams(req);
  if (!validateCsrf(p.csrf ?? "", session.csrf)) return json({ error: "bad_csrf" }, 403, cors);

  if (sub === "password") {
    const r = await changePassword(db, { accountId, currentPassword: p.current_password ?? "", newPassword: p.new_password ?? "" });
    return r.ok ? json({ ok: true }, 200, cors) : json({ error: r.error }, 400, cors);
  }
  if (sub === "grants/revoke") {
    await revokeGrant(db, accountId, p.client_id ?? "");
    return json({ ok: true }, 200, cors);
  }
  if (sub === "telegram/unlink") {
    const info = await getAccountInfo(db, accountId);
    if (!info?.hasPassword) return json({ error: "no_password_fallback" }, 409, cors); // refuse → avoid lockout
    await unlinkTelegram(db, accountId);
    return json({ ok: true }, 200, cors);
  }
  if (sub === "recovery-codes") {
    return json({ recoveryCodes: await regenerateRecoveryCodes(db, accountId) }, 200, { ...cors, ...securityHeaders() });
  }
  if (sub === "delete") {
    const info = await getAccountInfo(db, accountId);
    if (!info) return json({ error: "not_found" }, 404, cors);
    const expected = info.username ?? info.displayName ?? "";
    if ((p.confirm ?? "") !== expected) return json({ error: "confirm_mismatch" }, 400, cors);
    await deleteAccount(db, accountId);
    return json({ ok: true }, 200, { ...cors, "Set-Cookie": clearHostCookie(SESS_COOKIE) });
  }
  return json({ error: "not_found" }, 404, cors);
}

/** Management API for config-as-code IaC (PAT-authed upsert by name). Spec §9. */
async function handleMgmt(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const ownerId = await verifyManagementToken(deps.getDb(), token);
  if (!ownerId) return json({ error: "unauthorized" }, 401, cors);
  const p = await readParams(req);
  const res = await upsertClientByName(deps.getDb(), ownerId, {
    name: p.name ?? "",
    displayName: p.display_name,
    clientType: p.client_type ?? "public",
    redirectUris: splitList(p.redirect_uris),
    allowedScopes: splitList(p.scopes),
    verifiedOnly: asBool(p.verified_only),
    allowOfflineAccess: asBool(p.offline),
  });
  return "error" in res ? json({ error: res.error }, 400, cors) : json(res, 200, { ...cors, ...securityHeaders() });
}

const CACHE_1H = { "Cache-Control": "public, max-age=3600" };
// /jwks + /.well-known/openid-configuration are public documents fetched cross-origin
// by every RP. Serve a PLAIN `Access-Control-Allow-Origin: *` (no credentials, no
// Vary: Origin) instead of reflected-origin CORS, so an edge cache can hold ONE
// copy for all origins without per-origin cache poisoning.
const PUBLIC_CORS = { "Access-Control-Allow-Origin": "*" };

/**
 * Thin DI router (mirrors workers/api). `deps` is injectable so tests pass a
 * fake db + fixed clock; production builds it from env once per request.
 */
export async function handle(req: Request, env: Env, deps: Deps, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  if (url.hostname.endsWith(".alxnko.eu.org")) {
    const newHost = url.hostname.replace(/\.alxnko\.eu\.org$/, ".alxnko.dev");
    const dest = new URL(url.pathname + url.search, `https://${newHost}`);
    return new Response(null, {
      status: 301,
      headers: {
        Location: dest.toString(),
        "Cache-Control": "public, max-age=86400",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
      },
    });
  }

  const cors = corsHeaders(req.headers.get("Origin"), env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const { pathname } = url;
  const m = req.method;

  if (m === "GET" && (pathname === "/.well-known/security.txt" || pathname === "/security.txt")) {
    return new Response(SECURITY_TXT, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
        ...cors,
      },
    });
  }
  if (m === "GET" && pathname === "/robots.txt") {
    return new Response(ROBOTS_TXT, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
        ...cors,
      },
    });
  }

  if (m === "GET" && pathname === "/.well-known/openid-configuration") {
    return json(discoveryDoc(env), 200, { ...PUBLIC_CORS, ...CACHE_1H });
  }
  if (m === "GET" && (pathname === "/jwks" || pathname === "/.well-known/jwks.json")) {
    const signing = await getSigning(env);
    return json(signing.jwks, 200, { ...PUBLIC_CORS, ...CACHE_1H });
  }

  // Everything below may touch the DB → ensure the schema once per isolate.
  // In prod (SKIP_MIGRATIONS=1) the tables already exist, so we skip the ~18 DDL
  // round-trips entirely (they'd otherwise slow every cold isolate). Tests leave
  // the flag unset so the schema + seed still run against the in-memory fake.
  if (env.SKIP_MIGRATIONS !== "1") await ensureSchema(deps);

  if (pathname === "/authorize/pending" && m === "GET") return handlePending(req, env, deps, cors, ctx);
  if (pathname === "/authorize" && (m === "GET" || m === "POST")) return handleAuthorize(req, env, deps, cors, ctx);
  if (pathname === "/signup" && m === "POST") return handleSignup(req, env, deps, cors);
  if (pathname === "/login" && m === "POST") return handleLogin(req, env, deps, cors);
  if (pathname === "/consent" && m === "POST") return handleConsent(req, env, deps, cors, ctx);
  if (pathname === "/token" && m === "POST") return handleToken(req, env, deps, cors);
  if (pathname === "/token/revoke" && m === "POST") return handleRevoke(req, env, deps, cors);
  if (pathname === "/token/introspect" && m === "POST") return handleIntrospect(req, env, deps, cors);
  if (pathname === "/tg/start" && m === "POST") return handleTgStart(req, env, deps, cors, ctx);
  if (pathname === "/internal/tg/confirm" && m === "POST") return handleTgConfirm(req, env, deps, cors);
  if (pathname === "/tg/status" && m === "GET") return handleTgStatus(req, env, deps, cors);
  if (pathname === "/tg/widget" && m === "POST") return handleTgWidget(req, env, deps, cors);
  if (pathname.startsWith("/api/dev/") && (m === "GET" || m === "POST")) return handleDev(req, env, deps, cors, pathname.slice("/api/dev/".length), ctx);
  if (pathname === "/api/session" && m === "GET") return handleSession(req, env, deps, cors, ctx);
  if ((pathname === "/api/account" || pathname.startsWith("/api/account/")) && (m === "GET" || m === "POST")) {
    return handleAccount(req, env, deps, cors, pathname === "/api/account" ? "" : pathname.slice("/api/account/".length), ctx);
  }
  if (pathname === "/mgmt/v1/clients" && (m === "PUT" || m === "POST")) return handleMgmt(req, env, deps, cors);
  if (pathname === "/userinfo" && (m === "GET" || m === "POST")) return handleUserinfo(req, env, deps, cors);
  // Public, unauthenticated avatar proxy: cross-origin <img> loads its current
  // Telegram photo. `ctx` is threaded through Deps so it can edge-cache the bytes.
  // Cap the id length in the pattern itself (account ids are ~37 chars) so a huge
  // path can't be used to bloat the cache key or the DB lookup.
  const av = pathname.match(/^\/avatar\/([A-Za-z0-9_-]{1,64})$/);
  if (av && m === "GET") {
    // Per-IP second line in front of the Bot-API amplification (same shape as /token).
    if (!(await ipThrottle(req, deps, "avatar", 120, 60))) return json({ error: "rate_limited" }, 429, cors);
    return handleAvatar(req, env, ctx ? { ...deps, ctx } : deps, av[1]!, cors);
  }
  if ((pathname === "/logout" || pathname === "/session/end") && m === "GET") return handleLogout(req, env, deps, cors);

  // A request reaching here matched no API route above. Most UI pages (/account,
  // /verify, …) are served by Cloudflare BEFORE the worker; but the three
  // run_worker_first paths (/login, /signup, /consent) run the WORKER first, so
  // their GET page is reachable ONLY here — and the OIDC flow itself redirects
  // logged-out users to GET /login and consent to GET /consent. So a GET/HEAD must
  // serve the real page asset when one exists; only genuinely-unknown paths fall
  // through to the styled 404. (No collision: every GET API route matched above.)
  if (env.ASSETS) {
    if (m === "GET" || m === "HEAD") {
      const asset = await env.ASSETS.fetch(req);
      if (asset.status !== 404) return asset; // real page (incl. /login, /signup, /consent)
    }
    // Unknown path (or a non-GET) → the styled 404 page (built to /404.html) with a
    // real 404 status. Fetched EXPLICITLY (not env.ASSETS.fetch(req)) so unknown
    // paths render the Astro 404 instead of a bare 404 — WITHOUT
    // assets.not_found_handling, which (given run_worker_first) would shadow every
    // API route before the worker runs.
    const page = await env.ASSETS.fetch(new URL("/404.html", req.url));
    return new Response(page.body, { status: 404, headers: page.headers });
  }
  return json({ error: "not_found" }, 404, cors);
}

// Cache Deps at module scope so the libsql client + the schema-migration promise
// (`schemaReady`) live for the whole isolate, not one request. Previously
// prodDeps(env) ran per request, re-executing the ~18 DDL/seed round-trips to
// Turso on EVERY call (~3s each); now the migration runs at most once per isolate.
let cachedDeps: Deps | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      cachedDeps ??= prodDeps(env);
      return await handle(request, env, cachedDeps, ctx);
    } catch {
      return json({ error: "internal_error" }, 500, corsHeaders(request.headers.get("Origin"), env));
    }
  },
};
