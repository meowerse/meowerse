import { test, expect } from "vitest";
import { hashPassword, verifyPassword, sha256Hex, hmacSha256Hex, CHEAP_PBKDF2 } from "../src/crypto";

const FAST = { rounds: 1, iter: 1000 };

test("hash verifies right password, rejects wrong; PHC shape correct", async () => {
  const phc = await hashPassword("correct horse battery staple", FAST);
  expect(phc.startsWith("pbkdf2$sha256$1$1000$")).toBe(true);
  expect(phc.split("$").length).toBe(6);
  expect(await verifyPassword("correct horse battery staple", phc)).toBe(true);
  expect(await verifyPassword("wrong", phc)).toBe(false);
});

test("chained rounds change the hash and still verify", async () => {
  const phc = await hashPassword("hunter2hunter2", { rounds: 3, iter: 1000 });
  expect(phc.startsWith("pbkdf2$sha256$3$1000$")).toBe(true);
  expect(await verifyPassword("hunter2hunter2", phc)).toBe(true);
});

test("cheap params work for high-entropy inputs", async () => {
  const phc = await hashPassword("ABCDE-FGHJK", CHEAP_PBKDF2);
  expect(await verifyPassword("ABCDE-FGHJK", phc)).toBe(true);
});

test("verifyPassword returns false on malformed PHC (never throws)", async () => {
  for (const bad of ["", "nope", "pbkdf2$sha256$x$y$z", "argon2$a$1$1$s$h", "pbkdf2$sha256$0$1$s$h", "pbkdf2$md5$1$1$s$h"]) {
    expect(await verifyPassword("x", bad)).toBe(false);
  }
});

test("sha256Hex + hmac are stable", async () => {
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect((await hmacSha256Hex("key", "msg")).length).toBe(64);
  expect(await hmacSha256Hex("k", "a")).toBe(await hmacSha256Hex("k", "a"));
  expect(await hmacSha256Hex("k", "a")).not.toBe(await hmacSha256Hex("k", "b"));
});
