import { useEffect, useState } from "react";

/** A yellow "reconnecting" only after the link has been down this long (PR-10). */
export const LINK_WAIT_MS = 1500;
/** The room's "connecting…" header line stays invisible this long, so a chat switch never shows it. */
export const ROOM_WAIT_MS = 800;

export type LinkState = "connecting" | "open" | "down";
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
 * room's own join shows only as a text line after ROOM_WAIT_MS.
 */
export function useConnectionIndicator(link: LinkState, roomOpen: boolean, netOnline: boolean): { dot: DotState; roomJoining: boolean; label: string } {
  const linkWait = useDelayedFlag(netOnline && link === "down", LINK_WAIT_MS);
  const roomJoining = useDelayedFlag(netOnline && !roomOpen, ROOM_WAIT_MS);
  const dot: DotState = !netOnline ? "off" : linkWait ? "wait" : link === "connecting" ? "idle" : "on";
  const label = dot === "off" ? "offline" : dot === "wait" ? "reconnecting…" : roomJoining ? "connecting…" : dot === "on" ? "connected" : "";
  return { dot, roomJoining, label };
}
