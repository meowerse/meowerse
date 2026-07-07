import { describe, it, expect } from "vitest";
import { prodDeps } from "./deps";
import type { Env } from "./types";

// Minimal fake D1Database: prodDeps only needs d1Client(env.DB) to construct an
// adapter (it does not touch the DB until a query runs), so an empty object with
// the right shape is enough to exercise the memoization + factory wiring.
const fakeD1 = {} as unknown as D1Database;

const env = {
  DB: fakeD1,
  OIDC_ISSUER: "https://auth-api.alxnko.eu.org",
  OIDC_CLIENT_ID: "cid",
  OIDC_CLIENT_SECRET: "secret",
  OIDC_REDIRECT_URI: "https://meowsenger-api.alxnko.eu.org/auth/callback",
} as Env;

describe("prodDeps", () => {
  it("memoizes getDb() (same instance on repeat calls)", () => {
    const deps = prodDeps(env);
    expect(deps.getDb()).toBe(deps.getDb());
  });
  it("memoizes auth() (same instance on repeat calls)", () => {
    const deps = prodDeps(env);
    expect(deps.auth()).toBe(deps.auth());
  });
  it("newId() returns a non-empty base64url string", () => {
    const id = prodDeps(env).newId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("now() returns a number (epoch ms)", () => {
    const t = prodDeps(env).now();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(0);
  });
});
