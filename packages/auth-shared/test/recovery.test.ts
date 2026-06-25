import { test, expect } from "bun:test";
import { genRecoveryCodes, normalizeRecoveryCode } from "../src/recovery";

test("returns 8 distinct Crockford-formatted recovery codes", () => {
  const codes = genRecoveryCodes();
  expect(codes.length).toBe(8);
  expect(new Set(codes).size).toBe(8);
  for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
});

test("custom count is honored", () => {
  expect(genRecoveryCodes(3).length).toBe(3);
});

test("normalize: upper-case, strip space/dash, map O→0 I/L→1 U→V, idempotent", () => {
  const out = normalizeRecoveryCode("o0il1-abcde");
  expect(out).toBe("00111ABCDE");
  expect(normalizeRecoveryCode(out)).toBe(out); // idempotent
});
