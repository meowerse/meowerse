import type { Env } from "./types";
import { type Deps, ensureSchema, prodDeps } from "./db";
import { corsHeaders, securityHeaders, hostCookie, clearHostCookie, parseCookies, validateCsrf, randomId } from "./security";
import { sha256Hex } from "./crypto";
import { parseSigningKeys, getActiveKey, buildJwks } from "./keys";
import { verifyJwt } from "./jwt";
import { discoveryDoc } from "./oidc";
import { getClient } from "./clients";
import {
  parseAuthorizeQuery,
  validateAuthorizeParams,
  signRequest,
  verifyRequest,
  type AuthorizeRequest,
} from "./authorize";
import { signup, loginVerify, deriveVerified, DEFAULT_DUMMY_PHC } from "./accounts";
import { issueSession, lookupSession, rotateSession, revokeSession } from "./session";
import { consentDecision, getConsent, grantConsent } from "./consent";
import { createAuthCode, exchangeCode, mintTokens, recordAccessToken, revokeAccessToken, introspect } from "./token";
import { createRefreshToken, rotateRefresh } from "./refresh";
import {
  verifyLoginWidget,
  verifyInternalConfirm,
  signInOrSignUpTelegram,
  linkTelegramToAccount,
  createTicket,
  findPendingTicketByNonce,
  consumeTicket,
  getTicket,
  TICKET_TTL,
} from "./telegram";
import { constantTimeEqual } from "@meowerse/auth-shared";
import {
  createClient,
  listClients,
  deleteClient,
  rotateSecret,
  createManagementToken,
  verifyManagementToken,
  upsertClientByName,
} from "./dashboard";
import { userinfoClaims } from "./userinfo";
import { checkRateLimit } from "./ratelimit";

const TKT_TTL = 900; // signed authorize request object lifetime (seconds)
const SESS_COOKIE = "mw_sess";
const TKT_COOKIE = "mw_tkt";

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
  return env.ISSUER ?? "https://auth-api.alxnko.eu.org";
}
function webOrigin(env: Env): string {
  return env.WEB_ORIGIN ?? "https://auth.alxnko.eu.org";
}
function stateSecret(env: Env): string {
  return env.STATE_SECRET ?? env.AUTH_SIGNING_KEYS ?? "dev-state-secret";
}

interface Signing {
  active: { kid: string; key: CryptoKey };
  jwks: { keys: JsonWebKey[] };
}
async function getSigning(env: Env): Promise<Signing> {
  const keys = parseSigningKeys(env.AUTH_SIGNING_KEYS ?? "[]");
  return { active: await getActiveKey(keys), jwks: buildJwks(keys) };
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
  const verified = await deriveVerified(db, accountId);
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

async function handleAuthorize(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
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
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps));
  const promptNone = (request.prompt ?? "").split(/\s+/).includes("none");

  if (session) {
    const verified = await deriveVerified(db, session.accountId);
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
  const userHash = await sha256Hex((p.username ?? "") + "|login");
  const rl = await checkRateLimit(db, `login:${userHash}`, { limit: 10, windowSec: 900, now: now(deps) });
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

async function handleConsent(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const p = await readParams(req);
  const db = deps.getDb();
  const cookies = parseCookies(req.headers.get("Cookie"));
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps));
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

  const verified = await deriveVerified(db, session.accountId);
  if (client.verifiedOnly && !verified) return json({ error: "verification_required" }, 403, cors);
  const consent = await getConsent(db, session.accountId, request.clientId);
  const scope = await grantConsent(db, {
    accountId: session.accountId,
    clientId: request.clientId,
    requested: request.scope,
    clientAllowed: client.allowedScopes,
    priorMax: consent?.scopeSetMax ?? null,
  });
  const idHash = await sha256Hex(cookies[`__Host-${SESS_COOKIE}`]!);
  const loc = await mintCodeRedirect(deps, env, request, session.accountId, idHash, session.authTime, scope);
  return json({ redirect: loc }, 200, { ...cors, ...securityHeaders(), "Set-Cookie": clearTkt });
}

/** GET the pending authorize request so the consent UI can render it on a fresh load. */
async function handlePending(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const db = deps.getDb();
  const cookies = parseCookies(req.headers.get("Cookie"));
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps));
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
  const verified = await deriveVerified(db, i.accountId);
  const signing = await getSigning(env);
  const tokens = await mintTokens({
    accountId: i.accountId,
    clientId: i.clientId,
    scope: i.scope,
    nonce: i.nonce,
    authTime: i.authTime,
    verified,
    issuer: issuer(env),
    resourceAud: env.RESOURCE_AUD ?? "https://api.meow.alxnko.eu.org",
    signingKey: signing.active.key,
    kid: signing.active.kid,
    family: i.family,
    now: now(deps),
  });
  await recordAccessToken(db, { jti: tokens.jti, accountId: i.accountId, clientId: i.clientId, scope: i.scope, family: i.family, now: now(deps) });
  const { jti: _jti, ...body } = tokens;
  void _jti;
  let refresh = i.refreshToken;
  if (i.issueRefresh && !refresh) {
    refresh = await createRefreshToken(db, { accountId: i.accountId, clientId: i.clientId, scope: i.scope, family: i.family, now: now(deps) });
  }
  return json(refresh ? { ...body, refresh_token: refresh } : body, 200, { ...cors, ...noStore });
}

async function handleToken(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const p = await readParams(req);
  const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };
  const db = deps.getDb();
  const clientId = p.client_id ?? "";

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
async function handleTgStart(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const db = deps.getDb();
  const p = await readParams(req);
  const kind = p.kind === "VERIFY_EXISTING" ? "VERIFY_EXISTING" : "SIGNIN_OR_SIGNUP";
  const cookies = parseCookies(req.headers.get("Cookie"));
  let accountId: string | null = null;
  if (kind === "VERIFY_EXISTING") {
    const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps));
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
  const resourceAud = env.RESOURCE_AUD ?? "https://api.meow.alxnko.eu.org";
  try {
    const signing = await getSigning(env);
    const { header, payload } = await verifyJwt(token, signing.jwks, { iss: issuer(env), aud: resourceAud, now: now(deps) });
    const res = await userinfoClaims(deps.getDb(), { header, payload, resourceAud });
    if (!res.ok) return json({ error: "invalid_token" }, 401, { ...cors, ...noStore });
    return json(res.claims, 200, { ...cors, ...noStore });
  } catch {
    return json({ error: "invalid_token" }, 401, { ...cors, ...noStore });
  }
}

async function handleLogout(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const cookies = parseCookies(req.headers.get("Cookie"));
  const raw = cookies[`__Host-${SESS_COOKIE}`];
  if (raw) await revokeSession(deps.getDb(), raw);
  return redirect(webOrigin(env), { ...securityHeaders(), "Set-Cookie": clearHostCookie(SESS_COOKIE) });
}

async function handleRevoke(req: Request, _env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const p = await readParams(req);
  if (p.token) await revokeAccessToken(deps.getDb(), p.token);
  return json({}, 200, cors); // RFC 7009: always 200
}

async function handleIntrospect(req: Request, _env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const p = await readParams(req);
  const res = p.token ? await introspect(deps.getDb(), p.token, now(deps)) : { active: false };
  return json(res, 200, cors);
}

function splitList(v: string | undefined): string[] {
  return (v ?? "").split(/[\s,]+/).filter(Boolean);
}
function asBool(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

/** Developer dashboard API (session-authed, owner-scoped). Spec §8. */
async function handleDev(req: Request, env: Env, deps: Deps, cors: Record<string, string>, sub: string): Promise<Response> {
  const db = deps.getDb();
  const cookies = parseCookies(req.headers.get("Cookie"));
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps));
  if (!session) return json({ error: "no_session" }, 401, cors);

  if (sub === "clients" && req.method === "GET") {
    return json({ clients: await listClients(db, session.accountId) }, 200, { ...cors, ...securityHeaders() });
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
  if (sub === "tokens") {
    const token = await createManagementToken(db, session.accountId, p.label);
    return json({ token }, 200, { ...cors, ...securityHeaders() });
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

/**
 * Thin DI router (mirrors workers/api). `deps` is injectable so tests pass a
 * fake db + fixed clock; production builds it from env once per request.
 */
export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("Origin"), env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const { pathname } = new URL(req.url);
  const m = req.method;

  if (m === "GET" && pathname === "/.well-known/openid-configuration") {
    return json(discoveryDoc(env), 200, { ...cors, ...CACHE_1H });
  }
  if (m === "GET" && (pathname === "/jwks" || pathname === "/.well-known/jwks.json")) {
    const signing = await getSigning(env);
    return json(signing.jwks, 200, { ...cors, ...CACHE_1H });
  }

  // Everything below may touch the DB → ensure the schema once per isolate.
  await ensureSchema(deps);

  if (pathname === "/authorize/pending" && m === "GET") return handlePending(req, env, deps, cors);
  if (pathname === "/authorize" && (m === "GET" || m === "POST")) return handleAuthorize(req, env, deps, cors);
  if (pathname === "/signup" && m === "POST") return handleSignup(req, env, deps, cors);
  if (pathname === "/login" && m === "POST") return handleLogin(req, env, deps, cors);
  if (pathname === "/consent" && m === "POST") return handleConsent(req, env, deps, cors);
  if (pathname === "/token" && m === "POST") return handleToken(req, env, deps, cors);
  if (pathname === "/token/revoke" && m === "POST") return handleRevoke(req, env, deps, cors);
  if (pathname === "/token/introspect" && m === "POST") return handleIntrospect(req, env, deps, cors);
  if (pathname === "/tg/start" && m === "POST") return handleTgStart(req, env, deps, cors);
  if (pathname === "/internal/tg/confirm" && m === "POST") return handleTgConfirm(req, env, deps, cors);
  if (pathname === "/tg/status" && m === "GET") return handleTgStatus(req, env, deps, cors);
  if (pathname === "/tg/widget" && m === "POST") return handleTgWidget(req, env, deps, cors);
  if (pathname.startsWith("/api/dev/") && (m === "GET" || m === "POST")) return handleDev(req, env, deps, cors, pathname.slice("/api/dev/".length));
  if (pathname === "/mgmt/v1/clients" && (m === "PUT" || m === "POST")) return handleMgmt(req, env, deps, cors);
  if (pathname === "/userinfo" && (m === "GET" || m === "POST")) return handleUserinfo(req, env, deps, cors);
  if ((pathname === "/logout" || pathname === "/session/end") && m === "GET") return handleLogout(req, env, deps, cors);

  return json({ error: "not_found" }, 404, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env, prodDeps(env));
    } catch {
      return json({ error: "internal_error" }, 500, corsHeaders(request.headers.get("Origin"), env));
    }
  },
};
