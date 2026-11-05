// Cross-tab logout + session-ended wiring. The message carries ONLY its type: no user
// id, chat data or tokens.
import { notifySessionEnded, subscribeSessionEnded } from "../sessionEnded";
import { clearAll } from "./scope";

const NAME = "mw-auth";
let installed = false;
// The ONE channel object this tab listens on. Logout posts through it too: a
// BroadcastChannel never delivers to its own sender object, so this tab does not
// raise "session ended" on itself while it is logging out.
let channel: BroadcastChannel | null = null;

/** Install once (idempotent): wipe on session-ended and on another tab's logout. */
export function installAuthChannel(): void {
  if (installed) return;
  installed = true;
  // sessionEnded snapshots the draft from its own source before notifying us.
  subscribeSessionEnded(() => { clearAll(); });
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(NAME);
    channel = ch;
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
    if (channel) { channel.postMessage({ type: "logout" }); return; }
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(NAME);
    ch.postMessage({ type: "logout" });
    ch.close();
  } catch { /* best effort */ }
}

/** Test-only: allow re-install in a fresh module state. */
export function _resetAuthChannelForTests(): void {
  installed = false;
  try { channel?.close(); } catch { /* ignore */ }
  channel = null;
}
