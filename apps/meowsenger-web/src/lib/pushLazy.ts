// Eager-path facade for lib/push: the core (~16 kB raw) loads via dynamic import so it stays out of
// the first-paint JS closure (perf/bundle.ts budget). Settings imports lib/push directly (already lazy).
let core: Promise<typeof import("./push")> | null = null;
// A failed chunk load is not cached: the next call retries (a logout's disablePush must not be stuck on an early network blip).
const load = () => (core ??= import("./push").catch((e) => { core = null; throw e; }));

/** Fire-and-forget at the call site (`void`): like the original it never rejects; a failed load just means "not synced" (retried next time). */
export const syncPushSubscription = (base: string, userId: string): Promise<boolean> =>
  load().then((m) => m.syncPushSubscription(base, userId), () => false);
// Rejects when the core can't load; the logout caller treats disablePush as best-effort (and a later call retries the load).
export const disablePush = (base: string, userId?: string): Promise<void> => load().then((m) => m.disablePush(base, userId));
// A load failure rejects into maybeNotify's try/catch, which then falls back to the page notification: at worst a
// duplicate toast on a device whose push is confirmed AND whose chunk failed to load, never a lost one.
export const pushConfirmedFor = (userId: string): Promise<boolean> => load().then((m) => m.pushConfirmedFor(userId));
/** Reset the diagnostics error on account switch; a no-op until the core has loaded (it starts null). */
export function clearPushError(): void { if (core) void core.then((m) => m.recordPushError(null), () => {}); }
