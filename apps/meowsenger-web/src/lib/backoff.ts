/** Cap on the reconnect delay (ms). */
export const BACKOFF_CAP_MS = 10_000;
const BACKOFF_BASE_MS = 1000;

/**
 * Equal-jitter exponential backoff (the AITS `retryDelay` shape): half the exponential
 * step is fixed, the other half random, so a fleet of clients dropped together does not
 * reconnect in lockstep, yet no client retries sooner than half the step.
 * `attempt` is 0-based; the result is in [base/2, base] with base = min(cap, 1s * 2^attempt).
 * `rand` is injectable (seeded in tests).
 */
export function retryDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 20)));
  return base / 2 + (rand() * base) / 2;
}
