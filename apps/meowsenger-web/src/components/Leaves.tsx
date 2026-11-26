import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";

/** DM header sub-line when the peer is offline: "last seen 5m ago" (else "offline"). */
function lastSeenLabel(ms: number | null | undefined, now: number): string {
  if (!ms) return "offline";
  const s = Math.floor((now - ms) / 1000);
  if (s < 60) return "last seen just now";
  if (s < 3600) return `last seen ${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `last seen ${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `last seen ${Math.floor(s / 86400)}d ago`;
  return "last seen " + new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The DM header's typing / presence sub-line: a leaf, so a frame touches only this node. */
export const PeerStatus = memo(function PeerStatus({ typing, away, online, lastSeenAt, now }: { typing: boolean; away: boolean; online: boolean; lastSeenAt: number | null | undefined; now: number }) {
  return typing
    ? <span className="mw-chat__typing">typing…</span>
    : <span className="mw-chat__presence">{away ? "away" : online ? "online" : lastSeenLabel(lastSeenAt, now)}</span>;
});

/** Transient toast. Owns its own state (imperative `show`), so a toast never re-renders the chat or its log. */
export const ToastHost = forwardRef<{ show: (text: string) => void }>(function ToastHost(_, ref) {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useImperativeHandle(ref, () => ({
    show(text) {
      setToast(text);
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setToast(null), 3200);
    },
  }), []);
  useEffect(() => () => { if (timer.current != null) clearTimeout(timer.current); }, []);
  return toast ? <div className="mw-apptoast" role="status">{toast}</div> : null;
});
