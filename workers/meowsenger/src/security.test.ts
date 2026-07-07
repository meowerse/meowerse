import { describe, it, expect } from "vitest";
import { readCookies } from "./security";

describe("readCookies", () => {
  it("parses a Cookie header into a map", () => {
    expect(readCookies("__Host-mw_session=abc; other=1")).toEqual({ "__Host-mw_session": "abc", other: "1" });
  });
  it("returns {} for no header", () => {
    expect(readCookies(null)).toEqual({});
  });
});
