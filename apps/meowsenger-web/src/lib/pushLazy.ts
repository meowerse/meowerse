// Eager-path facade for lib/push: the core (~16 kB raw) loads via dynamic import so it stays out of
// the first-paint JS closure (perf/bundle.ts budget). Settings imports lib/push directly (already lazy).
let core: Promise<typeof import("./push")> | null = null;
const load = () => (core ??= import("./push"));

export const syncPushSubscription = (base: string, userId: string): Promise<boolean> =>
  load().then((m) => m.syncPushSubscription(base, userId));
export const pushConfirmedFor = (userId: string): Promise<boolean> => load().then((m) => m.pushConfirmedFor(userId));
export const disablePush = (base: string, userId?: string): Promise<void> => load().then((m) => m.disablePush(base, userId));
/** Reset the diagnostics error on account switch; a no-op until the core has loaded (it starts null). */
export function clearPushError(): void { if (core) void core.then((m) => m.recordPushError(null)); }
