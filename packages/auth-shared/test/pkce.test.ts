import { test, expect } from "bun:test";
import { verifyPkceS256, sha256 } from "../src/pkce";

// RFC 7636 Appendix B vector.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("RFC 7636 B.1 vector verifies; wrong challenge fails", async () => {
  expect(await verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true);
  expect(await verifyPkceS256(VERIFIER, "wrong-challenge-value")).toBe(false);
});

test("sha256 of 'abc' matches the known digest", async () => {
  const hex = [...(await sha256("abc"))].map((b) => b.toString(16).padStart(2, "0")).join("");
  expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
