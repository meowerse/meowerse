import { test, expect } from "bun:test";
import { TYP, TOKEN_USE, assertAccessToken, assertIdToken } from "../src/tokentype";

const RES = "https://api.meow.alxnko.eu.org";

test("access guard requires typ at+jwt, token_use access, resource aud", () => {
  expect(assertAccessToken({ typ: TYP.ACCESS }, { token_use: TOKEN_USE.ACCESS, aud: RES }, RES)).toBe(true);
  // id_token shape rejected as access token
  expect(assertAccessToken({ typ: TYP.ID }, { token_use: TOKEN_USE.ID, aud: "client" }, RES)).toBe(false);
  // right typ but wrong audience (e.g. client_id) rejected
  expect(assertAccessToken({ typ: TYP.ACCESS }, { token_use: TOKEN_USE.ACCESS, aud: "some-client" }, RES)).toBe(false);
});

test("id guard accepts id shape, rejects access shape", () => {
  expect(assertIdToken({ typ: TYP.ID }, { token_use: TOKEN_USE.ID })).toBe(true);
  expect(assertIdToken({ typ: TYP.ACCESS }, { token_use: TOKEN_USE.ACCESS })).toBe(false);
});
