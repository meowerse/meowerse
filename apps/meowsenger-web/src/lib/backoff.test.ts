import { describe, it, expect } from "vitest";
import { BACKOFF_CAP_MS, retryDelay } from "./backoff";

/** Seeded PRNG (mulberry32) so the jitter bounds are checked deterministically. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("retryDelay (equal-jitter backoff)", () => {
  it("stays within [base/2, base] for every attempt, with base capped at 10 s", () => {
    const rand = seeded(42);
    for (let attempt = 0; attempt < 30; attempt++) {
      const base = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt);
      for (let i = 0; i < 200; i++) {
        const d = retryDelay(attempt, rand);
        expect(d).toBeGreaterThanOrEqual(base / 2);
        expect(d).toBeLessThanOrEqual(base);
        expect(d).toBeLessThanOrEqual(BACKOFF_CAP_MS);
      }
    }
  });
  it("hits the exact bounds at rand=0 and rand→1, and grows then caps", () => {
    expect(retryDelay(0, () => 0)).toBe(500);
    expect(retryDelay(0, () => 0.999999)).toBeCloseTo(1000, 2);
    expect(retryDelay(3, () => 0)).toBe(4000);
    expect(retryDelay(4, () => 0)).toBe(5000); // 16 s step capped at 10 s => half of 10 s
    expect(retryDelay(99, () => 0)).toBe(5000);
  });
  it("actually jitters (not a constant)", () => {
    const rand = seeded(7);
    const seen = new Set(Array.from({ length: 20 }, () => retryDelay(3, rand)));
    expect(seen.size).toBeGreaterThan(10);
  });
});
