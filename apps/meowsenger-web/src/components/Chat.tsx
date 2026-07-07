import { useCallback, useEffect, useRef, useState } from "react";
import { getSession, type SessionUser } from "../lib/meowsengerApi";
import { listChats, openDirect, loadHistory, wsUrl, type ChatSummary, type Message } from "../lib/chat";
import { ChatSidebar } from "./ChatSidebar";
import { Composer, type ReplyDraft } from "./Composer";
import { MessageItem, type Bubble } from "./MessageItem";
import { MessageMenu, type MenuItem } from "./MessageMenu";
import { Avatar } from "./Avatar";

/** Server → client WS frames (Slice 2 + Slice 3 presence/typing/receipts + Slice 4
 *  edit/delete, spec §6). */
type Frame =
  | { type: "ready"; chatId: string; you: string }
  | { type: "sent"; tempId: string; message: Message }
  | { type: "message"; message: Message }
  | { type: "presence_snapshot"; online: string[] }
  | { type: "presence"; userId: string; online: boolean }
  | { type: "typing"; userId: string; on: boolean }
  | { type: "read_receipt"; userId: string; upTo: number }
  | { type: "edited"; id: string; body: string; editedAt: number }
  | { type: "deleted"; id: string }
  | { type: "error"; code: string };

// Own-message action windows (UX gating only — the server enforces both, §7).
const EDIT_WINDOW_MS = 3600_000; // 1h
const DELETE_WINDOW_MS = 24 * 3600_000; // 24h
// Max older-history pages to fetch while hunting for a reply's original message.
const JUMP_MAX_PAGES = 10;
// How long the ".is-flash" highlight lingers after a jump-to-original.
const FLASH_MS = 1200;

/** Human-readable copy for the transient error toast the server can send. */
const ERROR_COPY: Record<string, string> = {
  cannot_edit: "can't edit this message anymore",
  cannot_delete: "can't delete this message anymore",
  bad_body: "message couldn't be sent",
};

// A peer's "typing…" auto-clears if no fresh on:true arrives within this window
// (covers a dropped on:false — e.g. the peer's tab closed mid-type).
const TYPING_TTL_MS = 5000;
// How close to the bottom (px) still counts as "at bottom" for read + autoscroll.
const NEAR_BOTTOM_PX = 80;
// Background poll cadence to surface unread for non-active chats (v1 simplification).
const SIDEBAR_POLL_MS = 15000;

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
  // Slice 4 — message-actions UI state.
  const [replyingTo, setReplyingTo] = useState<Bubble | null>(null); // armed reply
  const [editingId, setEditingId] = useState<string | null>(null); // inline-editing this id
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // selected message ids
  const [menu, setMenu] = useState<{ m: Bubble; x: number; y: number } | null>(null); // context menu
  const [toast, setToast] = useState<string | null>(null); // transient non-blocking note

  const socketRef = useRef<WebSocket | null>(null);
  // Live message-row elements by real id, for jump-to-original scroll + highlight.
  const rowsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const toastTimerRef = useRef<number | null>(null);
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

  // Ref mirrors of state that loadOlder reads while awaited in a loop (reply-jump),
  // where a captured-render closure would go stale after each prepend.
  const messagesRef = useRef<Bubble[]>([]);
  const hasMoreRef = useRef(false);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);

  const activeChat = chats.find((c) => c.id === activeId) ?? null;
  const peerId = activeChat?.peerId ?? null;

  // Load who-am-i + the sidebar list once.
  useEffect(() => {
    getSession(base).then((s) => setMe(s.user ?? null));
    listChats(base).then((cs) => { setChats(cs); setLoadingChats(false); });
  }, [base]);

  // Clear the toast timer on unmount so it can't fire into a dead component.
  useEffect(() => () => { if (toastTimerRef.current != null) clearTimeout(toastTimerRef.current); }, []);

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
    // Read via refs so an awaited call in a loop (reply-jump) sees fresh values.
    if (!el || !chatId || prependingRef.current || !hasMoreRef.current) return;
    const oldest = messagesRef.current[0];
    if (!oldest) return;
    prependingRef.current = true;
    const prevHeight = el.scrollHeight;
    const older = await loadHistory(base, chatId, oldest.id);
    if (activeRef.current !== chatId) { prependingRef.current = false; return; }
    setHasMore(older.length >= 50);
    setMessages((prev) => [...older.map((m) => ({ ...m })), ...prev]);
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      const now = logRef.current;
      if (now) now.scrollTop = now.scrollHeight - prevHeight; // keep the same message under the cursor
      prependingRef.current = false;
      resolve();
    }));
  }, [base]);

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

  // Surface a small transient note (e.g. a server rejection). Non-blocking: it
  // auto-dismisses after a few seconds and never interrupts typing.
  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current != null) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

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
    } else if (frame.type === "edited") {
      // In-place body + editedAt update (broadcast to ALL, incl. the editor's tabs).
      setMessages((prev) => prev.map((b) => (b.id === frame.id ? { ...b, body: frame.body, editedAt: frame.editedAt } : b)));
    } else if (frame.type === "deleted") {
      // Soft delete: blank the body + flag it → renders a "message deleted" placeholder.
      setMessages((prev) => prev.map((b) => (b.id === frame.id ? { ...b, isDeleted: true, body: "" } : b)));
      // Drop it from any active selection so a bulk action can't touch a tombstone.
      setSelected((prev) => { if (!prev.has(frame.id)) return prev; const n = new Set(prev); n.delete(frame.id); return n; });
    } else if (frame.type === "error") {
      showToast(ERROR_COPY[frame.code] ?? "something went wrong");
    }
  }, [sendRead, showToast]);

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
    // Reset per-chat message-actions state so nothing leaks across chats.
    setReplyingTo(null);
    setEditingId(null);
    setSelectMode(false);
    setSelected(new Set());
    setMenu(null);
    rowsRef.current.clear();
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

  function send(body: string, replyToId?: string | null) {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeId || !me) return;
    const tempId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Build an optimistic reply snippet from the armed message so the quoted
    // preview shows instantly; the `sent` frame replaces it with the server's.
    const parent = replyToId ? messages.find((m) => m.id === replyToId && !m.isDeleted) : undefined;
    const replyTo = parent ? { id: parent.id, senderId: parent.senderId, body: parent.body.slice(0, 120) } : null;
    // Optimistic bubble: shown immediately, reconciled by the `sent` frame.
    setMessages((prev) => [
      ...prev,
      { id: tempId, tempId, chatId: activeId, senderId: me.id, body, createdAt: Date.now(), pending: true, replyToId: replyToId ?? null, replyTo },
    ]);
    atBottomRef.current = true; // my own send scrolls me to the bottom
    ws.send(JSON.stringify({ type: "send", tempId, body, ...(replyToId ? { replyToId } : {}) }));
    setReplyingTo(null); // consume the armed reply
  }

  // Reply/edit/delete over the socket. Ownership + windows are UX gating only —
  // the server re-checks and answers {error} if it disagrees (surfaced as a toast).
  function sendWith(body: string) {
    send(body, replyingTo?.id ?? null);
  }
  function sendEdit(m: Bubble, body: string) {
    const trimmed = body.trim();
    setEditingId(null);
    if (!trimmed || trimmed === m.body) return; // no-op edit — nothing to send
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Optimistic in-place update; the `edited` broadcast confirms (or an `error` toast reverts nothing).
    setMessages((prev) => prev.map((b) => (b.id === m.id ? { ...b, body: trimmed, editedAt: Date.now() } : b)));
    ws.send(JSON.stringify({ type: "edit", id: m.id, body: trimmed }));
  }
  function sendDelete(m: Bubble) {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "delete", id: m.id }));
  }

  // Can I still edit / delete this message? (own + within window, ignoring optimistic
  // bubbles and tombstones). Mirrors the server's checks — purely for showing the action.
  function canEdit(m: Bubble): boolean {
    return !!me && m.senderId === me.id && !m.pending && !m.isDeleted && Date.now() - m.createdAt <= EDIT_WINDOW_MS;
  }
  function canDelete(m: Bubble): boolean {
    return !!me && m.senderId === me.id && !m.pending && !m.isDeleted && Date.now() - m.createdAt <= DELETE_WINDOW_MS;
  }

  // Copy one message's body to the clipboard (best-effort; a note on success).
  function copyText(text: string) {
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => showToast("copied"), () => showToast("couldn't copy"));
  }

  // Register/unregister a message row element for jump-to-original.
  const registerRow = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowsRef.current.set(id, el);
    else rowsRef.current.delete(id);
  }, []);

  // Scroll a loaded message into view and flash it briefly.
  function flashRow(id: string) {
    const el = rowsRef.current.get(id);
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("is-flash");
    window.setTimeout(() => el.classList.remove("is-flash"), FLASH_MS);
    return true;
  }

  // Jump to a reply's original: if it's loaded, scroll + flash; otherwise page
  // older history (capped) until the id appears, then flash. No-op if never found.
  async function jumpToReply(id: string) {
    if (flashRow(id)) return;
    for (let i = 0; i < JUMP_MAX_PAGES; i++) {
      if (!hasMoreRef.current) break;
      await loadOlder();
      // Let the prepend commit + refs register before we look again.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (rowsRef.current.has(id)) { flashRow(id); return; }
    }
  }

  // ---- selection / multi-select action bar ----
  function enterSelect(seed?: Bubble) {
    setSelectMode(true);
    setMenu(null);
    setSelected(seed && !seed.isDeleted ? new Set([seed.id]) : new Set());
  }
  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }
  function toggleSelect(m: Bubble) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(m.id)) n.delete(m.id); else n.add(m.id);
      return n;
    });
  }
  function copySelected() {
    const text = messages
      .filter((m) => selected.has(m.id) && !m.isDeleted)
      .map((m) => m.body)
      .join("\n");
    copyText(text);
    exitSelect();
  }
  function deleteSelected() {
    // Bulk-delete only my own, still-deletable messages; silently skip the rest.
    for (const m of messages) {
      if (selected.has(m.id) && canDelete(m)) sendDelete(m);
    }
    exitSelect();
  }

  // Build the per-message context-menu items (gated by ownership + window).
  function menuItems(m: Bubble): MenuItem[] {
    const items: MenuItem[] = [{ label: "reply", onClick: () => setReplyingTo(m) }];
    if (canEdit(m)) items.push({ label: "edit", onClick: () => setEditingId(m.id) });
    if (canDelete(m)) items.push({ label: "delete", onClick: () => sendDelete(m) });
    items.push({ label: "copy", onClick: () => copyText(m.body) });
    items.push({ label: "select", onClick: () => enterSelect(m) });
    return items;
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

  // The reply chip shown above the composer, derived from the armed message.
  const replyDraft: ReplyDraft | null = replyingTo
    ? {
        id: replyingTo.id,
        name: me != null && replyingTo.senderId === me.id ? "yourself" : peerName,
        preview: replyingTo.body.slice(0, 120),
      }
    : null;

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
                  <MessageItem
                    key={key}
                    m={m}
                    meId={me?.id ?? null}
                    mine={mine}
                    peerName={peerName}
                    peerAvatarUrl={activeChat.peerAvatarUrl}
                    seen={seen}
                    canEdit={canEdit(m)}
                    canDelete={canDelete(m)}
                    selectMode={selectMode}
                    selected={selected.has(m.id)}
                    editing={editingId === m.id}
                    onReply={setReplyingTo}
                    onStartEdit={(mm) => setEditingId(mm.id)}
                    onCancelEdit={() => setEditingId(null)}
                    onSaveEdit={sendEdit}
                    onDelete={sendDelete}
                    onToggleSelect={toggleSelect}
                    onContextMenu={(mm, x, y) => setMenu({ m: mm, x, y })}
                    onJumpToReply={jumpToReply}
                    registerRef={registerRow}
                  />
                );
              })}
            </div>

            {selectMode ? (
              <div className="mw-selectbar" role="toolbar" aria-label="selection actions">
                <span className="mw-selectbar__count">{selected.size} selected</span>
                <span className="mw-selectbar__spacer" />
                <button
                  className="mw-btn mw-btn--ghost mw-btn--sm"
                  onClick={copySelected}
                  disabled={selected.size === 0}
                >copy</button>
                <button
                  className="mw-btn mw-btn--ghost mw-btn--sm mw-selectbar__danger"
                  onClick={deleteSelected}
                  disabled={selected.size === 0}
                >delete</button>
                <button className="mw-btn mw-btn--primary mw-btn--sm" onClick={exitSelect}>cancel</button>
              </div>
            ) : (
              <Composer
                onSend={sendWith}
                onTyping={sendTyping}
                disabled={!connected}
                replyTo={replyDraft}
                onCancelReply={() => setReplyingTo(null)}
              />
            )}
          </>
        )}
      </section>

      {menu && (
        <MessageMenu x={menu.x} y={menu.y} items={menuItems(menu.m)} onClose={() => setMenu(null)} />
      )}
      {toast && <div className="mw-toast" role="status">{toast}</div>}
    </div>
  );
}
