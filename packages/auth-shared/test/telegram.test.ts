import { test, expect } from "bun:test";
import { internalConfirmString } from "../src/telegram";

test("internalConfirmString joins the 6 fields with newlines in a fixed order", () => {
  expect(internalConfirmString({ nonce: "n", telegramId: "1", username: "u", displayName: "D", avatarUrl: "a", ts: "9" })).toBe("n\n1\nu\nD\na\n9");
});

import { tgMatchCode } from "../src/telegram";

test("tgMatchCode is a deterministic 4-digit code that varies by nonce and key", async () => {
  const a = await tgMatchCode("k", "nonce-a");
  expect(a).toMatch(/^\d{4}$/);
  expect(await tgMatchCode("k", "nonce-a")).toBe(a);
  const codes = new Set(await Promise.all(Array.from({ length: 30 }, (_, i) => tgMatchCode("k", `n${i}`))));
  expect(codes.size).toBeGreaterThan(20);
  const other = new Set(await Promise.all(Array.from({ length: 30 }, (_, i) => tgMatchCode("k2", `n${i}`))));
  expect([...codes].join()).not.toBe([...other].join());
});
