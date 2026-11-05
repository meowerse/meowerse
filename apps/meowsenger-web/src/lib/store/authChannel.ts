// Cross-tab logout + session-ended wiring. The message carries ONLY its type: no user
// id, chat data or tokens.
import { notifySessionEnded, subscribeSessionEnded } from "../sessionEnded";
import { clearAll } from "./scope";

const NAME = "mw-auth";
let installed = false;

/** Install once (idempotent): wipe on session-ended and on another tab's logout. */
export function installAuthChannel(): void {
  if (installed) return;
  installed = true;
  // sessionEnded snapshots the draft from its own source before notifying us.
  subscribeSessionEnded(() => { clearAll(); });
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(NAME);
    ch.onmessage = (ev: MessageEvent) => {
      const d = ev.data as unknown;
      if (d === null || typeof d !== "object" || Array.isArray(d)) return;
      if ((d as { type?: unknown }).type !== "logout" || Object.keys(d).length !== 1) return;
      clearAll();
      notifySessionEnded();
    };
  } catch { /* no cross-tab logout; this tab still clears itself */ }
}

/** Tell other tabs we logged out. Never throws. */
export function broadcastLogout(): void {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(NAME);
    ch.postMessage({ type: "logout" });
    ch.close();
  } catch { /* best effort */ }
}

/** Test-only: allow re-install in a fresh module state. */
export function _resetAuthChannelForTests(): void { installed = false; }
