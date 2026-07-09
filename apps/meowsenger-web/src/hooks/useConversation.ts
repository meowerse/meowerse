import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { loadHistory, loadHistoryAround, loadHistoryAfter, wsUrl, applyReaction, type Message } from "../lib/chat";
import type { SessionUser } from "../lib/meowsengerApi";
import type { Bubble } from "../components/MessageItem";

/** Server → client WS frames (Slice 2 + Slice 3 presence/typing/receipts + Slice 4
 *  edit/delete, spec §6). */
type Frame =
  | { type: "ready"; chatId: string; you: string }
  | { type: "sent"; tempId: string; message: Message }
  | { type: "message"; message: Message }
  | { type: "presence_snapshot"; online: string[]; away?: string[] }
  | { type: "presence"; userId: string; online: boolean; away?: boolean }
  | { type: "typing"; userId: string; on: boolean }
  | { type: "read_receipt"; userId: string; upTo: number }
  | { type: "edited"; id: string; body: string; editedAt: number }
  | { type: "deleted"; id: string }
  | { type: "reaction"; id: string; emoji: string; userId: string; on: boolean }
  // The server closed this socket because the user was removed from / left the chat
  // (membership revoked) → the client drops the chat and stops reconnecting.
  | { type: "revoked" }
  | { type: "error"; code: string };

// How long the ".is-flash" highlight lingers after a jump-to-original.
const FLASH_MS = 1200;
// A peer's "typing…" auto-clears if no fresh on:true arrives within this window.
const TYPING_TTL_MS = 5000;
// How close to the bottom (px) still counts as "at bottom" for read + autoscroll.
const NEAR_BOTTOM_PX = 80;

/** Human-readable copy for the transient error toast the server can send. */
const ERROR_COPY: Record<string, string> = {
  cannot_edit: "can't edit this message anymore",
  cannot_delete: "can't delete this message anymore",
  bad_body: "message couldn't be sent",
  read_only: "this is a broadcast channel — only admins can post",
  rate_limited: "you're sending too fast — slow down a moment",
};

/**
 * Fire a browser notification for an incoming message while the tab is backgrounded
 * (Slice 9). Conservative — only when the Notification API exists, the document is
 * hidden, and permission is already GRANTED (never auto-requests). Silent no-op
 * otherwise. No service worker / Web Push — the tab must be open.
 */
function maybeNotify(title: string, body: string) {
  if (typeof Notification === "undefined") return;
  if (typeof document !== "undefined" && !document.hidden) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body: body || "sent a message" });
  } catch { /* some browsers throw off a non-SW context — ignore */ }
}

/** What the view passes into the conversation engine. Every callback is mirrored to
 *  a ref inside the hook so `sendRead`/`applyFrame` stay referentially stable — an
 *  unstable one would churn the socket effect's deps and cause a reconnect storm. */
export interface UseConversationInput {
  base: string;
  /** The open chat (null = none). Drives the whole socket + history lifecycle. */
  activeId: string | null;
  /** The signed-in user (for the optimistic bubble senderId + own-message gating). */
  me: SessionUser | null;
  /** Resolve a sender id → display name (for the backgrounded-message notification). */
  resolveSenderName: (senderId: string) => string;
  /** Surface a transient toast (server error frames, jump failures). */
  onToast: (text: string) => void;
  /** A read receipt was sent for `chatId` → the view zeroes its sidebar unread. */
  onActiveRead: (chatId: string) => void;
  /** A `deleted` frame landed → the view drops the id from its own selection set. */
  onMessageDeleted: (id: string) => void;
  /** Called at the EXACT send-dispatch point → the view clears its armed reply. */
  consumeReply: () => void;
  /** The server revoked membership (removed/left) → the view drops the chat + toasts. */
  onRevoked: () => void;
}

export interface UseConversation {
  messages: Bubble[];
  connected: boolean;
  loadingHistory: boolean;
  hasNewer: boolean;
  online: Set<string>;
  away: Set<string>;
  peerTyping: boolean;
  peerLastReadAt: number;
  logRef: RefObject<HTMLDivElement | null>;
  onLogScroll: () => void;
  registerRow: (id: string, el: HTMLDivElement | null) => void;
  /** Read-only mirror of the active chat id, for the view's own async guards. */
  activeRef: RefObject<string | null>;
  send: (body: string, replyToId?: string | null) => void;
  sendEdit: (m: Bubble, body: string) => void;
  sendDelete: (m: Bubble) => void;
  sendReact: (m: Bubble, emoji: string) => void;
  sendTyping: (active: boolean) => void;
  jumpToMessage: (id: string) => Promise<void>;
  jumpToLatest: () => Promise<void>;
  /** Stash a message id to jump to on the NEXT chat open (deep-link + cross-chat search). */
  armJump: (msgId: string) => void;
}

/**
 * The realtime conversation engine for the active chat: owns the message log, the
 * hibernation-aware WebSocket (open/reconnect/backoff), history paging (older /
 * newer / centered-around for deep-link jumps), presence/typing/read-receipts, and
 * the send/edit/delete/react actions — extracted whole from the Chat island so the
 * view is a thin shell over a testable state machine. Every internal ref stays
 * private; the view interacts only through this return object + the input callbacks.
 */
export function useConversation(input: UseConversationInput): UseConversation {
  const { base, activeId, me } = input;

  const [messages, setMessages] = useState<Bubble[]>([]);
  const [connected, setConnected] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [away, setAway] = useState<Set<string>>(new Set());
  const [peerTyping, setPeerTyping] = useState(false);
  const [peerLastReadAt, setPeerLastReadAt] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const rowsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const activeRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const prependingRef = useRef(false);
  const reconnectRef = useRef<{ timer: number | null; attempts: number }>({ timer: null, attempts: 0 });
  const closingRef = useRef(false);
  const typingTimerRef = useRef<number | null>(null);
  const sentTypingRef = useRef(false);
  const atBottomRef = useRef(true);
  const sentReadUpToRef = useRef(0);

  const messagesRef = useRef<Bubble[]>([]);
  const hasMoreRef = useRef(false);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);

  const [hasNewer, setHasNewer] = useState(false);
  const hasNewerRef = useRef(false);
  useEffect(() => { hasNewerRef.current = hasNewer; }, [hasNewer]);
  const loadingNewerRef = useRef(false);
  const pendingJumpRef = useRef<string | null>(null);
  // Set when a `revoked` frame arrives → the onclose handler must NOT reconnect
  // (the /ws gate would reject the now-removed member anyway). Reset per chat switch.
  const revokedRef = useRef(false);

  // Mirror the current user id + all view callbacks into refs so the stable
  // sendRead/applyFrame read the CURRENT values without depending on them (keeping
  // the socket effect from re-firing every render).
  const meIdRef = useRef<string | null>(me?.id ?? null);
  useEffect(() => { meIdRef.current = me?.id ?? null; }, [me]);
  const resolveSenderNameRef = useRef(input.resolveSenderName);
  const onToastRef = useRef(input.onToast);
  const onActiveReadRef = useRef(input.onActiveRead);
  const onMessageDeletedRef = useRef(input.onMessageDeleted);
  const onRevokedRef = useRef(input.onRevoked);
  useEffect(() => {
    resolveSenderNameRef.current = input.resolveSenderName;
    onToastRef.current = input.onToast;
    onActiveReadRef.current = input.onActiveRead;
    onMessageDeletedRef.current = input.onMessageDeleted;
    onRevokedRef.current = input.onRevoked;
  });

  // Send a `read` receipt for the newest message, if we haven't already and the
  // socket is open. Optimistically zeroes the active chat's sidebar unread badge.
  const sendRead = useCallback((msgs: Bubble[]) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || msgs.length === 0) return;
    // Only mark seen when the tab is actually VISIBLE. A background tab must not
    // auto-ack — that would advance the peer's "seen" tick + wipe our unread for
    // messages no human saw. The visibility/focus catch-up re-acks once shown.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const newest = msgs[msgs.length - 1].createdAt;
    if (newest <= sentReadUpToRef.current) return;
    sentReadUpToRef.current = newest;
    ws.send(JSON.stringify({ type: "read", upTo: newest }));
    const chatId = activeRef.current;
    if (chatId) onActiveReadRef.current(chatId);
  }, []);

  // Autoscroll pinned to the newest message — unless prepending older history, in
  // a detached (jumped) window, OR the user has scrolled up to read back. Without
  // the atBottom guard, any incoming frame (message/edit/delete/reaction) re-renders
  // `messages` and teleports a reader to the bottom mid-scroll. Own-sends still pin:
  // send()/initial-load/jumpToLatest all set atBottomRef.current = true first.
  useEffect(() => {
    if (prependingRef.current || hasNewerRef.current || !atBottomRef.current) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Infinite scroll up: load an older page via before=<oldestId> and prepend it,
  // preserving the visual scroll position.
  const loadOlder = useCallback(async () => {
    const el = logRef.current;
    const chatId = activeRef.current;
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
      if (now) now.scrollTop = now.scrollHeight - prevHeight;
      prependingRef.current = false;
      resolve();
    }));
  }, [base]);

  // Forward pagination — only in a detached window (hasNewer). Loads the next page
  // of NEWER messages via after=<newestLoadedId>; a short page ⇒ reattach to live.
  const loadNewer = useCallback(async () => {
    const chatId = activeRef.current;
    if (!chatId || loadingNewerRef.current || !hasNewerRef.current) return;
    const newest = messagesRef.current[messagesRef.current.length - 1];
    if (!newest) return;
    loadingNewerRef.current = true;
    try {
      const rows = await loadHistoryAfter(base, chatId, newest.id);
      if (activeRef.current !== chatId) return;
      if (rows.length > 0) {
        setMessages((prev) => {
          const have = new Set(prev.map((b) => b.id));
          return [...prev, ...rows.filter((m) => !have.has(m.id)).map((m) => ({ ...m }))];
        });
      }
      if (rows.length < 50) {
        hasNewerRef.current = false;
        setHasNewer(false);
        // Catch a message that landed AFTER the historyAfter query but was suppressed
        // while detached: pull the newest page + merge (it overlaps the window's end).
        const tail = await loadHistory(base, chatId);
        if (activeRef.current === chatId && tail.length > 0) {
          setMessages((prev) => {
            const have = new Set(prev.map((b) => b.id));
            return [...prev, ...tail.filter((m) => !have.has(m.id)).map((m) => ({ ...m }))];
          });
        }
      }
    } finally {
      loadingNewerRef.current = false;
    }
  }, [base]);

  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollTop < 60) void loadOlder();
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < 120 && hasNewerRef.current) void loadNewer();
    const atBottom = dist < NEAR_BOTTOM_PX;
    atBottomRef.current = atBottom;
    if (atBottom && !hasNewerRef.current) setMessages((prev) => { sendRead(prev); return prev; });
  }, [loadOlder, loadNewer, sendRead]);

  const applyFrame = useCallback((frame: Frame) => {
    if (frame.type === "sent") {
      setMessages((prev) => prev.map((b) => (b.tempId && b.tempId === frame.tempId ? { ...frame.message } : b)));
    } else if (frame.type === "message") {
      // A live message belongs at the tail. In a DETACHED window (hasNewer) the tail
      // isn't loaded, so appending would render it out of context → skip; the unread
      // badge + "jump to latest" surface it. Otherwise append (dedupe by id).
      if (!hasNewerRef.current) {
        setMessages((prev) => {
          if (prev.some((b) => b.id === frame.message.id)) return prev;
          const next = [...prev, { ...frame.message }];
          if (atBottomRef.current) sendRead(next);
          return next;
        });
      }
      if (frame.message.senderId !== meIdRef.current) {
        maybeNotify(resolveSenderNameRef.current(frame.message.senderId), frame.message.body);
      }
    } else if (frame.type === "presence_snapshot") {
      setOnline(new Set(frame.online));
      setAway(new Set(frame.away ?? []));
    } else if (frame.type === "presence") {
      setOnline((prev) => {
        const next = new Set(prev);
        if (frame.online) next.add(frame.userId); else next.delete(frame.userId);
        return next;
      });
      setAway((prev) => {
        const next = new Set(prev);
        if (frame.online && frame.away) next.add(frame.userId); else next.delete(frame.userId);
        return next;
      });
    } else if (frame.type === "typing") {
      setPeerTyping(frame.on);
      if (typingTimerRef.current != null) clearTimeout(typingTimerRef.current);
      if (frame.on) typingTimerRef.current = window.setTimeout(() => setPeerTyping(false), TYPING_TTL_MS);
    } else if (frame.type === "read_receipt") {
      setPeerLastReadAt((prev) => Math.max(prev, frame.upTo));
    } else if (frame.type === "edited") {
      setMessages((prev) => prev.map((b) => (b.id === frame.id ? { ...b, body: frame.body, editedAt: frame.editedAt } : b)));
    } else if (frame.type === "deleted") {
      setMessages((prev) => prev.map((b) => (b.id === frame.id ? { ...b, isDeleted: true, body: "" } : b)));
      onMessageDeletedRef.current(frame.id);
    } else if (frame.type === "reaction") {
      const isMine = frame.userId === meIdRef.current;
      setMessages((prev) => prev.map((b) =>
        b.id === frame.id ? { ...b, reactions: applyReaction(b.reactions, frame.emoji, frame.on, isMine) } : b,
      ));
    } else if (frame.type === "revoked") {
      // Membership revoked (removed/left). Mark it so the imminent onclose does NOT
      // reconnect, then let the view drop the chat + toast.
      revokedRef.current = true;
      onRevokedRef.current();
    } else if (frame.type === "error") {
      onToastRef.current(ERROR_COPY[frame.code] ?? "something went wrong");
    }
  }, [sendRead]);

  const sendTyping = useCallback((active: boolean) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (active === sentTypingRef.current) return;
    sentTypingRef.current = active;
    ws.send(JSON.stringify({ type: "typing", on: active }));
  }, []);

  const sendAway = useCallback((awayNow: boolean) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "away", away: awayNow }));
  }, []);
  useEffect(() => {
    function onVis() { sendAway(document.visibilityState !== "visible"); }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [sendAway]);

  // On return to the tab, if the open chat is pinned to the bottom, ack whatever
  // arrived while away (the visibility gate suppressed it live). A scrolled-up user
  // isn't auto-acked. (The view runs its own focus/visibility listeners for the
  // sidebar-list refresh — these are independent.)
  useEffect(() => {
    function catchUpRead() {
      if (document.visibilityState !== "visible") return;
      if (activeRef.current && atBottomRef.current) sendRead(messagesRef.current);
    }
    function onFocus() { catchUpRead(); }
    function onVisible() { if (document.visibilityState === "visible") catchUpRead(); }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sendRead]);

  // Open exactly ONE socket to the active chat; reload history on select. The view's
  // per-chat UI resets (menus/selection/etc.) live in a SEPARATE view-side effect.
  useEffect(() => {
    activeRef.current = activeId;
    setOnline(new Set());
    setAway(new Set());
    setPeerTyping(false);
    setPeerLastReadAt(0);
    sentTypingRef.current = false;
    sentReadUpToRef.current = 0;
    atBottomRef.current = true;
    revokedRef.current = false;
    rowsRef.current.clear();
    if (typingTimerRef.current != null) { clearTimeout(typingTimerRef.current); typingTimerRef.current = null; }
    if (!activeId) return;
    const chatId = activeId;
    // Grab (and clear) a pending ?m deep-link jump for THIS chat synchronously, so a
    // fast switch away before history loads can't leak it into the next chat's load.
    const pendingJump = pendingJumpRef.current;
    pendingJumpRef.current = null;

    let cancelled = false;
    setMessages([]);
    setConnected(false);
    setHasMore(false);
    setHasNewer(false);
    loadingNewerRef.current = false;
    setLoadingHistory(true);
    prependingRef.current = false;
    loadHistory(base, chatId).then((hist) => {
      if (cancelled) return;
      setLoadingHistory(false);
      setMessages(hist.map((m) => ({ ...m })));
      setHasMore(hist.length >= 50);
      if (hist.length > 0) sendRead(hist.map((m) => ({ ...m })));
      if (pendingJump) requestAnimationFrame(() => { if (!cancelled && activeRef.current === chatId) void jumpToMessage(pendingJump); });
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
        sentReadUpToRef.current = 0;
        if (atBottomRef.current) setMessages((prev) => { sendRead(prev); return prev; });
        if (typeof document !== "undefined") sendAway(document.visibilityState !== "visible");
      };
      ws.onmessage = (ev) => {
        if (cancelled) return;
        try { applyFrame(JSON.parse(ev.data as string) as Frame); } catch { /* ignore junk */ }
      };
      ws.onclose = () => {
        if (cancelled || closingRef.current || activeRef.current !== chatId) return;
        setConnected(false);
        sentTypingRef.current = false;
        // Membership was revoked → don't reconnect (the /ws gate would reject us now).
        if (revokedRef.current) return;
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

  function send(body: string, replyToId?: string | null) {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeId || !me) return;
    // Sending from a detached window: snap back to the live tail first so the
    // optimistic bubble lands in context, then resend — only if still the SAME chat
    // (a switch during the reload must not redeliver into the newly-opened chat).
    if (hasNewerRef.current) {
      const at = activeRef.current;
      void jumpToLatest().then(() => { if (activeRef.current === at) send(body, replyToId); });
      return;
    }
    const tempId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parent = replyToId ? messages.find((m) => m.id === replyToId && !m.isDeleted) : undefined;
    const replyTo = parent ? { id: parent.id, senderId: parent.senderId, body: parent.body.slice(0, 120) } : null;
    setMessages((prev) => [
      ...prev,
      { id: tempId, tempId, chatId: activeId, senderId: me.id, body, createdAt: Date.now(), pending: true, replyToId: replyToId ?? null, replyTo },
    ]);
    atBottomRef.current = true;
    ws.send(JSON.stringify({ type: "send", tempId, body, ...(replyToId ? { replyToId } : {}) }));
    input.consumeReply();
  }

  function sendEdit(m: Bubble, body: string) {
    const trimmed = body.trim();
    if (!trimmed || trimmed === m.body) return;
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setMessages((prev) => prev.map((b) => (b.id === m.id ? { ...b, body: trimmed, editedAt: Date.now() } : b)));
    ws.send(JSON.stringify({ type: "edit", id: m.id, body: trimmed }));
  }
  function sendDelete(m: Bubble) {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "delete", id: m.id }));
  }
  function sendReact(m: Bubble, emoji: string) {
    if (m.pending || m.isDeleted) return;
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setMessages((prev) => prev.map((b) => {
      if (b.id !== m.id) return b;
      const mineNow = (b.reactions ?? []).find((r) => r.emoji === emoji)?.mine ?? false;
      return { ...b, reactions: applyReaction(b.reactions, emoji, !mineNow, true) };
    }));
    ws.send(JSON.stringify({ type: "react", id: m.id, emoji }));
  }

  const registerRow = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowsRef.current.set(id, el);
    else rowsRef.current.delete(id);
  }, []);

  // Scroll a loaded message into view + flash it once it lands on screen (the smooth
  // scroll is async, so the flash starts on arrival via an IntersectionObserver).
  function flashRow(id: string): boolean {
    const el = rowsRef.current.get(id);
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    let flashed = false;
    const flash = () => {
      if (flashed) return;
      flashed = true;
      el.classList.add("is-flash");
      const done = () => { el.classList.remove("is-flash"); el.removeEventListener("animationend", done); };
      el.addEventListener("animationend", done);
      window.setTimeout(done, FLASH_MS + 500);
    };
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); flash(); }
    }, { root: logRef.current, threshold: 0.5 });
    io.observe(el);
    window.setTimeout(() => { io.disconnect(); flash(); }, 1500);
    return true;
  }

  // Jump to any message by id: if loaded, scroll + flash. Otherwise fetch a window
  // AROUND it (historyAround, O(1)), replace the log (detached when hasNewer), flash
  // once it renders. Toast if it can't be found.
  async function jumpToMessage(id: string): Promise<void> {
    if (flashRow(id)) return;
    const chatId = activeRef.current;
    if (!chatId) return;
    let around;
    try { around = await loadHistoryAround(base, chatId, id); }
    catch { onToastRef.current("couldn't load that message"); return; }
    if (activeRef.current !== chatId) return;
    if (!around.found) { onToastRef.current("message not found"); return; }
    prependingRef.current = true;
    setMessages(around.messages.map((m) => ({ ...m })));
    setHasMore(around.hasOlder);
    setHasNewer(around.hasNewer);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    prependingRef.current = false;
    flashRow(id);
  }

  // Snap back to the live tail from a detached window: reload the newest page + reattach.
  const jumpToLatest = useCallback(async () => {
    const chatId = activeRef.current;
    if (!chatId) return;
    const hist = await loadHistory(base, chatId);
    if (activeRef.current !== chatId) return;
    hasNewerRef.current = false;
    setHasNewer(false);
    setMessages(hist.map((m) => ({ ...m })));
    setHasMore(hist.length >= 50);
    atBottomRef.current = true;
    if (hist.length > 0) sendRead(hist.map((m) => ({ ...m })));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [base, sendRead]);

  const armJump = useCallback((msgId: string) => { pendingJumpRef.current = msgId; }, []);

  return {
    messages, connected, loadingHistory, hasNewer, online, away, peerTyping, peerLastReadAt,
    logRef, onLogScroll, registerRow, activeRef,
    send, sendEdit, sendDelete, sendReact, sendTyping,
    jumpToMessage, jumpToLatest, armJump,
  };
}
