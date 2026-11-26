import { describe, it, expect } from "vitest";
import { corsHeaders, requireAuth, constantTimeEqual } from "./security";
import type { Env } from "./types";

const env: Env = {
  CORS_ORIGINS: "https://meow.alxnko.eu.org,http://localhost:4321",
  ALLOW_LOCALHOST_CORS: "1",
  API_TOKEN: "s3cret",
  DATABASE_URL: "libsql://x",
  DATABASE_AUTH_TOKEN: "tok",
};

describe("corsHeaders", () => {
  it("ignores a non-https CORS_ORIGINS entry unless ALLOW_LOCALHOST_CORS is set (fail closed)", () => {
    const e = { ...env, ALLOW_LOCALHOST_CORS: undefined, CORS_ORIGINS: "https://a.example,http://localhost:4321" } as Env;
    expect(corsHeaders("https://a.example", e)["Access-Control-Allow-Origin"]).toBe("https://a.example");
    expect(corsHeaders("http://localhost:4321", e)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders("http://localhost:4321", { ...e, ALLOW_LOCALHOST_CORS: "1" })["Access-Control-Allow-Origin"]).toBe("http://localhost:4321");
  });
  it("blanket localhost allowance requires ALLOW_LOCALHOST_CORS (default off) and defaults carry no dev origin", () => {
    const prod = { ...env, ALLOW_LOCALHOST_CORS: undefined, CORS_ORIGINS: undefined } as Env;
    expect(corsHeaders("http://localhost:5173", prod)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders("http://localhost:4321", prod)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders("http://foo.local", prod)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders("http://localhost:5173", { ...prod, ALLOW_LOCALHOST_CORS: "1" })["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
  });
  it("echoes an allowlisted origin and never wildcards with credentials", () => {
    const h = corsHeaders("http://localhost:4321", env);
    expect(h["Access-Control-Allow-Origin"]).toBe("http://localhost:4321");
    expect(h["Access-Control-Allow-Credentials"]).toBe("true");
    expect(h["Access-Control-Allow-Methods"]).toBe("GET,POST,OPTIONS");
    expect(h["Access-Control-Allow-Headers"]).toBe("Authorization,Content-Type");
    expect(h["Vary"]).toBe("Origin");
    expect(Object.values(h)).not.toContain("*");
  });

  it("omits the origin header when the origin is not allowlisted", () => {
    const h = corsHeaders("https://evil.example", env);
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("omits the origin header when no Origin is present", () => {
    const h = corsHeaders(null, env);
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("falls back to the default allowlist when CORS_ORIGINS is unset", () => {
    const h = corsHeaders("https://meow.alxnko.eu.org", { ...env, CORS_ORIGINS: undefined });
    expect(h["Access-Control-Allow-Origin"]).toBe("https://meow.alxnko.eu.org");
  });
});

describe("constantTimeEqual", () => {
  it("is true for equal strings and false otherwise", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("is false for different-length strings without short-circuiting", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});

describe("requireAuth", () => {
  const req = (auth?: string) =>
    new Request("https://api/x", { headers: auth ? { Authorization: auth } : {} });

  it("accepts a correct bearer token", () => {
    expect(requireAuth(req("Bearer s3cret"), env)).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(requireAuth(req("Bearer nope"), env)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(requireAuth(req(), env)).toBe(false);
  });

  it("rejects when API_TOKEN is unset", () => {
    expect(requireAuth(req("Bearer s3cret"), { ...env, API_TOKEN: undefined })).toBe(false);
  });
});
