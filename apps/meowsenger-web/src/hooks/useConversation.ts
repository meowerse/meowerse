import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { loadHistory, loadHistoryAround, loadHistoryAfter, wsUrl, applyReaction, type Message } from "../lib/chat";
import type { SessionUser } from "../lib/meowsengerApi";
import type { Bubble } from "../components/MessageItem";
import { pushConfirmedFor } from "../lib/push";

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

/** The server's message-body limit (conversation DO `bad_body`). Mirrored client-side. */
export const MAX_BODY = 4000;
/** Per-chat cap on queued (unsent) items, so a long offline stretch can't grow without bound. */
const OUTBOX_MAX = 100;

/** The outcome of a send/edit/delete request. The composer clears its text only on
 *  "sent" or "queued"; "rejected" keeps what the user typed. */
export type SendResult = "sent" | "queued" | "rejected";

/** One queued action, held in memory only (never persisted: bodies must not reach
 *  localStorage/sessionStorage/IndexedDB). A send keeps the client `tempId` it was
 *  given at enqueue time and reuses it on flush -- never regenerated -- so the server
 *  can dedupe on (senderId, tempId) once it is idempotent (PR-4). */
type OutboxItem =
  | { kind: "send"; tempId: string; body: string; replyToId: string | null; replyTo: Bubble["replyTo"]; createdAt: number }
  | { kind: "edit"; id: string; body: string; editedAt: number }
  | { kind: "delete"; id: string };

/** Human-readable copy for the transient error toast the server can send. */
const ERROR_COPY: Record<string, string> = {
  cannot_edit: "can't edit this message anymore",
  cannot_delete: "can't delete this message anymore",
  bad_body: "message couldn't be sent",
  read_only: "this is a broadcast channel — only admins can post",
  rate_limited: "you're sending too fast — slow down a moment",
};

/** Same tag the service worker uses (public/sw.js), so an in-page and a push
 *  notification for the same burst collapse into one. */
const NOTIFY_TAG = "meowsenger-msg";

/**
 * Notify about an incoming message while the tab is backgrounded (Slice 9).
 * Conservative — only when the Notification API exists, the document is hidden, and
 * permission is already GRANTED (never auto-requests). When this device's push
 * subscription is confirmed for this account the service worker's push already covers it, so nothing is shown
 * here (no double notification). Otherwise it goes through the SW registration with the
 * SW's tag (so duplicates collapse), falling back to a page Notification.
 */
async function maybeNotify(title: string, body: string, meId: string, chatId: string): Promise<void> {
  if (typeof Notification === "undefined") return;
  if (typeof document !== "undefined" && !document.hidden) return;
  if (Notification.permission !== "granted") return;
  const text = body || "sent a message";
  try {
    if (await pushConfirmedFor(meId)) return; // the SW push covers this device (confirmed for this account)
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, { body: text, tag: NOTIFY_TAG, data: { chatId } }); // same shape as the SW's, so a tap opens the chat
      return;
    }
  } catch { /* fall through to the page notification */ }
  try {
    new Notification(title, { body: text, tag: NOTIFY_TAG });
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
  /** A live message arrived in the OPEN chat → the view updates that chat's sidebar
   *  row (preview + move-to-top) in realtime, without waiting for the poll/inbox.
   *  Optional so hook-only tests can omit it. */
  onActiveMessage?: (message: Message) => void;
  /** A `deleted` frame landed → the view drops the id from its own selection set. */
  onMessageDeleted: (id: string) => void;
  /** Called at the EXACT send-dispatch point → the view clears its armed reply. */
  consumeReply: () => void;
  /** The server revoked membership (removed/left) → the view drops the chat + toasts. */
  onRevoked: () => void;
}

/** A definitive 403 from a history read: the caller is no longer a member of the chat. */
function isForbidden(res: { ok: boolean; error?: { kind: string; status?: number } }): boolean {
  return !res.ok && res.error?.kind === "http" && res.error.status === 403;
}

export interface UseConversation {
  messages: Bubble[];
  connected: boolean;
  loadingHistory: boolean;
  historyError: boolean;
  olderError: boolean;
  retryHistory: () => Promise<void>;
  retryOlder: () => Promise<void>;
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
  /** Send, or queue in the per-chat in-memory outbox when the socket isn't open. */
  send: (body: string, replyToId?: string | null) => SendResult;
  sendEdit: (m: Bubble, body: string) => SendResult;
  sendDelete: (m: Bubble) => SendResult;
  /** How many actions are queued (unsent) across ALL chats; for the session-ended snapshot. */
  queuedCount: () => number;
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
  // The initial history load failed (network/5xx/403) — NOT the same as "no messages".
  const [historyError, setHistoryError] = useState(false);
  // Loading an OLDER page failed — render a retry row instead of silently stopping.
  const [olderError, setOlderError] = useState(false);
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

  // Per-chat outbox (memory only). The ref is the source of truth; `outboxTick` makes
  // React re-derive the queued bubbles. Entries live until flushed over an OPEN socket
  // of THEIR chat, so switching chats keeps each chat's queue separate and intact.
  const outboxRef = useRef<Map<string, OutboxItem[]>>(new Map());
  const [outboxTick, setOutboxTick] = useState(0);
  const bumpOutbox = useCallback(() => setOutboxTick((n) => n + 1), []);

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
  const onActiveMessageRef = useRef(input.onActiveMessage);
  const onMessageDeletedRef = useRef(input.onMessageDeleted);
  const onRevokedRef = useRef(input.onRevoked);
  useEffect(() => {
    resolveSenderNameRef.current = input.resolveSenderName;
    onToastRef.current = input.onToast;
    onActiveReadRef.current = input.onActiveRead;
    onActiveMessageRef.current = input.onActiveMessage;
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
    const olderRes = await loadHistory(base, chatId, oldest.id);
    if (activeRef.current !== chatId) { prependingRef.current = false; return; }
    if (!olderRes.ok) {
      if (isForbidden(olderRes)) { prependingRef.current = false; onRevokedRef.current(); return; }
      // Keep paging possible + show a retry row; never treat a failure as "start of chat".
      prependingRef.current = false;
      setOlderError(true);
      return;
    }
    setOlderError(false);
    const older = olderRes.data;
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
      const rowsRes = await loadHistoryAfter(base, chatId, newest.id);
      if (activeRef.current !== chatId) return;
      if (!rowsRes.ok) return; // stay detached; the next scroll retries
      const rows = rowsRes.data;
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
        const tailRes = await loadHistory(base, chatId);
        if (activeRef.current === chatId && tailRes.ok && tailRes.data.length > 0) {
          const tail = tailRes.data;
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
      onActiveMessageRef.current?.(frame.message); // my own send → refresh this chat's sidebar row
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
        void maybeNotify(resolveSenderNameRef.current(frame.message.senderId), frame.message.body, meIdRef.current ?? "", frame.message.chatId);
      }
      onActiveMessageRef.current?.(frame.message); // realtime sidebar preview for the open chat
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

  // Drain the ACTIVE chat's outbox, in order, over its open socket. A item leaves the
  // queue only after `ws.send` returned without throwing, so a close race (readyState
  // CLOSING, or a throw) leaves it queued for the next open instead of dropping it.
  // The flushed send reuses the tempId minted at enqueue time (PR-4 will dedupe the
  // server side on (senderId, tempId); an unacked item resent after a reconnect must
  // carry that same id -- hook point for the PR-4 client resend).
  const flushOutbox = useCallback(() => {
    const chatId = activeRef.current;
    const ws = socketRef.current;
    const myId = meIdRef.current;
    if (!chatId || !ws || ws.readyState !== WebSocket.OPEN || !myId || hasNewerRef.current) return;
    const q = outboxRef.current.get(chatId);
    if (!q || q.length === 0) return;
    let changed = false;
    while (q.length > 0) {
      const item = q[0];
      try {
        if (item.kind === "send") {
          ws.send(JSON.stringify({ type: "send", tempId: item.tempId, body: item.body, ...(item.replyToId ? { replyToId: item.replyToId } : {}) }));
        } else if (item.kind === "edit") {
          ws.send(JSON.stringify({ type: "edit", id: item.id, body: item.body }));
        } else {
          ws.send(JSON.stringify({ type: "delete", id: item.id }));
        }
      } catch { break; }
      q.shift();
      changed = true;
      if (item.kind === "send") {
        const optimistic: Bubble = {
          id: item.tempId, tempId: item.tempId, chatId, senderId: myId, body: item.body,
          createdAt: item.createdAt, pending: true, replyToId: item.replyToId, replyTo: item.replyTo,
        };
        setMessages((prev) => (prev.some((b) => b.tempId === item.tempId) ? prev : [...prev, optimistic]));
        atBottomRef.current = true;
        onActiveMessageRef.current?.(optimistic);
      } else if (item.kind === "edit") {
        setMessages((prev) => prev.map((b) => (b.id === item.id ? { ...b, body: item.body, editedAt: item.editedAt } : b)));
      }
    }
    if (q.length === 0) outboxRef.current.delete(chatId);
    if (changed) bumpOutbox();
  }, [bumpOutbox]);

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
    setHistoryError(false);
    setOlderError(false);
    loadHistory(base, chatId).then((res) => {
      if (cancelled) return;
      setLoadingHistory(false);
      if (!res.ok) {
        // 403 = no longer a member: close the chat with the revoked copy, no retry loop.
        if (isForbidden(res)) { onRevokedRef.current(); return; }
        setHistoryError(true);
        return;
      }
      const hist = res.data;
      // Keep in-flight (flushed, un-acked) bubbles: a fast socket can flush the outbox
      // before this history read lands, and it must not wipe them.
      setMessages((prev) => {
        const have = new Set(hist.map((m) => m.id));
        return [...hist.map((m) => ({ ...m })), ...prev.filter((b) => b.pending && !have.has(b.id))];
      });
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
        flushOutbox();
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

    const onWake = () => {
      if (cancelled || closingRef.current || revokedRef.current || activeRef.current !== chatId) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const ws = socketRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        clearReconnect();
        reconnectRef.current.attempts = 0;
        connect();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onWake);
      document.addEventListener("visibilitychange", onWake);
    }

    return () => {
      cancelled = true;
      closingRef.current = true;
      clearReconnect();
      reconnectRef.current.attempts = 0;
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onWake);
        document.removeEventListener("visibilitychange", onWake);
      }
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* already closed */ } }
    };
  }, [base, activeId, applyFrame, sendRead, flushOutbox]);

  function enqueue(chatId: string, item: OutboxItem): boolean {
    const q = outboxRef.current.get(chatId) ?? [];
    if (q.length >= OUTBOX_MAX) { onToastRef.current("too many unsent changes — wait for the connection to return"); return false; }
    q.push(item);
    outboxRef.current.set(chatId, q);
    bumpOutbox();
    return true;
  }
  /** Drop queued items for a message (a newer edit/delete supersedes them). */
  function dropQueued(chatId: string, id: string, kinds: Array<OutboxItem["kind"]>) {
    const q = outboxRef.current.get(chatId);
    if (!q) return;
    const kept = q.filter((i) => !(kinds.includes(i.kind) && "id" in i && i.id === id));
    if (kept.length === q.length) return;
    if (kept.length === 0) outboxRef.current.delete(chatId); else outboxRef.current.set(chatId, kept);
  }
  /** After enqueueing: try to flush now; report whether the item actually left the queue. */
  function settle(chatId: string, item: OutboxItem): SendResult {
    flushOutbox();
    return outboxRef.current.get(chatId)?.includes(item) ? "queued" : "sent";
  }

  function send(body: string, replyToId?: string | null): SendResult {
    if (!activeId || !me) {
      onToastRef.current("couldn't send — you're not signed in to this chat yet");
      return "rejected";
    }
    if (!body.trim() || body.length > MAX_BODY) return "rejected";
    const chatId = activeId;
    const tempId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parent = replyToId ? messages.find((m) => m.id === replyToId && !m.isDeleted) : undefined;
    const replyTo = parent ? { id: parent.id, senderId: parent.senderId, body: parent.body.slice(0, 120) } : null;
    const item: OutboxItem = { kind: "send", tempId, body, replyToId: replyToId ?? null, replyTo, createdAt: Date.now() };
    if (!enqueue(chatId, item)) return "rejected";
    atBottomRef.current = true;
    input.consumeReply();
    // A detached (jumped) window snaps back to the live tail first so the bubble lands
    // in context; the item stays queued (and visible state is unchanged) until then, and
    // is flushed once the tail is loaded -- never dropped if the reload is slow or fails.
    if (hasNewerRef.current) {
      void jumpToLatest(); // flushes the outbox itself once the live tail is attached
      return "queued";
    }
    return settle(chatId, item);
  }

  function sendEdit(m: Bubble, body: string): SendResult {
    const trimmed = body.trim();
    if (!trimmed || trimmed === m.body || trimmed.length > MAX_BODY || !activeId) return "rejected";
    const chatId = activeId;
    dropQueued(chatId, m.id, ["edit"]);
    const item: OutboxItem = { kind: "edit", id: m.id, body: trimmed, editedAt: Date.now() };
    if (!enqueue(chatId, item)) return "rejected";
    return settle(chatId, item);
  }
  function sendDelete(m: Bubble): SendResult {
    if (!activeId) return "rejected";
    const chatId = activeId;
    dropQueued(chatId, m.id, ["edit", "delete"]);
    const item: OutboxItem = { kind: "delete", id: m.id };
    if (!enqueue(chatId, item)) return "rejected";
    return settle(chatId, item);
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
    const histRes = await loadHistory(base, chatId);
    if (activeRef.current !== chatId) return;
    if (!histRes.ok) { onToastRef.current("couldn't load the latest messages. try again."); return; }
    const hist = histRes.data;
    hasNewerRef.current = false;
    setHasNewer(false);
    setMessages(hist.map((m) => ({ ...m })));
    setHasMore(hist.length >= 50);
    atBottomRef.current = true;
    if (hist.length > 0) sendRead(hist.map((m) => ({ ...m })));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    flushOutbox(); // anything queued while detached can go now that the tail is live
  }, [base, sendRead, flushOutbox]);

  // Retry a failed initial history load for the open chat.
  const retryHistory = useCallback(async () => {
    const chatId = activeRef.current;
    if (!chatId) return;
    setHistoryError(false);
    setLoadingHistory(true);
    const res = await loadHistory(base, chatId);
    if (activeRef.current !== chatId) return;
    setLoadingHistory(false);
    if (!res.ok) {
      if (isForbidden(res)) { onRevokedRef.current(); return; }
      setHistoryError(true);
      return;
    }
    const hist = res.data;
    setMessages((prev) => {
      // A live frame may have landed while the load failed; keep it, add history.
      const have = new Set(prev.map((b) => b.id));
      return [...hist.filter((m) => !have.has(m.id)).map((m) => ({ ...m })), ...prev];
    });
    setHasMore(hist.length >= 50);
    if (hist.length > 0) sendRead(hist.map((m) => ({ ...m })));
  }, [base, sendRead]);

  const queuedCount = useCallback(() => {
    let n = 0;
    for (const q of outboxRef.current.values()) n += q.length;
    return n;
  }, []);

  // What the view renders: the loaded log, with this chat's queued edits/deletes laid
  // over their messages and its queued sends appended as pending bubbles. Derived (not
  // stored) so a chat switch -- which reloads `messages` -- still shows that chat's own
  // queue and no other's.
  const shown = useMemo<Bubble[]>(() => {
    const q = activeId && !hasNewer ? outboxRef.current.get(activeId) : undefined;
    if (!q || q.length === 0 || !me) return messages;
    const edits = new Map<string, Extract<OutboxItem, { kind: "edit" }>>();
    const dels = new Set<string>();
    for (const i of q) {
      if (i.kind === "edit") edits.set(i.id, i);
      else if (i.kind === "delete") dels.add(i.id);
    }
    const base2 = messages.map((b) => {
      if (dels.has(b.id)) return { ...b, queued: "delete" as const };
      const e = edits.get(b.id);
      return e ? { ...b, body: e.body, editedAt: e.editedAt, queued: "edit" as const } : b;
    });
    const sends: Bubble[] = [];
    for (const i of q) {
      if (i.kind !== "send") continue;
      sends.push({
        id: i.tempId, tempId: i.tempId, chatId: activeId!, senderId: me.id, body: i.body,
        createdAt: i.createdAt, pending: true, queued: "send", replyToId: i.replyToId, replyTo: i.replyTo,
      });
    }
    return [...base2, ...sends];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, outboxTick, activeId, hasNewer, me]);

  const armJump = useCallback((msgId: string) => { pendingJumpRef.current = msgId; }, []);

  return {
    messages: shown, connected, loadingHistory, historyError, olderError, retryHistory, retryOlder: loadOlder, hasNewer, online, away, peerTyping, peerLastReadAt,
    logRef, onLogScroll, registerRow, activeRef,
    send, sendEdit, sendDelete, queuedCount, sendReact, sendTyping,
    jumpToMessage, jumpToLatest, armJump,
  };
}
