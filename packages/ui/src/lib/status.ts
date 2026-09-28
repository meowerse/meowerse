// The StatusLine states and their tags, with no React: DOM code that keeps a server-rendered StatusLine
// in sync (apps/web/src/lib/status-dom.ts) imports them from "@meowerse/ui/status" instead of copying them,
// and doesn't pull the component bundle (and React) onto pages without islands.
/** the state a StatusLine shows: ok, wait, fail or info. */
export type StatusState = "ok" | "wait" | "fail" | "info";
export const STATUS_TAGS: Record<StatusState, string> = { ok: "[ ok ]", wait: "[wait]", fail: "[fail]", info: "[info]" };
