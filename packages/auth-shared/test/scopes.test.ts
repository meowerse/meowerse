import { test, expect } from "bun:test";
import { CATALOG, parseScope, effectiveScope, isSubset } from "../src/scopes";

test("catalog is the fixed v1 set", () => {
  expect([...CATALOG].sort()).toEqual(["offline_access", "openid", "profile", "telegram", "verified"]);
});

test("parseScope dedups, drops unknown, preserves order; empty/null → []", () => {
  expect(parseScope("openid profile profile bogus telegram")).toEqual(["openid", "profile", "telegram"]);
  expect(parseScope("")).toEqual([]);
  expect(parseScope(null)).toEqual([]);
  expect(parseScope(undefined)).toEqual([]);
});

test("effectiveScope intersects consentMax ∩ clientAllowed ∩ requested", () => {
  expect(
    effectiveScope(["openid", "profile", "telegram"], ["openid", "profile"], ["openid", "profile", "telegram"]),
  ).toEqual(["openid", "profile"]);
  // requested scope the client no longer allows is dropped
  expect(effectiveScope(["openid", "telegram"], ["openid"], ["openid", "telegram"])).toEqual(["openid"]);
});

test("isSubset true within, false when extra requested", () => {
  expect(isSubset(["openid", "profile"], ["openid", "profile", "telegram"])).toBe(true);
  expect(isSubset(["openid", "telegram"], ["openid", "profile"])).toBe(false);
});
