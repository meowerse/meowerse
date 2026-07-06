import { test, expect } from "vitest";
import { verifyTurnstile, turnstileGate } from "../src/turnstile";

/** A fetch stub returning the given Turnstile siteverify outcome. */
function fakeFetch(success: boolean): typeof fetch {
  return (async () => ({ json: async () => ({ success }) })) as unknown as typeof fetch;
}

test("verifyTurnstile: empty token → false, without calling siteverify", async () => {
  let called = false;
  const f = (async () => {
    called = true;
    return { json: async () => ({ success: true }) };
  }) as unknown as typeof fetch;
  expect(await verifyTurnstile("", "secret", null, f)).toBe(false);
  expect(called).toBe(false);
});

test("verifyTurnstile: reflects siteverify success / failure", async () => {
  expect(await verifyTurnstile("tok", "secret", "1.2.3.4", fakeFetch(true))).toBe(true);
  expect(await verifyTurnstile("tok", "secret", null, fakeFetch(false))).toBe(false);
});

test("verifyTurnstile: network/parse error → false (fail closed)", async () => {
  const boom = (async () => {
    throw new Error("net");
  }) as unknown as typeof fetch;
  expect(await verifyTurnstile("tok", "secret", null, boom)).toBe(false);
});

test("turnstileGate: disabled when no secret configured → always allowed", async () => {
  // even a failing verifier is never consulted when the key is unset
  expect(await turnstileGate({}, { "cf-turnstile-response": "x" }, null, fakeFetch(false))).toBe(true);
});

test("turnstileGate: enabled requires a valid token", async () => {
  const env = { TURNSTILE_SECRET_KEY: "s" };
  expect(await turnstileGate(env, { "cf-turnstile-response": "tok" }, null, fakeFetch(true))).toBe(true);
  expect(await turnstileGate(env, {}, null, fakeFetch(true))).toBe(false); // missing token → still false
  expect(await turnstileGate(env, { "cf-turnstile-response": "tok" }, null, fakeFetch(false))).toBe(false); // rejected token
});
