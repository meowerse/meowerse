import { useEffect, useState } from "react";

/** A yellow "reconnecting" only after the link has been down this long (PR-10). */
export const LINK_WAIT_MS = 1500;
/** The room's "connecting…" header line stays invisible this long, so a chat switch never shows it. */
export const ROOM_WAIT_MS = 800;

/** A room that stays not-open this long while the link is up is a real outage: yellow. */
export const ROOM_STALL_MS = 8000;

/** "ended" = the session ended (terminal: the link will never come back). */
export type LinkState = "connecting" | "open" | "down" | "ended";
export type DotState = "idle" | "on" | "wait" | "off";

/** True only once `flag` has been continuously true for `ms`; false immediately when it clears. */
export function useDelayedFlag(flag: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flag) { setOn(false); return; }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [flag, ms]);
  return flag && on;
}

/**
 * The header connection indicator. The dot tracks the LINK (the persistent inbox socket),
 * not the per-chat room socket, so a chat switch never flickers it. A transient link drop
 * keeps the dot green until it has lasted LINK_WAIT_MS; offline shows immediately. The
 * room's own join shows only as a text line after ROOM_WAIT_MS, and turns the dot yellow
 * only after ROOM_STALL_MS. Terminal room states (revoked / forbidden close the chat, so
 * `roomOpen` is true; session ended is link "ended") never escalate.
 */
export function useConnectionIndicator(link: LinkState, roomOpen: boolean, netOnline: boolean): { dot: DotState; roomJoining: boolean; label: string } {
  const linkWait = useDelayedFlag(netOnline && link === "down", LINK_WAIT_MS);
  const roomJoining = useDelayedFlag(netOnline && !roomOpen, ROOM_WAIT_MS);
  const roomStall = useDelayedFlag(netOnline && link !== "ended" && !roomOpen, ROOM_STALL_MS);
  const dot: DotState = !netOnline || link === "ended" ? "off" : linkWait || roomStall ? "wait" : link === "connecting" ? "idle" : "on";
  const label = link === "ended" ? "signed out" : dot === "off" ? "offline" : dot === "wait" ? "reconnecting…" : roomJoining ? "connecting…" : dot === "on" ? "connected" : "";
  return { dot, roomJoining, label };
}
