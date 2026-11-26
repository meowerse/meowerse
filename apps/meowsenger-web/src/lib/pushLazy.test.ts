import { describe, it, expect, vi, beforeEach } from "vitest";

// The first load of ./push fails (flaky chunk fetch), later ones succeed.
let attempts = 0;
const core = { syncPushSubscription: vi.fn(async () => true), disablePush: vi.fn(async () => {}), pushConfirmedFor: vi.fn(async () => true), recordPushError: vi.fn() };
beforeEach(() => {
  attempts = 0;
  vi.resetModules();
  Object.values(core).forEach((f) => f.mockClear());
  vi.doMock("./push", () => { if (attempts++ === 0) throw new Error("Failed to fetch dynamically imported module"); return core; });
});

describe("pushLazy", () => {
  it("a failed chunk load is retried, so a later disablePush still runs its cleanup", async () => {
    const m = await import("./pushLazy");
    await expect(m.disablePush("b", "u")).rejects.toThrow();
    await m.disablePush("b", "u");
    expect(core.disablePush).toHaveBeenCalledWith("b", "u");
  });
  it("syncPushSubscription never rejects on a failed load (Chat fires it with void) and recovers", async () => {
    const m = await import("./pushLazy");
    await expect(m.syncPushSubscription("b", "u")).resolves.toBe(false);
    await expect(m.syncPushSubscription("b", "u")).resolves.toBe(true);
  });
  it("clearPushError is a no-op until loaded and never throws after a failed load", async () => {
    const m = await import("./pushLazy");
    expect(() => m.clearPushError()).not.toThrow();
    await m.syncPushSubscription("b", "u").catch(() => {});
    expect(() => m.clearPushError()).not.toThrow();
  });
});
