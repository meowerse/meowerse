import { describe, expect, test } from "vitest";
import { isReleasedUsername, shownName, shownUsername } from "./userName";

describe("released username display", () => {
  test("placeholder never shown raw", () => {
    expect(isReleasedUsername("~acct_1")).toBe(true);
    expect(shownUsername("~acct_1")).toBeNull();
    expect(shownName("Alice", "~acct_1")).toBe("Alice");
    expect(shownName(null, "~acct_1")).toBe("former user");
    expect(shownName("", "~acct_1")).toBe("former user");
  });
  test("real usernames unchanged", () => {
    expect(shownUsername("alice")).toBe("alice");
    expect(shownName(null, "alice")).toBe("alice");
    expect(shownName("Al", "alice")).toBe("Al");
  });
});
