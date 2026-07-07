import { describe, it, expect } from "vitest";
import { readCookies, corsHeaders } from "./security";
import type { Env } from "./types";

describe("readCookies", () => {
  it("parses a Cookie header into a map", () => {
    expect(readCookies("__Host-mw_session=abc; other=1")).toEqual({ "__Host-mw_session": "abc", other: "1" });
  });
  it("returns {} for no header", () => {
    expect(readCookies(null)).toEqual({});
  });
  it("skips a malformed segment with no '='", () => {
    expect(readCookies("bare; a=1")).toEqual({ a: "1" });
  });
});

describe("corsHeaders", () => {
  it("falls back to DEFAULT_ORIGINS when CORS_ORIGINS is unset", () => {
    // env.CORS_ORIGINS undefined → `?? ""` then `|| DEFAULT_ORIGINS`; default list
    // includes the UI origin, so it is echoed back.
    const env = {} as Env;
    const h = corsHeaders("https://meowsenger.alxnko.eu.org", env);
    expect(h["Access-Control-Allow-Origin"]).toBe("https://meowsenger.alxnko.eu.org");
  });
  it("omits Allow-Origin for a non-allowlisted origin", () => {
    const env = { CORS_ORIGINS: "http://localhost:4321" } as Env;
    expect(corsHeaders("https://evil.example", env)["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});
