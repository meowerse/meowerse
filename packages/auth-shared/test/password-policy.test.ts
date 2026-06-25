import { test, expect } from "bun:test";
import { validatePassword } from "../src/password-policy";

test("rejects non-string, too short, too long; accepts 12–128", () => {
  expect(validatePassword(12345 as unknown).ok).toBe(false);
  expect(validatePassword("short").ok).toBe(false);
  expect(validatePassword("a".repeat(11)).ok).toBe(false);
  expect(validatePassword("a".repeat(12)).ok).toBe(true);
  expect(validatePassword("a".repeat(128)).ok).toBe(true);
  expect(validatePassword("a".repeat(129)).ok).toBe(false);
});

test("NFKC-normalizes before length check and returns the normalized password", () => {
  // 'ﬀ' (U+FB00) NFKC-expands to 'ff' — normalization must be applied.
  const res = validatePassword("ﬀ".repeat(6)); // 6 chars pre-NFKC → 12 chars post
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.password).toBe("ff".repeat(6));
});

test("index barrel re-exports work", async () => {
  const mod = await import("../src/index");
  expect(typeof mod.validatePassword).toBe("function");
  expect(typeof mod.verifyPkceS256).toBe("function");
  expect(mod.CATALOG.has("openid")).toBe(true);
});
