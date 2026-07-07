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

/** Server → client WS frames (Slice 2 subset of spec §6). */
type Frame =
  | { type: "ready"; chatId: string; you: string }
  | { type: "sent"; tempId: string; message: Message }
  | { type: "message"; message: Message }
  | { type: "error"; code: string };

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

  const socketRef = useRef<WebSocket | null>(null);
  const activeRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const reconnectRef = useRef<{ timer: number | null; attempts: number }>({ timer: null, attempts: 0 });
  const closingRef = useRef(false);

  const activeChat = chats.find((c) => c.id === activeId) ?? null;

  // Load who-am-i + the sidebar list once.
  useEffect(() => {
    getSession(base).then((s) => setMe(s.user ?? null));
    listChats(base).then((cs) => { setChats(cs); setLoadingChats(false); });
  }, [base]);

  // Keep an autoscroll pinned to the newest message.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const applyFrame = useCallback((frame: Frame) => {
    if (frame.type === "sent") {
      // Reconcile the optimistic bubble: swap tempId → the server message.
      setMessages((prev) => prev.map((b) => (b.tempId && b.tempId === frame.tempId ? { ...frame.message } : b)));
    } else if (frame.type === "message") {
      // Broadcast from a peer (or an echo we already have). Dedupe by real id.
      setMessages((prev) => (prev.some((b) => b.id === frame.message.id) ? prev : [...prev, { ...frame.message }]));
    }
  }, []);

  // Open exactly ONE socket to the active chat; reload history on select.
  useEffect(() => {
    activeRef.current = activeId;
    if (!activeId) return;
    const chatId = activeId; // non-null capture for the closures below

    let cancelled = false;
    setMessages([]);
    setConnected(false);
    loadHistory(base, chatId).then((hist) => { if (!cancelled) setMessages(hist.map((m) => ({ ...m }))); });

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
      };
      ws.onmessage = (ev) => {
        if (cancelled) return;
        try { applyFrame(JSON.parse(ev.data as string) as Frame); } catch { /* ignore junk */ }
      };
      ws.onclose = () => {
        if (cancelled || closingRef.current || activeRef.current !== chatId) return;
        setConnected(false);
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
  }, [base, activeId, applyFrame]);

  function send(body: string) {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeId || !me) return;
    const tempId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Optimistic bubble: shown immediately, reconciled by the `sent` frame.
    setMessages((prev) => [
      ...prev,
      { id: tempId, tempId, chatId: activeId, senderId: me.id, body, createdAt: Date.now(), pending: true },
    ]);
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
  const open = activeId != null;

  return (
    <div className="mw-chat" data-open={open ? "1" : "0"}>
      <ChatSidebar
        chats={chats}
        activeId={activeId}
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
              <Avatar url={activeChat.peerAvatarUrl} name={peerName} size="md" />
              <span className="mw-chat__peer" data-case="preserve">{peerName}</span>
              <span className={`mw-chat__status${connected ? " is-on" : ""}`}>
                {connected ? "connected" : "connecting…"}
              </span>
            </header>

            <div className="mw-chat__log" ref={logRef}>
              {messages.length === 0 && (
                <p className="mw-muted" style={{ margin: "auto" }}>no messages yet. say hi 👋</p>
              )}
              {messages.map((m) => {
                const mine = me != null && m.senderId === me.id;
                return (
                  <div key={m.tempId ?? m.id} className={`mw-msg${mine ? " mw-msg--me" : ""}`}>
                    {!mine && <Avatar url={activeChat.peerAvatarUrl} name={peerName} size="sm" />}
                    <div className="mw-msg__col">
                      {!mine && <span className="mw-msg__name" data-case="preserve">{peerName}</span>}
                      <div className={`mw-bubble${mine ? " mw-bubble--me" : ""}${m.pending ? " is-pending" : ""}`}>
                        <span className="mw-bubble__body">{m.body}</span>
                        <span className="mw-bubble__time">{fmtTime(m.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <Composer onSend={send} disabled={!connected} />
          </>
        )}
      </section>
    </div>
  );
}
