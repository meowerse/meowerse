import type { DbClient, Env } from "./types";
import { d1Client } from "./db";
import { createAuthClient, type AuthClient } from "@meowerse/auth";

export interface Deps {
  getDb(): DbClient;
  auth(): AuthClient;
  fetchFn: typeof fetch;
  now(): number;
  newId(): string;
}

export function prodDeps(env: Env): Deps {
  let db: DbClient | undefined;
  let ac: AuthClient | undefined;
  return {
    getDb: () => (db ??= d1Client(env.DB)),
    auth: () =>
      (ac ??= createAuthClient({
        issuer: env.OIDC_ISSUER!,
        clientId: env.OIDC_CLIENT_ID!,
        clientSecret: env.OIDC_CLIENT_SECRET,
        redirectUri: env.OIDC_REDIRECT_URI!,
      })),
    // Bind to globalThis: workerd throws "Illegal invocation" if `fetch` is
    // called as a method (deps.fetchFn(...)) with `this` !== the global.
    fetchFn: fetch.bind(globalThis),
    now: () => Date.now(),
    newId: () => b64url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
