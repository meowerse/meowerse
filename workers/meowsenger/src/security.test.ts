import { describe, it, expect } from "vitest";
import { readCookies, corsHeaders, randomId } from "./security";
import type { Env } from "./types";

describe("randomId", () => {
  it("defaults to 12 chars from the unambiguous alphabet", () => {
    const id = randomId();
    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]+$/);
  });
  it("honors an explicit length", () => {
    expect(randomId(6)).toHaveLength(6);
  });
  it("is (practically) unique across calls", () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(seen.size).toBe(200);
  });
});

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
