import { test, expect } from "vitest";
import { b64urlEncode } from "@meowerse/auth-shared";
import { signJwt, verifyJwt, JwtError } from "../src/jwt";
import { getActiveKey, buildJwks } from "../src/keys";
import { genSigningKeys } from "./helpers";

const enc = new TextEncoder();

async function setup() {
  const keys = await genSigningKeys("k1", "active");
  const active = await getActiveKey(keys);
  const jwks = buildJwks(keys);
  return { active, jwks };
}

test("sign then verify round-trips and returns claims", async () => {
  const { active, jwks } = await setup();
  const token = await signJwt({ kid: active.kid }, { iss: "iss", aud: "client", sub: "u1", exp: 9999999999 }, active.key);
  const { payload, header } = await verifyJwt(token, jwks, { iss: "iss", aud: "client", now: 1000 });
  expect(header.alg).toBe("ES256");
  expect(payload.sub).toBe("u1");
});

test("rejects alg!=ES256 (none/HS confusion)", async () => {
  const { jwks } = await setup();
  const forged = `${b64urlEncode(enc.encode(JSON.stringify({ alg: "none", kid: "k1" })))}.${b64urlEncode(
    enc.encode(JSON.stringify({ sub: "attacker" })),
  )}.`;
  await expect(verifyJwt(forged, jwks)).rejects.toBeInstanceOf(JwtError);
});

test("rejects tampered signature, unknown kid, malformed, expired, aud mismatch", async () => {
  const { active, jwks } = await setup();
  const token = await signJwt({ kid: "k1" }, { aud: "client", exp: 9999999999 }, active.key);

  // tamper: flip the FIRST signature char (top bits of byte 0 — unlike the last
  // char, whose low bits are dropped from a 64-byte ECDSA sig).
  const [th, tp, ts] = token.split(".") as [string, string, string];
  const tampered = `${th}.${tp}.${ts[0] === "A" ? "B" : "A"}${ts.slice(1)}`;
  await expect(verifyJwt(tampered, jwks)).rejects.toBeInstanceOf(JwtError);

  const wrongKid = await signJwt({ kid: "nope" }, { exp: 9999999999 }, active.key);
  await expect(verifyJwt(wrongKid, jwks)).rejects.toThrow("unknown-kid");

  await expect(verifyJwt("a.b", jwks)).rejects.toThrow("malformed");

  const expired = await signJwt({ kid: "k1" }, { exp: 500 }, active.key);
  await expect(verifyJwt(expired, jwks, { now: 1000 })).rejects.toThrow("expired");

  const audTok = await signJwt({ kid: "k1" }, { aud: "client", exp: 9999999999 }, active.key);
  await expect(verifyJwt(audTok, jwks, { aud: "other", now: 1000 })).rejects.toThrow("aud-mismatch");
});

test("rejects iss mismatch and not-yet-valid (nbf)", async () => {
  const { active, jwks } = await setup();
  const issTok = await signJwt({ kid: "k1" }, { iss: "real", exp: 9999999999 }, active.key);
  await expect(verifyJwt(issTok, jwks, { iss: "fake", now: 1000 })).rejects.toThrow("iss-mismatch");

  const future = await signJwt({ kid: "k1" }, { nbf: 100000, exp: 9999999999 }, active.key);
  await expect(verifyJwt(future, jwks, { now: 1000 })).rejects.toThrow("not-yet-valid");
});
