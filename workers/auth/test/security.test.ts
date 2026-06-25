import { test, expect } from "vitest";
import {
  corsHeaders,
  randomId,
  hostCookie,
  clearHostCookie,
  parseCookies,
  securityHeaders,
  validateCsrf,
  validateRedirectUri,
} from "../src/security";

const REG = ["https://app.example.com/cb", "http://127.0.0.1/cb"];

test("exact registered https uri accepted", () => {
  expect(validateRedirectUri("https://app.example.com/cb", REG).ok).toBe(true);
});

test.each([
  "https://app.example.com/cb/../evil",
  "https://app.example.com/cb#frag",
  "https://app.example.com/cb?x=1",
  "https://app.example.com:443/cb",
  "https://app.example.com/cb\\@evil.com",
  "https://evil.com\\@app.example.com/cb",
  "https://app.example.com/CB",
  "https://app.example.com/cb/",
  "https://app.example.com/cb?a=1&b=2?c=3",
  "http://%", // unparseable raw reaching the loopback pass -> new URL throws
  "",
])("authority/normalization confusion vector rejected: %s", (uri) => {
  expect(validateRedirectUri(uri, REG).ok).toBe(false);
});

test("loopback registered without a path defaults to '/'", () => {
  expect(validateRedirectUri("http://127.0.0.1:5/", ["http://127.0.0.1"]).ok).toBe(true);
  expect(validateRedirectUri("http://127.0.0.1:5/extra", ["http://127.0.0.1"]).ok).toBe(false);
});

test("loopback: only literal 127.0.0.1, port may differ, path byte-equal", () => {
  expect(validateRedirectUri("http://127.0.0.1:54321/cb", REG).ok).toBe(true);
  expect(validateRedirectUri("http://127.0.0.1/cb", REG).ok).toBe(true);
  expect(validateRedirectUri("http://localhost:54321/cb", REG).ok).toBe(false);
  expect(validateRedirectUri("http://127.0.0.1:54321/evil", REG).ok).toBe(false);
  expect(validateRedirectUri("https://127.0.0.1:54321/cb", REG).ok).toBe(false);
  expect(validateRedirectUri("http://user@127.0.0.1:5/cb", REG).ok).toBe(false);
});

test("ipv6 loopback literal supported", () => {
  expect(validateRedirectUri("http://[::1]:5000/cb", ["http://[::1]/cb"]).ok).toBe(true);
});

test("__Host- cookie has HttpOnly, Secure, SameSite=Lax, Path=/, no Domain", () => {
  const c = hostCookie("mw_sess", "abc", { maxAge: 100 });
  expect(c.startsWith("__Host-mw_sess=abc;")).toBe(true);
  expect(c).toContain("HttpOnly");
  expect(c).toContain("Secure");
  expect(c).toContain("SameSite=Lax");
  expect(c).toContain("Path=/");
  expect(c).toContain("Max-Age=100");
  expect(c).not.toContain("Domain=");
  expect(hostCookie("x", "y")).not.toContain("Max-Age");
  expect(clearHostCookie("mw_sess")).toContain("Max-Age=0");
});

test("parseCookies handles multiple, blank, and missing header", () => {
  expect(parseCookies("__Host-mw_sess=abc; __Host-mw_tkt=def")).toEqual({
    "__Host-mw_sess": "abc",
    "__Host-mw_tkt": "def",
  });
  expect(parseCookies(null)).toEqual({});
  expect(parseCookies("garbage; =novalue; k=v")).toEqual({ k: "v" });
});

test("securityHeaders sets no-referrer, no-store, frame-ancestors none; extra CSP appended", () => {
  const h = securityHeaders();
  expect(h["Referrer-Policy"]).toBe("no-referrer");
  expect(h["Cache-Control"]).toContain("no-store");
  expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  expect(securityHeaders("img-src 'self' https://logos.example")["Content-Security-Policy"]).toContain("img-src");
});

test("validateCsrf needs non-empty constant-time match", () => {
  expect(validateCsrf("tok", "tok")).toBe(true);
  expect(validateCsrf("tok", "nope")).toBe(false);
  expect(validateCsrf("", "")).toBe(false);
});

test("corsHeaders echoes only allowlisted origin", () => {
  const env = { CORS_ORIGINS: "https://auth.alxnko.eu.org" };
  expect(corsHeaders("https://auth.alxnko.eu.org", env)["Access-Control-Allow-Origin"]).toBe("https://auth.alxnko.eu.org");
  expect(corsHeaders("https://evil.com", env)["Access-Control-Allow-Origin"]).toBeUndefined();
  expect(corsHeaders(null, {})["Vary"]).toBe("Origin"); // default allowlist path
});

test("randomId is url-safe and unique", () => {
  const a = randomId();
  const b = randomId();
  expect(a).not.toBe(b);
  expect(a).not.toMatch(/[+/=]/);
  expect(randomId(8).length).toBeGreaterThan(0);
});
