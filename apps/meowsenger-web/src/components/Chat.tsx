import { useCallback, useEffect, useRef, useState } from "react";
import { getSession, type SessionUser } from "../lib/meowsengerApi";
import { listChats, openDirect, loadHistory, wsUrl, getMembers, applyReaction, type ChatSummary, type Message, type Member } from "../lib/chat";
import { ChatSidebar } from "./ChatSidebar";
import { Composer, type ReplyDraft } from "./Composer";
import { MessageItem, type Bubble } from "./MessageItem";
import { MessageMenu, type MenuItem } from "./MessageMenu";
import { EmojiPicker } from "./EmojiPicker";
import { SearchPanel } from "./SearchPanel";
import { NewChatModal } from "./NewChatModal";
import { ForwardModal } from "./ForwardModal";
import { MemberDrawer } from "./MemberDrawer";
import { Avatar } from "./Avatar";

/** A group sender's resolved identity, keyed by userId (for per-sender rendering). */
type SenderInfo = { name: string; avatarUrl: string | null; role: string };

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
  // Slice 9 — a reaction was toggled on message `id`: `userId` added (on:true) or
  // removed (on:false) `emoji`. Broadcast to ALL sockets (incl. the actor's tabs).
  | { type: "reaction"; id: string; emoji: string; userId: string; on: boolean }
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
  // Slice 6 — a plain member tried to post in a broadcast channel (DO-enforced).
  read_only: "this is a broadcast channel — only admins can post",
  // Slice 8 — the DO drops a flood of `send`s (>30/10s) with this code; the socket
  // stays open + the Composer stays usable, we just nudge the user to slow down.
  rate_limited: "you're sending too fast — slow down a moment",
};

/**
 * Fire a browser notification for an incoming message while the tab is backgrounded
 * (Slice 9). Deliberately conservative — it fires ONLY when: the Notification API
 * exists, the document is hidden, and the user has already GRANTED permission (we
 * never auto-request; that's an explicit Settings toggle). Any misconfiguration is
 * a silent no-op. No service worker / Web Push — the tab must be open.
 */
function maybeNotify(title: string, body: string) {
  if (typeof Notification === "undefined") return;
  if (typeof document !== "undefined" && !document.hidden) return;
  if (Notification.permission !== "granted") return;
  try {
    // A blank body (e.g. a deleted echo) still yields a useful title-only ping.
    new Notification(title, { body: body || "sent a message" });
  } catch { /* some browsers throw off a non-SW context — ignore */ }
}

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
  // True from a chat-switch until its first history page resolves — drives the
  // shimmer bubbles in the log (distinct from the "empty conversation" state).
  const [loadingHistory, setLoadingHistory] = useState(false);
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
  // Slice 5 — group UI state.
  const [newChatOpen, setNewChatOpen] = useState(false); // the Direct|Group modal
  const [drawerOpen, setDrawerOpen] = useState(false); // the member-management drawer
  // Slice 8 — the forward modal + the message bodies queued for forwarding (from a
  // single message's context menu or the multi-select bar). Non-null bodies ⇒ open.
  const [forwardBodies, setForwardBodies] = useState<string[] | null>(null);
  // Slice 9 — the emoji picker anchored over a message (non-null ⇒ open). `m` is the
  // target message; `x`/`y` the viewport anchor point.
  const [emojiFor, setEmojiFor] = useState<{ m: Bubble; x: number; y: number } | null>(null);
  // Slice 9 — the in-chat search panel: whether it's open + the current query. The
  // panel itself owns its results/loading (it re-runs searchChat as the query changes).
  const [searchOpen, setSearchOpen] = useState(false);
  // Resolved per-sender identity for the ACTIVE group, keyed by userId. Empty for
  // DMs (which use the peer shortcut). Fetched on opening a group + refreshed on
  // membership changes.
  const [memberMap, setMemberMap] = useState<Map<string, SenderInfo>>(new Map());

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

  // Ref mirror of the current user id (Slice 9 — read inside the stable applyFrame
  // to tell an incoming reaction/message apart from our own, without re-deriving it).
  const meIdRef = useRef<string | null>(null);
  useEffect(() => { meIdRef.current = me?.id ?? null; }, [me]);

  // Slice 9 — resolve a sender id → a human name for the backgrounded notification
  // title. A ref-backed function so the stable applyFrame reads the CURRENT roster
  // /peer without depending on them. Set below once those derivations exist.
  const resolveSenderNameRef = useRef<(senderId: string) => string>(() => "new message");

  const activeChat = chats.find((c) => c.id === activeId) ?? null;
  const peerId = activeChat?.peerId ?? null;
  const isChannel = activeChat?.type === "channel";
  // Groups + channels both render the multi-member view (roster, member map, per-
  // sender identity). "membered" = has a roster; DMs use the peer shortcut instead.
  const isGroup = activeChat?.type === "group";
  const isMembered = isGroup || isChannel;
  // The caller's own role in the active membered chat, derived from the roster map
  // (owner | admin | member). Undefined for DMs / before the roster loads.
  const myRole = me ? memberMap.get(me.id)?.role : undefined;
  // Has the active channel's roster loaded yet? Until it has we can't know the
  // caller's role, so we DON'T flash the Composer (a member would see it briefly
  // before the read-only note replaces it) — the input area stays empty meanwhile.
  const channelRoleKnown = memberMap.size > 0;
  // A channel is broadcast: only owner/admin post. A plain `member` on a channel
  // sees a read-only note instead of the Composer (the DO also enforces this).
  const channelReadOnly = isChannel && myRole === "member";
  // Suppress the Composer on a channel until the role is known (avoids the flash);
  // owner/admin then get it, `member` gets the read-only note.
  const channelComposerPending = isChannel && !channelRoleKnown;

  // Fetch + index the active group's roster into a userId→{name,avatar,role} map
  // so MessageItem can render each sender's identity. No-op for DMs.
  const loadMembers = useCallback(async (chatId: string) => {
    const list: Member[] = await getMembers(base, chatId);
    if (activeRef.current !== chatId) return; // switched away mid-fetch
    const map = new Map<string, SenderInfo>();
    for (const m of list) {
      map.set(m.userId, { name: m.displayName || m.username, avatarUrl: m.avatarUrl, role: m.role });
    }
    setMemberMap(map);
  }, [base]);

  // Load who-am-i + the sidebar list once. Honor a `?chat=<id>` deep-link (set by
  // the discovery flow — /join navigates to /app?chat=<id> after join) by selecting
  // that chat once it's present in the list, then stripping the param so a later
  // manual switch + refresh doesn't snap back to it.
  useEffect(() => {
    getSession(base).then((s) => setMe(s.user ?? null));
    listChats(base).then((cs) => {
      setChats(cs);
      setLoadingChats(false);
      if (typeof window === "undefined") return;
      const wanted = new URLSearchParams(window.location.search).get("chat");
      if (wanted && cs.some((c) => c.id === wanted)) {
        setActiveId(wanted);
        const url = new URL(window.location.href);
        url.searchParams.delete("chat");
        window.history.replaceState({}, "", url.pathname + url.search);
      }
    });
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
      // Slice 9 — a backgrounded notification for a message from someone else. The
      // helper self-gates on document.hidden + granted permission (never prompts).
      if (frame.message.senderId !== meIdRef.current) {
        maybeNotify(resolveSenderNameRef.current(frame.message.senderId), frame.message.body);
      }
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
    } else if (frame.type === "reaction") {
      // Slice 9 — reconcile a reaction toggle (broadcast to ALL, incl. our own tabs).
      // applyReaction dedupes by userId+emoji, so a broadcast that merely confirms our
      // optimistic own-toggle is a no-op; a foreign user's toggle updates count/mine.
      const isMine = frame.userId === meIdRef.current;
      setMessages((prev) => prev.map((b) =>
        b.id === frame.id ? { ...b, reactions: applyReaction(b.reactions, frame.emoji, frame.on, isMine) } : b,
      ));
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
    // Reset group-scoped state so a prior group's roster/drawer never leaks.
    setDrawerOpen(false);
    setForwardBodies(null);
    // Reset Slice-9 per-chat UI: close the emoji picker + search panel on a switch.
    setEmojiFor(null);
    setSearchOpen(false);
    setMemberMap(new Map());
    rowsRef.current.clear();
    if (typingTimerRef.current != null) { clearTimeout(typingTimerRef.current); typingTimerRef.current = null; }
    if (!activeId) return;
    const chatId = activeId; // non-null capture for the closures below

    let cancelled = false;
    setMessages([]);
    setConnected(false);
    setHasMore(false);
    setLoadingHistory(true);
    prependingRef.current = false;
    loadHistory(base, chatId).then((hist) => {
      if (cancelled) return;
      setLoadingHistory(false);
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

  // When the active chat is a group OR channel, (re)load its roster into the sender
  // map (channels need it too, both to render per-sender identity and to derive the
  // caller's own role → the read-only gate). Keyed on activeId + isMembered so
  // switching between membered chats refetches; DMs clear the map (the socket-switch
  // effect already reset it).
  useEffect(() => {
    if (activeId && isMembered) void loadMembers(activeId);
  }, [activeId, isMembered, loadMembers]);

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

  // Slice 9 — toggle MY reaction `emoji` on message `m`. Optimistic: flip the pill
  // locally (add if I don't have it, remove if I do) keyed on the current `mine`
  // state, then send `{type:"react", id, emoji}`. The server broadcasts a
  // `reaction` frame back; applyReaction dedupes by userId+emoji so that confirming
  // echo is a no-op (and a foreign toggle still reconciles). Optimistic pending
  // bubbles (no real server id yet) can't be reacted to — skip them.
  function sendReact(m: Bubble, emoji: string) {
    if (m.pending || m.isDeleted) return;
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Derive the toggle direction from the FRESH state inside the updater (a
    // broadcast may have landed since render), so we never double-add/-remove.
    setMessages((prev) => prev.map((b) => {
      if (b.id !== m.id) return b;
      const mineNow = (b.reactions ?? []).find((r) => r.emoji === emoji)?.mine ?? false;
      return { ...b, reactions: applyReaction(b.reactions, emoji, !mineNow, true) };
    }));
    ws.send(JSON.stringify({ type: "react", id: m.id, emoji }));
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

  // ---- forwarding (Slice 8) ----
  // Queue the selected (non-deleted, non-empty) message bodies for the forward
  // modal, preserving their chronological order. Opens the modal; the select bar
  // stays put behind it so a cancel returns to the selection intact.
  function forwardSelected() {
    const bodies = messages
      .filter((m) => selected.has(m.id) && !m.isDeleted && m.body.trim())
      .map((m) => m.body);
    if (bodies.length === 0) return;
    setForwardBodies(bodies);
  }
  // Forward a single message straight from its context menu (no select mode).
  function forwardOne(m: Bubble) {
    if (m.isDeleted || !m.body.trim()) return;
    setForwardBodies([m.body]);
  }
  // After the modal reports its result: toast the outcome, close the modal, and
  // (if we were selecting) exit select mode. Partial failures are surfaced honestly.
  function onForwardDone({ sent, failed }: { sent: number; failed: number }) {
    setForwardBodies(null);
    if (sent > 0 && failed > 0) showToast(`forwarded to ${sent} chat${sent === 1 ? "" : "s"} — ${failed} failed`);
    else if (sent > 0) showToast(`forwarded to ${sent} chat${sent === 1 ? "" : "s"}`);
    else showToast("couldn't forward — try again");
    if (selectMode) exitSelect();
  }

  // Open the emoji picker over a message (Slice 9). Closes the context menu first
  // so the two popovers never overlap.
  function openEmoji(m: Bubble, x: number, y: number) {
    setMenu(null);
    if (m.pending || m.isDeleted) return;
    setEmojiFor({ m, x, y });
  }

  // Build the per-message context-menu items (gated by ownership + window). The
  // "react" item opens the emoji picker at the menu's own anchor (Slice 9).
  function menuItems(m: Bubble, at: { x: number; y: number }): MenuItem[] {
    const items: MenuItem[] = [{ label: "react", onClick: () => openEmoji(m, at.x, at.y) }];
    items.push({ label: "reply", onClick: () => setReplyingTo(m) });
    if (canEdit(m)) items.push({ label: "edit", onClick: () => setEditingId(m.id) });
    if (canDelete(m)) items.push({ label: "delete", onClick: () => sendDelete(m) });
    items.push({ label: "forward", onClick: () => forwardOne(m) });
    items.push({ label: "copy", onClick: () => copyText(m.body) });
    items.push({ label: "select", onClick: () => enterSelect(m) });
    return items;
  }

  // Open-or-create a DM from the modal's Direct tab. Returns an error message to
  // show inline, or null on success (the modal closes + we select the chat).
  async function onDirect(username: string): Promise<string | null> {
    const r = await openDirect(base, username);
    if (r.error || !r.chatId) {
      const copy: Record<string, string> = {
        user_not_found: "no user with that username",
        cannot_dm_self: "that's you — pick someone else",
        username_required: "enter a username",
      };
      return copy[r.error ?? ""] ?? r.error ?? "could not start chat";
    }
    const cs = await listChats(base);
    setChats(cs);
    setActiveId(r.chatId);
    return null;
  }

  // After the modal creates a group: refresh the sidebar + select the new chat.
  async function onCreatedGroup(chatId: string) {
    const cs = await listChats(base);
    setChats(cs);
    setActiveId(chatId);
  }

  // Refresh the sidebar list + (if the active chat is a group/channel) its roster
  // after a member-drawer mutation, without disturbing the socket/messages. Read
  // the type from the FRESH `cs` (not the stale `chats` closure) so a just-changed
  // roster always reloads.
  async function refreshAfterMemberChange() {
    const cs = await listChats(base);
    const act = activeRef.current;
    setChats(act ? cs.map((c) => (c.id === act ? { ...c, unreadCount: 0 } : c)) : cs);
    const actType = act ? cs.find((c) => c.id === act)?.type : undefined;
    if (act && (actType === "group" || actType === "channel")) void loadMembers(act);
  }

  // The caller left the active group: close the drawer, drop it from the list, and
  // clear the active selection (the chat may have been deleted server-side).
  function onLeftGroup() {
    const left = activeRef.current;
    setDrawerOpen(false);
    setActiveId(null);
    if (left) setChats((prev) => prev.filter((c) => c.id !== left));
    void listChats(base).then(setChats);
  }

  const peerName = activeChat ? (activeChat.peerDisplayName || activeChat.peerUsername || activeChat.name || "direct message") : "";
  const peerOnline = peerId != null && online.has(peerId);
  // Membered-chat header derivations: the group/channel's own name, member count
  // (from the live roster, falling back to the summary), and how many members are
  // currently online.
  const groupName = activeChat?.name || (isChannel ? "channel" : "group");
  const memberCount = memberMap.size || activeChat?.memberCount || 0;
  const onlineCount = isMembered ? [...memberMap.keys()].filter((id) => online.has(id)).length : 0;
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

  // Keep the notification name-resolver current: a group/channel uses the roster
  // (falling back to the raw id), a DM uses the peer name (Slice 9).
  useEffect(() => {
    resolveSenderNameRef.current = (senderId: string) =>
      isMembered ? (memberMap.get(senderId)?.name ?? senderId) : (peerName || "new message");
  }, [isMembered, memberMap, peerName]);

  return (
    <div className="mw-chat" data-open={open ? "1" : "0"}>
      <ChatSidebar
        chats={chats}
        activeId={activeId}
        online={online}
        meId={me?.id}
        onSelect={setActiveId}
        onNewChatClick={() => setNewChatOpen(true)}
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
              {isMembered ? (
                <>
                  <button
                    className="mw-chat__grouphead"
                    onClick={() => setDrawerOpen(true)}
                    aria-label={isChannel ? "channel members" : "group members"}
                  >
                    <span className="mw-chat__headavatar">
                      <span
                        className={`mw-avatar mw-avatar--md mw-groupavatar${isChannel ? " mw-groupavatar--channel" : ""}`}
                        aria-label={groupName}
                      >
                        <span aria-hidden="true" className="mono" data-case="preserve">{(groupName[0] ?? "#").toUpperCase()}</span>
                      </span>
                    </span>
                    <span className="mw-chat__headcol">
                      <span className="mw-chat__peer" data-case="preserve">
                        {isChannel && <span className="mw-chat__glyph" aria-hidden="true">📡 </span>}
                        {groupName}
                      </span>
                      <span className="mw-chat__presence">
                        {isChannel ? "channel · " : ""}
                        {memberCount} member{memberCount === 1 ? "" : "s"}
                        {onlineCount > 0 ? ` · ${onlineCount} online` : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    className={`mw-btn mw-btn--ghost mw-btn--sm mw-chat__searchbtn${searchOpen ? " is-on" : ""}`}
                    onClick={() => setSearchOpen((v) => !v)}
                    aria-label="search this chat"
                    aria-pressed={searchOpen}
                    title="search"
                  >🔍</button>
                  <span className={`mw-chat__status${connected ? " is-on" : ""}`}>
                    {connected ? "connected" : "connecting…"}
                  </span>
                </>
              ) : (
                <>
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
                  <button
                    className={`mw-btn mw-btn--ghost mw-btn--sm mw-chat__searchbtn${searchOpen ? " is-on" : ""}`}
                    onClick={() => setSearchOpen((v) => !v)}
                    aria-label="search this chat"
                    aria-pressed={searchOpen}
                    title="search"
                  >🔍</button>
                  <span className={`mw-chat__status${connected ? " is-on" : ""}`}>
                    {connected ? "connected" : "connecting…"}
                  </span>
                </>
              )}
            </header>

            {searchOpen && activeId && (
              <SearchPanel
                key={activeId}
                base={base}
                chatId={activeId}
                resolveName={(id) => resolveSenderNameRef.current(id)}
                meId={me?.id ?? null}
                onJump={jumpToReply}
                onClose={() => setSearchOpen(false)}
              />
            )}

            <div className="mw-chat__log" ref={logRef} onScroll={onLogScroll}>
              {loadingHistory && messages.length === 0 && (
                // Shimmer bubbles while the first history page loads. Alternating
                // sides mimic a real conversation; aria-hidden (purely decorative).
                <div className="mw-skel-log" aria-hidden="true">
                  {[62, 40, 74, 52, 46].map((w, i) => (
                    <div key={i} className={`mw-skelbubble${i % 2 ? " mw-skelbubble--me" : ""}`}>
                      <span className="mw-skel mw-skel--bubble" style={{ width: `${w}%` }} />
                    </div>
                  ))}
                </div>
              )}
              {!loadingHistory && messages.length === 0 && (
                <div className="mw-emptylog">
                  <span className="mw-emptylog__glyph" aria-hidden="true">👋</span>
                  <p className="mw-emptylog__text mw-muted">no messages yet. say hi</p>
                </div>
              )}
              {messages.map((m, i) => {
                const mine = me != null && m.senderId === me.id;
                const key = m.tempId ?? m.id;
                // Group consecutive messages from the same sender (within 5 min) so
                // the avatar + name render once per run, not on every bubble. A new
                // sender, a >5min gap, or a tombstone between them starts a new run.
                const prev = messages[i - 1];
                const firstInRun =
                  !prev || prev.senderId !== m.senderId || prev.isDeleted || m.createdAt - prev.createdAt > 5 * 60_000;
                // Sender avatar + name are group/channel-only, and only on the first
                // of a run. DMs never show them (the peer is named in the header).
                const showSenderMeta = isMembered && !mine && firstInRun;
                // "seen" only for DMs — in a group one member's read watermark
                // isn't "everyone saw it", so we don't imply it. (§ audit #1)
                const seen = !isMembered && mine && key === myLastId && !m.pending && peerLastReadAt >= m.createdAt;
                // Resolve the sender's name + avatar. Groups + channels look up the
                // member map (falling back to the raw sender id if unknown, e.g. a
                // since-left member); DMs keep the peer shortcut. Same for the
                // quoted-reply name.
                const sender = isMembered
                  ? (memberMap.get(m.senderId) ?? { name: m.senderId, avatarUrl: null })
                  : { name: peerName, avatarUrl: activeChat.peerAvatarUrl };
                const replyName = isMembered && m.replyTo
                  ? (memberMap.get(m.replyTo.senderId)?.name ?? m.replyTo.senderId)
                  : peerName;
                return (
                  <MessageItem
                    key={key}
                    m={m}
                    meId={me?.id ?? null}
                    mine={mine}
                    senderName={sender.name}
                    senderAvatarUrl={sender.avatarUrl}
                    grouped={isMembered}
                    showSenderMeta={showSenderMeta}
                    firstInRun={firstInRun}
                    replyName={replyName}
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
                    onReact={openEmoji}
                    onToggleReaction={sendReact}
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
                  onClick={forwardSelected}
                  disabled={selected.size === 0}
                >forward</button>
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
            ) : channelComposerPending ? (
              // Channel roster still loading → role unknown. Reserve the composer's
              // footprint (no flash of the input) until we know member vs admin.
              <div className="mw-readonly mw-readonly--pending" aria-hidden="true" />
            ) : channelReadOnly ? (
              // Broadcast channel + the caller is a plain member → no Composer. The
              // DO also rejects a member post ({error:"read_only"}), but hiding the
              // input is the honest UX. Owner/admin fall through to the Composer.
              <div className="mw-readonly" role="note">
                <span className="mw-readonly__glyph" aria-hidden="true">📡</span>
                <span>subscribed — only admins post in a channel.</span>
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
        <MessageMenu x={menu.x} y={menu.y} items={menuItems(menu.m, { x: menu.x, y: menu.y })} onClose={() => setMenu(null)} />
      )}
      {emojiFor && (
        <EmojiPicker
          x={emojiFor.x}
          y={emojiFor.y}
          onPick={(emoji) => sendReact(emojiFor.m, emoji)}
          onClose={() => setEmojiFor(null)}
        />
      )}
      {toast && <div className="mw-toast" role="status">{toast}</div>}

      <NewChatModal
        base={base}
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        onDirect={onDirect}
        onCreated={onCreatedGroup}
      />

      <ForwardModal
        base={base}
        open={forwardBodies !== null}
        chats={chats}
        bodies={forwardBodies ?? []}
        excludeId={activeId}
        onClose={() => setForwardBodies(null)}
        onDone={onForwardDone}
      />

      {drawerOpen && activeChat && isMembered && (
        <MemberDrawer
          base={base}
          chat={activeChat}
          meId={me?.id ?? null}
          online={online}
          onClose={() => setDrawerOpen(false)}
          onChanged={refreshAfterMemberChange}
          onLeft={onLeftGroup}
        />
      )}
    </div>
  );
}
