import { useEffect, useRef } from "react";
import { inboxWsUrl, type InboxDelta } from "../lib/chat";

/**
 * Opens the user's single persistent "inbox" WebSocket and invokes `onDelta` for
 * every realtime sidebar update — a message in a chat they DON'T have open (the active
 * chat updates its own sidebar row from the conversation socket). Separate from the
 * per-chat conversation socket. Reconnects with capped exponential backoff.
 *
 * `onDelta` is mirrored into a ref so the socket effect depends only on `[base,
 * enabled]` and never re-runs (a reconnect storm) when the view re-renders with a new
 * closure — the same stability discipline the conversation hook uses.
 */
export function useInbox(base: string, enabled: boolean, onDelta: (d: InboxDelta) => void): void {
  const onDeltaRef = useRef(onDelta);
  useEffect(() => { onDeltaRef.current = onDelta; });

  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;
    let cancelled = false;
    let closing = false;
    let ws: WebSocket | null = null;
    let timer: number | null = null;
    let attempts = 0;

    const clearTimer = () => { if (timer != null) { clearTimeout(timer); timer = null; } };

    function connect(): void {
      if (cancelled) return;
      closing = false;
      ws = new WebSocket(inboxWsUrl(base));
      ws.onopen = () => { attempts = 0; };
      ws.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const frame = JSON.parse(ev.data as string) as { type?: string } & Partial<InboxDelta>;
          if (frame.type === "chat_update" && frame.chatId) {
            onDeltaRef.current({
              chatId: frame.chatId,
              preview: frame.preview ?? "",
              at: frame.at ?? Date.now(),
              senderId: frame.senderId ?? "",
              forwarded: frame.forwarded,
            });
          }
        } catch { /* ignore junk */ }
      };
      ws.onclose = () => {
        if (cancelled || closing) return;
        const n = Math.min(attempts++, 10);
        clearTimer();
        timer = window.setTimeout(connect, Math.min(500 * 2 ** n, 5000));
      };
    }
    connect();

    return () => {
      cancelled = true;
      closing = true;
      clearTimer();
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* already closed */ } }
    };
  }, [base, enabled]);
}
