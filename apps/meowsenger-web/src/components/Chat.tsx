import { useCallback, useEffect, useRef, useState } from "react";
import { getSession, type SessionUser } from "../lib/meowsengerApi";
import { listChats, openDirect, loadHistory, wsUrl, type ChatSummary, type Message } from "../lib/chat";
import { ChatSidebar } from "./ChatSidebar";
import { Composer } from "./Composer";
import { Avatar } from "./Avatar";

/** A rendered bubble: a real Message, plus a client-only tempId while optimistic. */
interface Bubble extends Message {
  tempId?: string;
  pending?: boolean;
}

/** Server → client WS frames (Slice 2 + Slice 3 presence/typing/receipts, spec §6). */
type Frame =
  | { type: "ready"; chatId: string; you: string }
  | { type: "sent"; tempId: string; message: Message }
  | { type: "message"; message: Message }
  | { type: "presence_snapshot"; online: string[] }
  | { type: "presence"; userId: string; online: boolean }
  | { type: "typing"; userId: string; on: boolean }
  | { type: "read_receipt"; userId: string; upTo: number }
  | { type: "error"; code: string };

// A peer's "typing…" auto-clears if no fresh on:true arrives within this window
// (covers a dropped on:false — e.g. the peer's tab closed mid-type).
const TYPING_TTL_MS = 5000;
// How close to the bottom (px) still counts as "at bottom" for read + autoscroll.
const NEAR_BOTTOM_PX = 80;
// Background poll cadence to surface unread for non-active chats (v1 simplification).
const SIDEBAR_POLL_MS = 15000;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function Chat({ base }: { base: string }) {
  const [me, setMe] = useState<SessionUser | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [connected, setConnected] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // Presence roster (userIds with a live socket in this chat) + the peer's state.
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [peerTyping, setPeerTyping] = useState(false);
  // Newest createdAt the peer has read up to (for the "seen" tick on my messages).
  const [peerLastReadAt, setPeerLastReadAt] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const activeRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  // True while prepending older history — pauses the autoscroll-to-bottom effect
  // so loading older messages doesn't yank the view down.
  const prependingRef = useRef(false);
  const reconnectRef = useRef<{ timer: number | null; attempts: number }>({ timer: null, attempts: 0 });
  const closingRef = useRef(false);
  // Incoming-typing auto-clear timer (per the TTL above).
  const typingTimerRef = useRef<number | null>(null);
  // Outgoing-typing dedupe: the last on/off we told the server, so a steady typist
  // doesn't re-emit on:true on every keystroke.
  const sentTypingRef = useRef(false);
  // Whether the log is currently pinned near the bottom (drives read-send + autoscroll).
  const atBottomRef = useRef(true);
  // Highest createdAt we've already sent a `read` for on the active chat — avoids
  // re-sending the same receipt on every scroll tick / re-render.
  const sentReadUpToRef = useRef(0);

  const activeChat = chats.find((c) => c.id === activeId) ?? null;
  const peerId = activeChat?.peerId ?? null;

  // Load who-am-i + the sidebar list once.
  useEffect(() => {
    getSession(base).then((s) => setMe(s.user ?? null));
    listChats(base).then((cs) => { setChats(cs); setLoadingChats(false); });
  }, [base]);

  // Send a `read` receipt for the newest message, if we haven't already and the
  // socket is open. Optimistically zero the active chat's sidebar unread badge.
  const sendRead = useCallback((msgs: Bubble[]) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || msgs.length === 0) return;
    const newest = msgs[msgs.length - 1].createdAt;
    if (newest <= sentReadUpToRef.current) return;
    sentReadUpToRef.current = newest;
    ws.send(JSON.stringify({ type: "read", upTo: newest }));
    const chatId = activeRef.current;
    if (chatId) setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)));
  }, []);

  // Keep an autoscroll pinned to the newest message — unless we're prepending
  // older history (then Composer/onScroll preserves the position instead).
  useEffect(() => {
    if (prependingRef.current) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Infinite scroll: when the log is scrolled near the top and more history may
  // exist, load an older page via the `before=<oldestId>` cursor and prepend it,
  // preserving the visual scroll position.
  const loadOlder = useCallback(async () => {
    const el = logRef.current;
    const chatId = activeRef.current;
    if (!el || !chatId || prependingRef.current || !hasMore) return;
    const oldest = messages[0];
    if (!oldest) return;
    prependingRef.current = true;
    const prevHeight = el.scrollHeight;
    const older = await loadHistory(base, chatId, oldest.id);
    if (activeRef.current !== chatId) { prependingRef.current = false; return; }
    setHasMore(older.length >= 50);
    setMessages((prev) => [...older.map((m) => ({ ...m })), ...prev]);
    requestAnimationFrame(() => {
      const now = logRef.current;
      if (now) now.scrollTop = now.scrollHeight - prevHeight; // keep the same message under the cursor
      prependingRef.current = false;
    });
  }, [base, hasMore, messages]);

  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollTop < 60) void loadOlder();
    // Track bottom-ness for read-send + autoscroll; when the user scrolls back to
    // the bottom, that counts as "seen everything" → send a read receipt.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    atBottomRef.current = atBottom;
    if (atBottom) setMessages((prev) => { sendRead(prev); return prev; });
  }, [loadOlder, sendRead]);

  const applyFrame = useCallback((frame: Frame) => {
    if (frame.type === "sent") {
      // Reconcile the optimistic bubble: swap tempId → the server message.
      setMessages((prev) => prev.map((b) => (b.tempId && b.tempId === frame.tempId ? { ...frame.message } : b)));
    } else if (frame.type === "message") {
      // Broadcast from a peer (or an echo we already have). Dedupe by real id.
      setMessages((prev) => {
        if (prev.some((b) => b.id === frame.message.id)) return prev;
        const next = [...prev, { ...frame.message }];
        // A new peer message while we're reading (log at bottom) is immediately
        // "seen" → send a read receipt so their "seen" tick advances.
        if (atBottomRef.current) sendRead(next);
        return next;
      });
    } else if (frame.type === "presence_snapshot") {
      setOnline(new Set(frame.online));
    } else if (frame.type === "presence") {
      setOnline((prev) => {
        const next = new Set(prev);
        if (frame.online) next.add(frame.userId); else next.delete(frame.userId);
        return next;
      });
    } else if (frame.type === "typing") {
      setPeerTyping(frame.on);
      if (typingTimerRef.current != null) clearTimeout(typingTimerRef.current);
      // Auto-clear a stale "typing…" if no fresh on:true lands within the TTL.
      if (frame.on) typingTimerRef.current = window.setTimeout(() => setPeerTyping(false), TYPING_TTL_MS);
    } else if (frame.type === "read_receipt") {
      setPeerLastReadAt((prev) => Math.max(prev, frame.upTo));
    }
  }, [sendRead]);

  // Send a debounced typing signal from the Composer. Dedupe so a steady typist
  // emits at most one on:true and one on:false per burst.
  const sendTyping = useCallback((active: boolean) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (active === sentTypingRef.current) return;
    sentTypingRef.current = active;
    ws.send(JSON.stringify({ type: "typing", on: active }));
  }, []);

  // Open exactly ONE socket to the active chat; reload history on select.
  useEffect(() => {
    activeRef.current = activeId;
    // Reset per-chat presence/typing/receipt state on every switch.
    setOnline(new Set());
    setPeerTyping(false);
    setPeerLastReadAt(0);
    sentTypingRef.current = false;
    sentReadUpToRef.current = 0;
    atBottomRef.current = true;
    if (typingTimerRef.current != null) { clearTimeout(typingTimerRef.current); typingTimerRef.current = null; }
    if (!activeId) return;
    const chatId = activeId; // non-null capture for the closures below

    let cancelled = false;
    setMessages([]);
    setConnected(false);
    setHasMore(false);
    prependingRef.current = false;
    loadHistory(base, chatId).then((hist) => {
      if (cancelled) return;
      setMessages(hist.map((m) => ({ ...m })));
      setHasMore(hist.length >= 50); // a full page ⇒ there may be older messages
      // Opening a chat with messages = reading it → send a read receipt (once the
      // socket is up sendRead no-ops if closed; the onopen handler re-sends).
      if (hist.length > 0) sendRead(hist.map((m) => ({ ...m })));
    });

    function clearReconnect() {
      if (reconnectRef.current.timer != null) {
        clearTimeout(reconnectRef.current.timer);
        reconnectRef.current.timer = null;
      }
    }

    function connect() {
      if (cancelled || activeRef.current !== chatId) return;
      closingRef.current = false;
      const ws = new WebSocket(wsUrl(base, chatId));
      socketRef.current = ws;
      ws.onopen = () => {
        if (cancelled) return;
        reconnectRef.current.attempts = 0;
        setConnected(true);
        // Re-send read for whatever we already have loaded (covers open-before-connect
        // and reconnects). Allow a re-send by clearing the dedupe high-water mark.
        sentReadUpToRef.current = 0;
        if (atBottomRef.current) setMessages((prev) => { sendRead(prev); return prev; });
      };
      ws.onmessage = (ev) => {
        if (cancelled) return;
        try { applyFrame(JSON.parse(ev.data as string) as Frame); } catch { /* ignore junk */ }
      };
      ws.onclose = () => {
        if (cancelled || closingRef.current || activeRef.current !== chatId) return;
        setConnected(false);
        sentTypingRef.current = false; // a dropped socket clears any outstanding typing
        // Reconnect with a small capped backoff (0.5s → 5s).
        const n = Math.min(reconnectRef.current.attempts++, 10);
        const delay = Math.min(500 * 2 ** n, 5000);
        clearReconnect();
        reconnectRef.current.timer = window.setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      closingRef.current = true;
      clearReconnect();
      reconnectRef.current.attempts = 0;
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* already closed */ } }
    };
  }, [base, activeId, applyFrame, sendRead]);

  // Live-ish sidebar: refresh listChats on window focus + a 15s interval while the
  // tab is visible. Surfaces unread for background chats (no per-user inbox DO in
  // v1). Merge so the active chat's optimistic unread=0 isn't clobbered by a stale
  // poll — we force the active row's unread to 0 locally.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const cs = await listChats(base);
      if (cancelled) return;
      const act = activeRef.current;
      setChats(act ? cs.map((c) => (c.id === act ? { ...c, unreadCount: 0 } : c)) : cs);
    }
    function onFocus() { void refresh(); }
    function onVisible() { if (document.visibilityState === "visible") void refresh(); }
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, SIDEBAR_POLL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [base]);

  function send(body: string) {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeId || !me) return;
    const tempId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Optimistic bubble: shown immediately, reconciled by the `sent` frame.
    setMessages((prev) => [
      ...prev,
      { id: tempId, tempId, chatId: activeId, senderId: me.id, body, createdAt: Date.now(), pending: true },
    ]);
    atBottomRef.current = true; // my own send scrolls me to the bottom
    ws.send(JSON.stringify({ type: "send", tempId, body }));
  }

  async function onNewChat(username: string): Promise<string | null> {
    const r = await openDirect(base, username);
    if (r.error || !r.chatId) return r.error === "user_not_found" ? "no user with that username" : (r.error ?? "could not start chat");
    const cs = await listChats(base);
    setChats(cs);
    setActiveId(r.chatId);
    return null;
  }

  const peerName = activeChat ? (activeChat.peerDisplayName || activeChat.peerUsername || activeChat.name || "direct message") : "";
  const peerOnline = peerId != null && online.has(peerId);
  const open = activeId != null;
  // The "seen" tick shows on MY most-recent message once the peer has read up to it.
  const myLastId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (me && messages[i].senderId === me.id) return messages[i].tempId ?? messages[i].id;
    return null;
  })();

  return (
    <div className="mw-chat" data-open={open ? "1" : "0"}>
      <ChatSidebar
        chats={chats}
        activeId={activeId}
        online={online}
        onSelect={setActiveId}
        onNewChat={onNewChat}
        loading={loadingChats}
      />

      <section className="mw-chat__main">
        {!activeChat ? (
          <div className="mw-chat__empty">
            <p className="mw-muted">select a chat, or start one by username.</p>
          </div>
        ) : (
          <>
            <header className="mw-chat__head">
              <button
                className="mw-btn mw-btn--ghost mw-btn--sm mw-chat__back"
                onClick={() => setActiveId(null)}
                aria-label="back to chats"
              >
                ‹
              </button>
              <span className="mw-chat__headavatar">
                <Avatar url={activeChat.peerAvatarUrl} name={peerName} size="md" />
                <span className={`mw-dot ${peerOnline ? "mw-dot--on" : "mw-dot--off"}`} aria-label={peerOnline ? "online" : "offline"} />
              </span>
              <span className="mw-chat__headcol">
                <span className="mw-chat__peer" data-case="preserve">{peerName}</span>
                {peerTyping
                  ? <span className="mw-chat__typing">typing…</span>
                  : <span className="mw-chat__presence">{peerOnline ? "online" : "offline"}</span>}
              </span>
              <span className={`mw-chat__status${connected ? " is-on" : ""}`}>
                {connected ? "connected" : "connecting…"}
              </span>
            </header>

            <div className="mw-chat__log" ref={logRef} onScroll={onLogScroll}>
              {messages.length === 0 && (
                <p className="mw-muted" style={{ margin: "auto" }}>no messages yet. say hi 👋</p>
              )}
              {messages.map((m) => {
                const mine = me != null && m.senderId === me.id;
                const key = m.tempId ?? m.id;
                const seen = mine && key === myLastId && !m.pending && peerLastReadAt >= m.createdAt;
                return (
                  <div key={key} className={`mw-msg${mine ? " mw-msg--me" : ""}`}>
                    {!mine && <Avatar url={activeChat.peerAvatarUrl} name={peerName} size="sm" />}
                    <div className="mw-msg__col">
                      {!mine && <span className="mw-msg__name" data-case="preserve">{peerName}</span>}
                      <div className={`mw-bubble${mine ? " mw-bubble--me" : ""}${m.pending ? " is-pending" : ""}`}>
                        <span className="mw-bubble__body">{m.body}</span>
                        <span className="mw-bubble__time">{fmtTime(m.createdAt)}</span>
                      </div>
                      {seen && <span className="mw-msg__seen" aria-label="seen">seen</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            <Composer onSend={send} onTyping={sendTyping} disabled={!connected} />
          </>
        )}
      </section>
    </div>
  );
}
