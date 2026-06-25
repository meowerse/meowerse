import { test, expect } from "vitest";
import { parseSigningKeys, getActiveKey, buildJwks } from "../src/keys";
import { genSigningKeys } from "./helpers";

test("active key selected; jwks is public-only with kid/alg/use and no private d", async () => {
  const keys = await genSigningKeys("k1", "active");
  const active = await getActiveKey(keys);
  expect(active.kid).toBe("k1");
  expect(active.key.type).toBe("private");

  const jwks = buildJwks(keys);
  const jwk = jwks.keys[0] as Record<string, unknown>;
  expect(jwk.kid).toBe("k1");
  expect(jwk.alg).toBe("ES256");
  expect(jwk.use).toBe("sig");
  expect(jwk).not.toHaveProperty("d");
  expect(jwk.crv).toBe("P-256");
});

test("buildJwks publishes active/next/retiring, drops anything else", async () => {
  const [a] = await genSigningKeys("k1", "active");
  const [n] = await genSigningKeys("k2", "next");
  const keys = [a!, n!, { ...a!, kid: "k3", status: "active" as const }];
  expect(buildJwks(keys).keys.length).toBe(3);
});

test("parseSigningKeys round-trips an array; rejects non-array", async () => {
  const keys = await genSigningKeys();
  const json = JSON.stringify(keys);
  expect(parseSigningKeys(json).length).toBe(1);
  expect(() => parseSigningKeys('{"not":"an array"}')).toThrow();
});

test("getActiveKey throws when no active key present", async () => {
  const [n] = await genSigningKeys("k2", "next");
  await expect(getActiveKey([n!])).rejects.toThrow("no active signing key");
});
