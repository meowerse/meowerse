# @meowerse/auth

The relying-party SDK for **Auth with Meowerse** — add "continue with meowerse"
to any project in a few lines. Standard OpenID Connect: authorization-code flow
with mandatory PKCE (S256), ES256-signed tokens, refresh-token rotation, and the
RFC 9207 `iss` mix-up defense baked into the verify path.

Pure WebCrypto + an injectable `fetch`, so it runs in **Cloudflare Workers, Node,
and the browser** with no dependencies beyond `@meowerse/auth-shared`.

> Full walkthrough with copy-paste samples: **https://auth.alxnko.eu.org/docs**

## Install

```
bun add @meowerse/auth
```

## Log a user in

```ts
import { createAuthClient } from "@meowerse/auth";

const auth = createAuthClient({
  issuer: "https://auth-api.alxnko.eu.org",
  clientId: "your_client_id",
  redirectUri: "https://yourapp.example/callback",
  // clientSecret: process.env.CLIENT_SECRET  // confidential clients only
});

// 1. start login — PKCE + state + nonce are generated for you
const tx = await auth.buildAuthorizationUrl({ scope: "openid profile verified offline_access" });
// persist tx.state, tx.nonce, tx.codeVerifier, then redirect to tx.url

// 2. on your redirect_uri: verify state, redeem the code, verify the id_token
const tokens = await auth.exchangeCode({ code, codeVerifier });
const claims = await auth.verifyIdToken(tokens.id_token, { nonce });
const userId = claims.sub;

// 3. read profile / telegram / verified claims
const profile = await fetch("https://auth-api.alxnko.eu.org/userinfo", {
  headers: { Authorization: "Bearer " + tokens.access_token },
}).then((r) => r.json());

// 4. later — refresh (needs the offline_access scope)
const next = await auth.refresh(tokens.refresh_token);

// 5. log out (post-logout URI must be a registered redirect_uri)
location.href = auth.buildLogoutUrl({
  idTokenHint: tokens.id_token,
  postLogoutRedirectUri: "https://yourapp.example/",
});
```

## Scopes

| scope | grants |
|---|---|
| `openid` | `sub` — stable user id (required) |
| `profile` | `preferred_username`, `name`, `picture` |
| `telegram` | `telegram_id`, `telegram_username` |
| `verified` | `verified` — whether the user linked Telegram |
| `offline_access` | issues a `refresh_token` |

## Config-as-code

Provision a client from a manifest instead of the dashboard (idempotent upsert
by name via a management token you create under `/developers`):

```ts
import { defineAuthClient, provision } from "@meowerse/auth";

const manifest = defineAuthClient({
  name: "yourapp",
  clientType: "confidential",
  redirectUris: ["https://yourapp.example/callback"],
  scopes: ["openid", "profile", "verified"],
  allowOfflineAccess: true,
});

const result = await provision(manifest, {
  issuer: "https://auth-api.alxnko.eu.org",
  managementToken: process.env.MEOWERSE_MGMT_TOKEN,
});
// result.clientId + result.clientSecret (shown once)
```

## Generic OIDC clients

Not on a JS stack? Any RFC-compliant OIDC client works — point it at the
discovery document and it self-configures:

```
https://auth-api.alxnko.eu.org/.well-known/openid-configuration
```

Requirements: `response_type=code` with PKCE `S256`, id_token alg `ES256`
verified against the JWKS, and the `offline_access` scope for refresh tokens.
