import { test, expect } from "bun:test";
import { internalConfirmString } from "../src/telegram";

test("internalConfirmString joins the 6 fields with newlines in a fixed order", () => {
  expect(internalConfirmString({ nonce: "n", telegramId: "1", username: "u", displayName: "D", avatarUrl: "a", ts: "9" })).toBe("n\n1\nu\nD\na\n9");
});
