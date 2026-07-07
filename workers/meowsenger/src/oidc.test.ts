import { describe, it, expect } from "vitest";
import { handleLogin } from "./oidc";
import type { AuthClient } from "@meowerse/auth";

const fakeAuth = (): AuthClient => ({
  async buildAuthorizationUrl() {
    return { url: "https://auth-api.alxnko.eu.org/authorize?x=1", state: "st", nonce: "no", codeVerifier: "cv" };
  },
  async exchangeCode() { return {}; },
  async refresh() { return {}; },
  async verifyIdToken() { return {}; },
  buildLogoutUrl() { return ""; },
});

describe("handleLogin", () => {
  it("302s to the authorize URL and sets the txn cookie", async () => {
    const res = await handleLogin(fakeAuth());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/authorize");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("__Host-mw_txn=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});
