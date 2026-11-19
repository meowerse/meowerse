import { test, expect } from "bun:test";
import { internalConfirmString, internalDescribeString, internalCancelString } from "../src/telegram";

test("internalConfirmString joins the 6 fields with newlines in a fixed order", () => {
  expect(internalConfirmString({ nonce: "n", telegramId: "1", username: "u", displayName: "D", avatarUrl: "a", ts: "9" })).toBe("n\n1\nu\nD\na\n9");
});

test("describe/cancel strings are label-separated so signatures cannot cross endpoints", () => {
  const f = { nonce: "n", telegramId: "1", ts: "9" };
  expect(internalDescribeString(f)).toBe("describe\nn\n1\n9");
  expect(internalCancelString(f)).toBe("cancel\nn\n1\n9");
  expect(internalDescribeString(f)).not.toBe(internalCancelString(f));
});
