import { test, expect } from "bun:test";
import { b64urlEncode, b64urlDecode, constantTimeEqual } from "../src/base64url";

test("b64url round-trips bytes without padding or +/", () => {
  for (const len of [0, 1, 2, 3, 4, 5, 31, 32]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 13) & 0xff;
    const enc = b64urlEncode(bytes);
    expect(enc).not.toMatch(/[+/=]/);
    expect([...b64urlDecode(enc)]).toEqual([...bytes]);
  }
});

test("constantTimeEqual: equal true, differing length false, differing byte false", () => {
  expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
  expect(constantTimeEqual("abc", "abcd")).toBe(false);
  expect(constantTimeEqual("abce", "abcd")).toBe(false);
  expect(constantTimeEqual("", "")).toBe(true);
});
