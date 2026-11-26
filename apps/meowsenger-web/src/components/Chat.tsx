import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MenuItem } from "./MessageMenu";
import { ConfirmDialog, LazyPanel, panels, prefetchPanels, preload } from "./LazyPanel";
import { Icon, type RequestResult } from "@meowerse/ui";
import { loginUrl, logoutUrl, type SessionUser } from "../lib/meowsengerApi";
import { listChats, openDirect, resolveChat, getMembers, type ChatSummary, type Member, type Message, type InboxDelta } from "../lib/chat";
import { shownName } from "../lib/userName";
import { fmtDay } from "../lib/messageText";
import { useConversation, type SendResult, isForbidden } from "../hooks/useConversation";
import { useInbox } from "../hooks/useInbox";
import { useConnectionIndicator } from "../hooks/useConnectionIndicator";
import { ChatSidebar } from "./ChatSidebar";
import { Composer, type ReplyDraft } from "./Composer";
import { MessageItem, type Bubble } from "./MessageItem";
import { Avatar } from "./Avatar";
import { setSnapshotSource } from "../lib/sessionEnded";
import { syncPushSubscription, disablePush } from "../lib/pushLazy";
import { setScope, clearAll, purgeChat, broadcastLogout, getEpoch, begin, memberCache } from "../lib/store";
import { createListGate, watchResume } from "../lib/store/chatList";

/** A group sender's resolved identity, keyed by userId (for per-sender rendering). */
// Neutral name for a sender not (yet) in the roster; never a raw id.
const UNKNOWN_SENDER = "someone";
type SenderInfo = { name: string; avatarUrl: string | null; role: string };

// Own-message action windows (UX gating only — the server enforces both, §7).
const EDIT_WINDOW_MS = 3600_000; // 1h
const DELETE_WINDOW_MS = 24 * 3600_000; // 24h
// Background poll cadence to surface unread for non-active chats (v1 simplification).
// 45s keeps D1 reads modest (each poll is one listChats read per open tab) while
// still feeling live; a focused tab also refreshes on visibilitychange/focus.
const SIDEBAR_POLL_MS = 45000;

/** DM header sub-line when the peer is offline: "last seen 5m ago" (else "offline"). */
function lastSeenLabel(ms: number | null | undefined): string {
  if (!ms) return "offline";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "last seen just now";
  if (s < 3600) return `last seen ${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `last seen ${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `last seen ${Math.floor(s / 86400)}d ago`;
  return "last seen " + new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The chat view: a thin shell over `useConversation` (which owns the realtime
 * message log, socket, history paging, presence, and send/edit/delete/react
 * actions). This component keeps only view concerns — the sidebar list, the local
 * UI state (menus, modals, selection, emoji picker, search, member drawer), the
 * derivations for the header, and the JSX.
 */
export default function Chat({ base, user, initialChats }: { base: string; user: SessionUser; initialChats: RequestResult<ChatSummary[]> }) {
  // The signed-in user comes from AppShell's single /api/session read (no second fetch).
  const me: SessionUser = user;
  // Bind the in-memory store to this user before any store read. A remount for the same
  // user keeps the cache (instant re-entry); a different user wipes it first.
  useState(() => { setScope(user.id); });
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  // The last sidebar refresh failed. The previous list is KEPT (never replaced by an
  // empty state because a request failed); the sidebar shows a subtle retry instead.
  const [chatsError, setChatsError] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  // Phone: opening a chat pushes one history entry (marked) so Back returns to the list.
  // Every UI/purge close pops that entry instead of leaving a dead one behind.
  // Closes at once (optimistic) and pops once; a double tap must not pop past the list.
  const closingRef = useRef(false);
  const closeChat = useCallback(() => {
    if (window.history.state?.mwc && !closingRef.current) { closingRef.current = true; window.history.back(); }
    setActiveId(null);
  }, []);
  const listScrollRef = useRef(0);
  const listEl = () => document.querySelector<HTMLElement>(".mw-chat__list");
  // Only a user-chosen open (not a deep link / resolve) may push a history entry.
  const userOpenRef = useRef(false);
  const selectChat = (id: string) => { listScrollRef.current = listEl()?.scrollTop ?? 0; userOpenRef.current = true; closingRef.current = false; setActiveId(id); };
  const chatsRef = useRef<ChatSummary[]>([]);
  const deepLinkDoneRef = useRef(false);
  const deepLinkRef = useRef<(cs: ChatSummary[]) => void>(() => {});
  // Unsent composer text, memory only (read by the session-ended banner via sessionEnded).
  const draftRef = useRef("");
  // A refused send turned back into composer text ("not sent -- edit"); nonce re-applies it.
  const [restoreText, setRestoreText] = useState<{ text: string; nonce: number } | null>(null);

  // Slice 4 — message-actions UI state.
  const [replyingTo, setReplyingTo] = useState<Bubble | null>(null); // armed reply
  const [editingId, setEditingId] = useState<string | null>(null); // inline-editing this id
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // selected message ids
  const [menu, setMenu] = useState<{ m: Bubble; x: number; y: number } | null>(null); // context menu
  const [toast, setToast] = useState<string | null>(null); // transient non-blocking note
  const [confirmBulk, setConfirmBulk] = useState(false); // bulk-delete confirmation dialog
  // Screen-reader announcements for NEW incoming messages only (#7). Rendered as
  // additive children in an aria-live region; capped so the DOM stays bounded.
  const [announcements, setAnnouncements] = useState<Array<{ id: string; text: string }>>([]);
  // "new messages" pill: live messages from others that arrived while scrolled up.
  const [newCount, setNewCount] = useState(0);
  // Slice 5 — group UI state.
  const [newChatOpen, setNewChatOpen] = useState(false); // the Direct|Group modal
  const [drawerOpen, setDrawerOpen] = useState(false); // the member-management drawer
  // Slice 8 — the forward modal + the message bodies queued for forwarding. Non-null ⇒ open.
  const [forwardBodies, setForwardBodies] = useState<string[] | null>(null);
  // Slice 9 — the emoji picker anchored over a message (non-null ⇒ open).
  const [emojiFor, setEmojiFor] = useState<{ m: Bubble; x: number; y: number } | null>(null);
  // Slice 9 — the in-chat search panel: whether it's open (the panel owns its results).
  const [searchOpen, setSearchOpen] = useState(false);
  // Settings modal state (docked in sidebar).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Mobile header overflow ("⋯") menu anchor — collapses the header actions on phones.
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  // Browser connectivity, for the header connection dot (offline=red vs reconnecting=amber).
  const [netOnline, setNetOnline] = useState(true);
  // Resolved per-sender identity for the ACTIVE group, keyed by userId. Empty for DMs.
  // Read from the account-scoped roster cache (5-min TTL), so re-entering a chat renders it at once.
  const roster = memberCache.useMembers(activeId);
  const memberMap = useMemo(() => {
    const map = new Map<string, SenderInfo>();
    for (const m of roster ?? []) map.set(m.userId, { name: shownName(m.displayName, m.username), avatarUrl: m.avatarUrl, role: m.role });
    return map;
  }, [roster]);

  const toastTimerRef = useRef<number | null>(null);

  const resolveNameRef = useRef<(id: string) => string>(() => "");
  const meIdRef = useRef<string | null>(null);

  const activeChat = chats.find((c) => c.id === activeId) ?? null;
  const peerId = activeChat?.peerId ?? null;
  const isChannel = activeChat?.type === "channel";
  // Groups + channels both render the multi-member view (roster, member map, per-
  // sender identity). "membered" = has a roster; DMs use the peer shortcut instead.
  const isGroup = activeChat?.type === "group";
  const isMembered = isGroup || isChannel;
  // The caller's own role in the active membered chat (owner|admin|member); undefined
  // for DMs / before the roster loads.
  // The summary is the fresher source; the roster role only backs up an older worker that omits it.
  const myRole = activeChat?.myRole ?? (me ? memberMap.get(me.id)?.role : undefined);
  // Has the active channel's roster loaded yet? Until it has we can't know the role,
  // so we DON'T flash the Composer (a member would see it briefly before the read-
  // only note replaces it) — the input area stays empty meanwhile.
  const channelRoleKnown = myRole !== undefined;
  // A channel is broadcast: only owner/admin post. A plain member sees a read-only note.
  const channelReadOnly = isChannel && myRole === "member";
  // Suppress the Composer on a channel until the role is known (avoids the flash).
  const channelComposerPending = isChannel && !channelRoleKnown;

  const peerName = activeChat ? (activeChat.peerUsername ? shownName(activeChat.peerDisplayName, activeChat.peerUsername) : (activeChat.peerDisplayName || activeChat.name || "direct message")) : "";

  // Resolve a sender id → a human name for the backgrounded-message notification: a
  // group/channel uses the roster (falling back to the raw id), a DM uses the peer
  // name (Slice 9). Fed into the hook, which mirrors it so its stable applyFrame reads
  // the current roster/peer. Recomputed each render (cheap; the hook re-mirrors it).
  const resolveSenderName = (senderId: string): string =>
    isMembered ? (memberMap.get(senderId)?.name ?? UNKNOWN_SENDER) : (peerName || "new message");
  // Mirror into refs so the stable `onIncoming` reads the current resolver + user id.
  resolveNameRef.current = resolveSenderName;
  meIdRef.current = me?.id ?? null;

  // Web Push self-heal: once we know who's signed in, re-send this browser's push
  // subscription if the server hasn't confirmed it for this user (never prompts).
  const meId = me?.id;
  useEffect(() => {
    if (meId) void syncPushSubscription(base, meId);
  }, [base, meId]);

  // Surface a small transient note (e.g. a server rejection). Non-blocking: it
  // auto-dismisses after a few seconds and never interrupts typing.
  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current != null) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  // Conversation-driven callbacks into the view (stable — the hook mirrors them):
  //  - a read receipt was sent → zero the active chat's sidebar unread badge.
  //  - a message was deleted    → drop it from any active selection (no bulk on a tombstone).
  //  - the send was dispatched  → consume the armed reply (only on a real dispatch).
  const onActiveRead = useCallback((chatId: string) => {
    setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)));
  }, []);
  const onMessageDeleted = useCallback((id: string) => {
    setSelected((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
  }, []);
  const consumeReply = useCallback(() => setReplyingTo(null), []);
  // Apply a sidebar fetch result: success replaces the list (keeping the active chat's
  // optimistic unread=0); any failure keeps the last good list and flags a retry.
  // Returns the fresh list, or null on failure.
  // `quiet` (background invalidation refetch): a failure never raises the banner when a
  // list is already shown — the next poll/focus/invalidation retries. A FIRST load that
  // fails still flags the error (honest states: never a false "no chats yet").
  const hasListRef = useRef(false);
  const applyChatList = useCallback((res: RequestResult<ChatSummary[]>, quiet = false): ChatSummary[] | null => {
    if (!res.ok) { if (!quiet || !hasListRef.current) setChatsError(true); return null; }
    hasListRef.current = true;
    setChatsError(false);
    const act = activeRef.current;
    const cs = res.data;
    // A role change in the refreshed list: keep showing the roster but revalidate it.
    for (const c of cs) { const o = chatsRef.current.find((x) => x.id === c.id); if (o && o.myRole !== c.myRole) memberCache.markStale(c.id); }
    // The ?chat=/?m= deep link runs ONCE, on the FIRST successful list (initial load,
    // a sidebar retry or a poll) — a failed first load must not drop it for good.
    if (!deepLinkDoneRef.current) { deepLinkDoneRef.current = true; deepLinkRef.current(cs); }
    setChats(act ? cs.map((c) => (c.id === act ? { ...c, unreadCount: 0 } : c)) : cs);
    return cs;
  }, []);
  // Every list fetch takes a start sequence; a response is applied only if no NEWER
  // fetch has already been applied, so an out-of-order (older) list never overwrites a
  // fresher one.
  const listSeqRef = useRef({ started: 0, applied: 0 });
  const fetchList = useCallback(async (quiet = false, isStale?: () => boolean): Promise<ChatSummary[] | null> => {
    const seq = ++listSeqRef.current.started;
    const epoch = getEpoch();
    const res = await listChats(base);
    if (getEpoch() !== epoch) return null; // clearAll / account switch while in flight: drop
    if (isStale?.()) return null; // unmounted / base changed while in flight: apply nothing
    if (seq < listSeqRef.current.applied) return null; // superseded by a newer applied list
    if (res.ok) listSeqRef.current.applied = seq;
    return applyChatList(res, quiet);
  }, [base, applyChatList]);
  // One gate for every list fetch (lib/store/chatList.ts): soft = poll/resume (single-flight,
  // 10 s min gap), force = everything else (never overlaps; a burst collapses to one trailing fetch).
  const listGate = useMemo(() => createListGate<ChatSummary[]>((quiet) => fetchList(quiet)), [fetchList]);
  const refreshChats = useCallback((): Promise<ChatSummary[] | null> => listGate.request("force"), [listGate]);
  // Content-free invalidation / inbox reconnect: quiet (a failure keeps the shown list, no banner).
  const refetchOnInvalidate = useCallback(async (): Promise<void> => { await listGate.request("force", true); }, [listGate]);

  // Membership revoked (removed by an admin / left elsewhere): close the chat, tell
  // the user, and refresh the sidebar (the revoked chat drops out — they're no longer
  // a member). The socket already stopped reconnecting on the `revoked` frame.
  const onRevoked = useCallback((gone: string) => {
    // Purge exactly the chat the revoke / 403 was for (not whichever chat is active by
    // the time it lands), so a late frame can never purge the wrong chat or spare this one.
    purgeChat(gone);
    // Only close (and tell the user about) the chat if it is still the one on screen: a
    // late revoke for a chat they already left must not close the chat they just opened.
    if (activeIdRef.current === gone) {
      showToast("you're no longer a member of this chat");
      closeChat();
    }
    void refreshChats();
  }, [closeChat, showToast, refreshChats]);

  // Apply one realtime sidebar update: move the chat to the top, refresh its preview +
  // activity, and set unread (0 when it's the chat you're viewing, else a has-unread
  // dot). A delta for a chat not in the list (e.g. a brand-new chat someone just made
  // with you) falls back to a full listChats fetch. Shared by the open-chat socket
  // (onActiveMessage) and the cross-chat inbox socket (onInboxDelta).
  const applySidebarDelta = useCallback(
    (chatId: string, preview: string, at: number, senderId: string, isActive: boolean, optimistic = false) => {
      // From the ref, not the updater: React may run the updater after this line (batched).
      const isUnindexed = !chatsRef.current.some((c) => c.id === chatId);
      setChats((prev) => {
        const idx = prev.findIndex((c) => c.id === chatId);
        if (idx === -1) return prev;
        // Deltas can arrive out of order (a reordered fan-out, a late replay): an OLDER message
        // must never overwrite a newer preview. Equal `at` still applies (same-ms messages).
        // ONLY server timestamps take part: an optimistic bubble carries the DEVICE clock, which
        // (running fast) would otherwise make real server deltas look "older" and be dropped.
        if (!optimistic && at < prev[idx].lastActivity) return prev;
        const isMine = meIdRef.current != null && senderId === meIdRef.current;
        const updated: ChatSummary = {
          ...prev[idx],
          lastMessage: preview,
          lastSenderId: senderId,
          ...(optimistic ? {} : { lastActivity: at }),
          // User's own message: never unread. Active chat: preserve scroll-aware state (onActiveRead zeroes it).
          // Cross-chat from a peer: show has-unread dot (1).
          unreadCount: isMine ? 0 : (isActive ? prev[idx].unreadCount : 1),
        };
        return [updated, ...prev.filter((_, i) => i !== idx)];
      });
      if (isUnindexed) {
        void refreshChats().then((cs) => {
          if (cs && !cs.some((c) => c.id === chatId)) {
            window.setTimeout(() => { void refreshChats(); }, 600);
          }
        });
      }
    },
    [refreshChats],
  );
  // A message in the OPEN chat arrived over its socket → update its sidebar row now.
  const onActiveMessage = useCallback(
    (message: Message, optimistic = false) => applySidebarDelta(message.chatId, message.body.slice(0, 140), message.createdAt, message.senderId, true, optimistic),
    [applySidebarDelta],
  );

  // Announce ONLY a new LIVE message from someone else (#7): the hook calls this for an
  // attached `message` frame whose id was absent and whose sender is not us. The cache paint,
  // revalidation, catch-up, older pages and jumps never call it, so they stay silent.
  const onIncoming = (m: Message) => {
    const who = resolveNameRef.current(m.senderId);
    const body = m.body.trim().slice(0, 120) || "sent a message";
    setAnnouncements((prev) => [...prev, { id: m.id, text: `${who}: ${body}` }].slice(-3));
    if (!atBottomRef.current) setNewCount((n) => n + 1);
  };

  // The realtime engine for the active chat (socket + history + presence + actions).
  const {
    messages, connected, loadingHistory, historyError, olderError, retryHistory, retryOlder, hasNewer, online, away, peerTyping, peerLastReadAt,
    logRef, atBottomRef, onLogScroll, scrollToTail, endTail, registerRow, activeRef,
    send, sendEdit, retrySend, discardFailedSend, sendDelete, sendDeleteMany, queuedByChat, sentUnseen, queuedCount, sendReact, sendTyping,
    jumpToMessage, jumpToLatest, armJump,
  } = useConversation({ base, activeId, me, resolveSenderName, onToast: showToast, onActiveRead, onActiveMessage, onIncoming, onMessageDeleted, consumeReply, onRevoked });

  // Cross-chat realtime sidebar: one persistent inbox socket delivers a delta whenever
  // someone messages a chat you DON'T have open → it jumps to the top with a fresh
  // preview + unread dot, without waiting for the poll. (The open chat updates via
  // onActiveMessage above; the inbox DO excludes members who are in the room.)
  const onInboxDelta = useCallback(
    (d: InboxDelta) => {
      if (d.invalidate) {
        // Content-free signal (large rooms): no preview to apply, so refetch the list.
        void refetchOnInvalidate();
        return;
      }
      applySidebarDelta(d.chatId, d.preview, d.at, d.senderId, d.chatId === activeRef.current);
    },
    [applySidebarDelta, activeRef, refetchOnInvalidate],
  );
  // A reopened inbox socket missed deltas while it was down: one coalesced list refresh.
  const link = useInbox(base, me != null, onInboxDelta, refetchOnInvalidate);
  const { dot, roomJoining, label } = useConnectionIndicator(link, connected || !activeChat, netOnline);

  // Fetch + index the active group's roster into a userId→{name,avatar,role} map so
  // MessageItem can render each sender's identity. No-op for DMs.
  // In-flight roster fetches per chat (no overlapping requests) and the consecutive-failure
  // count + earliest retry time per chat (exponential backoff for the background tick).
  const rosterFlight = useRef(new Map<string, object>());
  const rosterRetry = useRef(new Map<string, { fails: number; at: number }>());
  const loadMembers = useCallback(async (chatId: string, force = false) => {
    // force (after a drawer change): keep the roster on screen, but a fetch that started before can't store.
    if (force) memberCache.markStale(chatId);
    else if (memberCache.isFresh(chatId) || rosterFlight.current.has(chatId)) return;
    const tok = begin();
    const mine = {};
    rosterFlight.current.set(chatId, mine);
    const gen = memberCache.generation(chatId);
    const res = await getMembers(base, chatId, { signal: tok.signal });
    tok.done();
    if (rosterFlight.current.get(chatId) === mine) rosterFlight.current.delete(chatId);
    // A 403 means we're no longer a member: handled like a revoke (purge that chat from
    // every cache, and close it only if it's still open), even if we switched away.
    if (isForbidden(res)) { onRevoked(chatId); return; }
    if (!res.ok) { // keep the last known roster; never blank it on a failed fetch
      const f = (rosterRetry.current.get(chatId)?.fails ?? 0) + 1;
      rosterRetry.current.set(chatId, { fails: f, at: Date.now() + Math.min(60_000 * 2 ** f, 5 * 60_000) });
      return;
    }
    rosterRetry.current.delete(chatId);
    // Dropped if the account changed or the roster was invalidated/purged mid-fetch.
    memberCache.put(chatId, res.data, tok.epoch, gen);
  }, [base, onRevoked]);

  // Honor a deep-link in the URL: /app?chat=<idOrSlug>[&m=<messageId>]. Runs on the
  // FIRST successful chat list (see applyChatList). The URL is kept in sync with the
  // open chat (see the sync effect below) so a reload / shared link lands back in the
  // same chat (+ jumps to the message).
  deepLinkRef.current = (cs: ChatSummary[]) => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get("chat");
    const msg = params.get("m");
    if (!wanted) return;
    const mine = cs.find((c) => c.id === wanted);
    if (mine) {
      if (msg) armJump(msg);
      setActiveId(wanted);
      return;
    }
    // Not in the caller's list — could be a slug, or a chat they can join.
    void resolveChat(base, wanted).then((r) => {
      if (r.error || !r.id) { showToast("you don't have access to this chat"); return; }
      if (r.isMember) { if (msg) armJump(msg); setActiveId(r.id); return; }
      if (r.slug) {
        const key = r.type === "channel" ? "c" : "g";
        window.location.assign(`/join?${key}=${encodeURIComponent(r.slug)}${msg ? `&m=${encodeURIComponent(msg)}` : ""}`);
      } else {
        showToast("you don't have access to this chat");
      }
    }).catch(() => showToast("you don't have access to this chat"));
  };

  // Apply the sidebar list AppShell fetched in parallel with the session read (no
  // second /api/chats at boot). A failure keeps the sidebar retry; the deep link then
  // runs on the first successful list. Runs once per mount (AppShell remounts Chat,
  // via a key, for a different user so no list can carry over).
  const bootAppliedRef = useRef(false);
  useEffect(() => {
    if (bootAppliedRef.current) return;
    bootAppliedRef.current = true;
    const seq = ++listSeqRef.current.started;
    if (initialChats.ok) listSeqRef.current.applied = seq;
    applyChatList(initialChats);
    setLoadingChats(false);
  }, [initialChats, applyChatList]);

  // Hand the session-ended banner the unsent draft + whether a send was un-acked.
  // Memory only; no message bodies of any other message leave this component.
  const messagesRefForEnd = useRef(messages);
  messagesRefForEnd.current = messages;
  const queuedCountRef = useRef(queuedCount);
  queuedCountRef.current = queuedCount;
  useEffect(() => {
    const src = () => ({
      draft: draftRef.current,
      // queued outbox items count too: a memory-only queue is lost with the tab/session.
      pendingSend: messagesRefForEnd.current.some((m) => m.pending) || queuedCountRef.current() > 0,
    });
    setSnapshotSource(src);
    return () => setSnapshotSource(null);
  }, []);

  // Keep the address bar in sync with the open chat, so a reload / copied link
  // returns here. Desktop: replaceState. Phone: opening from the list pushes (Back = list).
  const urlSyncReadyRef = useRef(false);
  chatsRef.current = chats;
  useEffect(() => {
    const onPop = () => {
      closingRef.current = false;
      const u = new URL(window.location.href);
      const id = u.searchParams.get("chat");
      const ok = chatsRef.current.some((c) => c.id === id);
      if (id && !ok) { u.searchParams.delete("chat"); window.history.replaceState(window.history.state, "", u.pathname + u.search); } // purged chat: show the list
      setActiveId(ok ? id : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Back to the list: the hidden list lost its scrollTop (display:none), put it back.
  useLayoutEffect(() => { const l = listEl(); if (l && !activeId) l.scrollTop = listScrollRef.current; }, [activeId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Skip the FIRST run: on mount activeId is null and the deep-link (?chat/?m) is
    // still being read asynchronously (after listChats resolves). Stripping the params
    // here would clobber the link before it's consumed — the bug that broke deep-links.
    if (!urlSyncReadyRef.current) { urlSyncReadyRef.current = true; return; }
    const user = userOpenRef.current;
    userOpenRef.current = false;
    if (closingRef.current) return; // history.back() is about to move us; leave the marked entry alone
    const url = new URL(window.location.href);
    if (activeId) url.searchParams.set("chat", activeId);
    else url.searchParams.delete("chat");
    url.searchParams.delete("m"); // the message anchor is one-shot (consumed on open)
    const next = url.pathname + url.search;
    if (next === window.location.pathname + window.location.search) return; // popstate / deep link: already there
    if (activeId && user && !window.history.state?.mwc && window.matchMedia?.("(max-width: 719px)").matches) window.history.pushState({ mwc: 1 }, "", next);
    else window.history.replaceState(window.history.state, "", next);
  }, [activeId]);

  // Warm the on-demand panel chunks once the browser is idle after first paint.
  useEffect(() => prefetchPanels(), []);

  // Clear the toast timer on unmount so it can't fire into a dead component.
  useEffect(() => () => { if (toastTimerRef.current != null) clearTimeout(toastTimerRef.current); }, []);

  // Track browser connectivity so the header connection dot distinguishes "offline"
  // (red) from "reconnecting" (amber) — a compact, dev-visible health signal.
  useEffect(() => {
    const sync = () => setNetOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, []);

  // Reflect the count of chats with unread messages in the tab title (#14); restore
  // the plain title when the island unmounts.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const n = chats.filter((c) => c.unreadCount > 0).length;
    document.title = n > 0 ? `(${n}) meowsenger` : "meowsenger";
    return () => { document.title = "meowsenger"; };
  }, [chats]);

  // Reset per-chat VIEW UI state on every switch so nothing leaks across chats (the
  // conversation engine resets its own message/presence state internally). Kept here
  // — not in the hook — because these are all view-owned.
  useEffect(() => {
    setReplyingTo(null);
    setEditingId(null);
    setSelectMode(false);
    setSelected(new Set());
    setMenu(null);
    setDrawerOpen(false);
    setForwardBodies(null);
    setEmojiFor(null);
    setSearchOpen(false);
    setConfirmBulk(false);
    // The SR announcer starts empty for the next chat (#7).
    setAnnouncements([]);
    setNewCount(0);
  }, [activeId]);

  // 120 ms opacity fade of the log on a chat SWITCH (composite-only, WAAPI so the log element and
  // its scroll refs survive). Layout effect: starts before paint, so the old chat never flashes.
  const prevChatRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const prev = prevChatRef.current;
    prevChatRef.current = activeId;
    const el = logRef.current;
    if (!prev || !activeId || prev === activeId || !el?.animate) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 120, easing: "ease-out" });
  }, [activeId, logRef]);

  // Pill activation. The focused button unmounts with the count, so focus the log (never the
  // textarea: that would open the on-screen keyboard on touch). preventScroll keeps the smooth scroll ours.
  const toNewest = () => {
    if (!scrollToTail()) return; // an older page is prepending: keep the pill (and its count) for the retry
    logRef.current?.focus({ preventScroll: true });
    setNewCount(0);
  };
  useEffect(() => { if (hasNewer) setNewCount(0); }, [hasNewer]); // a jumped window has no live tail to count

  // When the active chat is a group OR channel, (re)load its roster into the sender
  // map (channels need it to render per-sender identity and derive the caller's role).
  // `rosterStale` (past TTL / marked stale) re-runs it; the interval + visibility return
  // revalidate an expired roster while the chat stays open (it keeps showing meanwhile).
  const rosterStale = memberCache.useStale(activeId);
  useEffect(() => {
    if (!activeId || !isMembered) return;
    // A failing chat waits out its backoff; a hidden tab never polls.
    const attempt = () => { if (Date.now() >= (rosterRetry.current.get(activeId)?.at ?? 0)) void loadMembers(activeId); };
    const tick = () => { if (document.visibilityState === "visible") attempt(); };
    attempt();
    const iv = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", tick); };
  }, [activeId, isMembered, loadMembers, rosterStale]);

  // Live-ish sidebar safety net: a tab return (focus + visibilitychange merged, 250 ms) and a
  // 45 s poll, both soft (rate-limited); the poll is skipped while the inbox socket is open
  // (it delivers deltas). The active chat's optimistic unread=0 is merged in applyChatList.
  const linkRef = useRef(link);
  useEffect(() => { linkRef.current = link; });
  useEffect(() => {
    const soft = () => { void listGate.request("soft"); };
    const stopResume = watchResume(soft);
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible" && linkRef.current !== "open") soft();
    }, SIDEBAR_POLL_MS);
    return () => { window.clearInterval(iv); stopResume(); listGate.dispose(); };
  }, [listGate]);

  // Reply/edit/delete route through the hook; ownership + windows are UX gating only.
  function sendWith(body: string): SendResult {
    return send(body, replyingTo?.id ?? null);
  }
  function onSaveEdit(m: Bubble, body: string) {
    // Saving unchanged text is a no-op: just close the editor.
    if (body.trim() === m.body) { setEditingId(null); return; }
    // Keep the editor open (and the typed text) if nothing was sent or queued.
    if (sendEdit(m, body) !== "rejected") setEditingId(null);
  }

  // Can I still edit / delete this message? (own + within window, ignoring optimistic
  // bubbles and tombstones). Mirrors the server's checks — purely for showing the action.
  function canEdit(m: Bubble): boolean {
    return !!me && m.senderId === me.id && !m.pending && m.queued !== "delete" && !m.isDeleted && Date.now() - m.createdAt <= EDIT_WINDOW_MS;
  }
  function canDelete(m: Bubble): boolean {
    return !!me && m.senderId === me.id && !m.pending && m.queued !== "delete" && !m.isDeleted && Date.now() - m.createdAt <= DELETE_WINDOW_MS;
  }

  // Best-effort clipboard write with a toast on the outcome. Falls back to a toast
  // when the Clipboard API is unavailable (insecure context / older browser).
  function copy(text: string, okMsg: string) {
    if (!text) return;
    if (!navigator.clipboard?.writeText) { showToast("couldn't copy"); return; }
    void navigator.clipboard.writeText(text).then(() => showToast(okMsg), () => showToast("couldn't copy"));
  }
  function copyText(text: string) { copy(text, "copied"); }

  // Build + copy a shareable deep-link. Chat → /app?chat=<id>; message → +&m=<id>.
  function chatLink(chatId: string, msgId?: string): string {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/app?chat=${encodeURIComponent(chatId)}${msgId ? `&m=${encodeURIComponent(msgId)}` : ""}`;
  }
  function copyLink(url: string) { copy(url, "link copied"); }
  function copyChatLink() { if (activeId) copyLink(chatLink(activeId)); }
  function copyMessageLink(m: Bubble) { if (activeId && !m.pending) copyLink(chatLink(activeId, m.id)); }

  // Open a global-search hit: jump in place if it's the already-open chat, else
  // switch to it and let the chat-switch effect consume the pending jump.
  function openSearchResult(chatId: string, msgId: string) {
    if (chatId === activeRef.current) { void jumpToMessage(msgId); return; }
    armJump(msgId);
    selectChat(chatId);
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
  // The still-deletable subset of the current selection (my own, within window).
  const deletableSelected = messages.filter((m) => selected.has(m.id) && canDelete(m));
  // Ask before a bulk delete (#37): open the shared ConfirmDialog if anything is
  // eligible (nothing to confirm otherwise — just leave select mode).
  function requestDeleteSelected() {
    if (deletableSelected.length === 0) { exitSelect(); return; }
    setConfirmBulk(true);
  }
  function confirmDeleteSelected() {
    // Bulk-delete only my own, still-deletable messages; silently skip the rest. The
    // outbox capacity is checked once for the lot: all queued/sent, or none (one toast).
    const eligible = messages.filter((m) => selected.has(m.id) && canDelete(m));
    setConfirmBulk(false);
    if (eligible.length > 0 && sendDeleteMany(eligible) === "rejected") return; // keep the selection
    exitSelect();
  }

  // ---- forwarding (Slice 8) ----
  function forwardSelected() {
    const bodies = messages
      .filter((m) => selected.has(m.id) && !m.isDeleted && m.body.trim())
      .map((m) => m.body);
    if (bodies.length === 0) return;
    setForwardBodies(bodies);
  }
  function forwardOne(m: Bubble) {
    if (m.isDeleted || !m.body.trim()) return;
    setForwardBodies([m.body]);
  }
  function onForwardDone({ sent, failed }: { sent: number; failed: number }) {
    setForwardBodies(null);
    if (sent > 0 && failed > 0) showToast(`forwarded to ${sent} chat${sent === 1 ? "" : "s"} — ${failed} failed`);
    else if (sent > 0) showToast(`forwarded to ${sent} chat${sent === 1 ? "" : "s"}`);
    else showToast("couldn't forward — try again");
    if (selectMode) exitSelect();
  }

  // Open the emoji picker over a message (Slice 9). Closes the context menu first.
  function openEmoji(m: Bubble, x: number, y: number) {
    setMenu(null);
    if (m.pending || m.isDeleted) return;
    setEmojiFor({ m, x, y });
  }

  // Build the per-message context-menu items (gated by ownership + window).
  function menuItems(m: Bubble, at: { x: number; y: number }): MenuItem[] {
    const items: MenuItem[] = [{ label: "react", icon: "mood-smile", onClick: () => openEmoji(m, at.x, at.y) }];
    items.push({ label: "reply", icon: "reply", onClick: () => setReplyingTo(m) });
    if (canEdit(m)) items.push({ label: "edit", icon: "edit", onClick: () => setEditingId(m.id) });
    if (canDelete(m)) items.push({ label: "delete", icon: "trash", onClick: () => sendDelete(m) });
    items.push({ label: "forward", icon: "forward", onClick: () => forwardOne(m) });
    items.push({ label: "copy", icon: "copy", onClick: () => copyText(m.body) });
    if (!m.pending) items.push({ label: "copy link", icon: "link", onClick: () => copyMessageLink(m) });
    items.push({ label: "select", icon: "check", onClick: () => enterSelect(m) });
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
        network: "couldn't reach the server — try again",
      };
      // Generic fallback so a raw server code never leaks into the UI.
      return copy[r.error ?? ""] ?? "could not start chat";
    }
    await refreshChats();
    selectChat(r.chatId);
    return null;
  }

  // After the modal creates a group: refresh the sidebar + select the new chat.
  async function onCreatedGroup(chatId: string) {
    await refreshChats();
    selectChat(chatId);
  }

  // Refresh the sidebar list + (if the active chat is a group/channel) its roster
  // after a member-drawer mutation, without disturbing the socket/messages.
  async function refreshAfterMemberChange() {
    const cs = await refreshChats();
    const act = activeRef.current;
    if (!cs) return;
    const actType = act ? cs.find((c) => c.id === act)?.type : undefined;
    if (act && (actType === "group" || actType === "channel")) void loadMembers(act, true);
  }

  // The caller left the active group: close the drawer, drop it from the list, and
  // clear the active selection (the chat may have been deleted server-side).
  function onLeftGroup() {
    const left = activeRef.current;
    if (left) purgeChat(left);
    setDrawerOpen(false);
    closeChat();
    if (left) setChats((prev) => prev.filter((c) => c.id !== left));
    void refreshChats();
  }

  const onLogout = useCallback(async () => {
    // Wipe the in-memory store FIRST (before any await and before the POST), then tell
    // the other tabs. The broadcast carries only its type and can never throw/hang.
    clearAll();
    broadcastLogout();
    // Drop this browser's push subscription (server row + local + marker) BEFORE the
    // session ends, so the next account on this browser can't inherit it. Best-effort
    // and time-boxed: logout must never hang on it.
    await Promise.race([
      disablePush(base, meId ?? undefined).catch(() => {}),
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]);
    await fetch(logoutUrl(base), { method: "POST", credentials: "include" });
    window.location.href = loginUrl(base);
  }, [base, meId]);

  const peerOnline = peerId != null && online.has(peerId);
  // Online but all their tabs are backgrounded → "away".
  const peerAway = peerOnline && peerId != null && away.has(peerId);
  // Membered-chat header derivations.
  const groupName = activeChat?.name || (isChannel ? "channel" : "group");
  // Known limit: a member removed by another admin stays counted until the roster revalidates (<= TTL + 1 min).
  const memberCount = memberMap.size || activeChat?.memberCount || 0;
  const onlineCount = isMembered ? [...memberMap.keys()].filter((id) => online.has(id)).length : 0;
  const open = activeChat != null; // a popstate to a chat no longer in the list shows the list
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
      {/* Anchors the document outline at h1 for the /app view (#34). */}
      <h1 className="mw-sr-only">meowsenger</h1>
      {/* Screen-reader announcer for NEW incoming messages only (#7). Additive,
          polite; the whole log is NOT a live region. */}
      <div className="mw-sr-only" aria-live="polite" aria-relevant="additions">
        {announcements.map((a) => (
          <p key={a.id}>{a.text}</p>
        ))}
      </div>
      <ChatSidebar
        chats={chats}
        activeId={activeId}
        online={online}
        meId={me?.id}
        me={me}
        base={base}
        onSelect={selectChat}
        onOpenResult={openSearchResult}
        onNewChatClick={() => setNewChatOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        onIntent={(k) => preload(k)()}
        onLogout={onLogout}
        unsent={queuedByChat}
        loading={loadingChats}
        error={chatsError}
        onRetry={() => { void refreshChats(); }}
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
                onClick={closeChat}
                aria-label="back to chats"
              >
                <Icon name="arrow-left" size={18} />
              </button>
              {isMembered ? (
                <button
                  className="mw-chat__grouphead"
                  onClick={() => setDrawerOpen(true)}
                  onPointerEnter={preload("members")}
                  onFocus={preload("members")}
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
                      {isChannel && <Icon name="broadcast" size={16} className="mw-chat__glyph" />}
                      {groupName}
                    </span>
                    <span className="mw-chat__presence">
                      {isChannel ? "channel · " : ""}
                      {memberCount} member{memberCount === 1 ? "" : "s"}
                      {onlineCount > 0 ? ` · ${onlineCount} online` : ""}
                    </span>
                  </span>
                </button>
              ) : (
                <>
                  <span className="mw-chat__headavatar">
                    <Avatar url={activeChat.peerAvatarUrl} name={peerName} size="md" />
                    <span className={`mw-dot ${peerAway ? "mw-dot--away" : peerOnline ? "mw-dot--on" : "mw-dot--off"}`} aria-label={peerAway ? "away" : peerOnline ? "online" : "offline"} />
                  </span>
                  <span className="mw-chat__headcol">
                    <span className="mw-chat__peer" data-case="preserve">{peerName}</span>
                    {peerTyping
                      ? <span className="mw-chat__typing">typing…</span>
                      : <span className="mw-chat__presence">{peerAway ? "away" : peerOnline ? "online" : lastSeenLabel(activeChat.peerLastSeenAt)}</span>}
                  </span>
                </>
              )}

              {/* Shared right cluster (both branches). The name column flexes to fill
                  the space these leave, so it's no longer squeezed on mobile. */}
              <span className="mw-chat__joining" aria-hidden="true" hidden={!roomJoining || dot !== "on"}>connecting…</span>
              <span className="mw-chat__conn" data-state={dot} title={label} aria-hidden="true" />
              <span className="mw-sr-only" role="status" aria-live="polite">{label}</span>
              {/* Inline actions on desktop; collapsed into the ⋯ menu on phones (CSS). */}
              <div className="mw-chat__actions">
                <button
                  className="mw-btn mw-btn--ghost mw-btn--sm mw-chat__linkbtn"
                  onClick={copyChatLink}
                  aria-label="copy link to this chat"
                  title="copy link"
                >
                  <Icon name="link" size={16} />
                </button>
                <button
                  className={`mw-btn mw-btn--ghost mw-btn--sm mw-chat__searchbtn${searchOpen ? " is-on" : ""}`}
                  onClick={() => setSearchOpen((v) => !v)}
                  onPointerEnter={preload("search")}
                  onFocus={preload("search")}
                  aria-label="search this chat"
                  aria-pressed={searchOpen}
                  title="search"
                >
                  <Icon name="search" size={16} />
                </button>
              </div>
              <button
                className="mw-btn mw-btn--ghost mw-btn--sm mw-chat__more"
                aria-label="more chat actions"
                aria-haspopup="menu"
                aria-expanded={moreMenu != null}
                onPointerEnter={preload("menu", "search")}
                onFocus={preload("menu", "search")}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMoreMenu({ x: r.right - 168, y: r.bottom + 6 });
                }}
              >
                <Icon name="dots" size={18} />
              </button>
            </header>

            {moreMenu && (
              <LazyPanel
                load={panels.menu}
                onClose={() => setMoreMenu(null)}
                props={{
                  x: moreMenu.x,
                  y: moreMenu.y,
                  items: [
                    { label: "search", icon: "search", onClick: () => setSearchOpen((v) => !v) },
                    { label: "copy link", icon: "link", onClick: copyChatLink },
                  ],
                  onClose: () => setMoreMenu(null),
                }}
              />
            )}

            {searchOpen && activeId && (
              <LazyPanel
                key={activeId}
                load={panels.search}
                onClose={() => setSearchOpen(false)}
                props={{
                  base,
                  chatId: activeId,
                  resolveName: (id: string) => resolveSenderName(id),
                  meId: me?.id ?? null,
                  onJump: jumpToMessage,
                  onClose: () => setSearchOpen(false),
                }}
              />
            )}

            <div className="mw-chat__logwrap">
            <div className="mw-chat__log" tabIndex={-1} aria-label="messages" ref={logRef} onWheel={endTail} onTouchStart={endTail} onPointerDown={endTail} onKeyDown={endTail} onScrollEnd={endTail} onScroll={() => { onLogScroll(); if (atBottomRef.current) setNewCount(0); }} onPointerEnter={preload("menu", "emoji", "forward")}>
              {loadingHistory && messages.length === 0 && (
                <div className="mw-skel-log" aria-hidden="true">
                  {[62, 40, 74, 52, 46].map((w, i) => (
                    <div key={i} className={`mw-skelbubble${i % 2 ? " mw-skelbubble--me" : ""}`}>
                      <span className="mw-skel mw-skel--bubble" style={{ width: `${w}%` }} />
                    </div>
                  ))}
                </div>
              )}
              {olderError && messages.length > 0 && (
                <div className="mw-loaderror">
                  <span className="mw-muted" role="status">couldn't load earlier messages.</span>{" "}
                  <button className="mw-btn mw-btn--sm" onClick={() => { void retryOlder(); }}>retry</button>
                </div>
              )}
              {!loadingHistory && historyError && messages.length === 0 && (
                <div className="mw-emptylog">
                  <p className="mw-emptylog__text mw-muted" role="status">couldn't load messages.</p>
                  <button className="mw-btn mw-btn--sm" onClick={() => { void retryHistory(); }}>retry</button>
                </div>
              )}
              {!loadingHistory && !historyError && messages.length === 0 && (
                <div className="mw-emptylog">
                  <span className="mw-emptylog__glyph" aria-hidden="true">👋</span>
                  <p className="mw-emptylog__text mw-muted">no messages yet. say hi</p>
                </div>
              )}
              {messages.map((m, i) => {
                const mine = me != null && m.senderId === me.id;
                const key = m.tempId ?? m.id;
                // Group consecutive messages from the same sender (within 5 min) so
                // the avatar + name render once per run, not on every bubble.
                const prev = messages[i - 1];
                const firstInRun =
                  !prev || prev.senderId !== m.senderId || prev.isDeleted || m.createdAt - prev.createdAt > 5 * 60_000;
                // A day separator precedes the first message of each calendar day (#10/#12).
                const newDay = !prev || new Date(m.createdAt).toDateString() !== new Date(prev.createdAt).toDateString();
                // Sender avatar + name are group/channel-only, and only on the first
                // of a run. DMs never show them (the peer is named in the header).
                const showSenderMeta = isMembered && !mine && firstInRun;
                // "seen" only for DMs — in a group one member's read watermark
                // isn't "everyone saw it". (§ audit #1)
                const seen = !isMembered && mine && key === myLastId && !m.pending && peerLastReadAt >= m.createdAt;
                // Resolve the sender's name + avatar (groups/channels look up the map,
                // falling back to the raw id; DMs keep the peer shortcut).
                const sender = isMembered
                  ? (memberMap.get(m.senderId) ?? { name: UNKNOWN_SENDER, avatarUrl: null })
                  : { name: peerName, avatarUrl: activeChat.peerAvatarUrl };
                const replyName = isMembered && m.replyTo
                  ? (memberMap.get(m.replyTo.senderId)?.name ?? UNKNOWN_SENDER)
                  : peerName;
                return (
                  <Fragment key={key}>
                    {newDay && (
                      <div className="mw-daysep" role="separator">
                        <span>{fmtDay(m.createdAt)}</span>
                      </div>
                    )}
                    <MessageItem
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
                    onSaveEdit={onSaveEdit}
                    onDelete={sendDelete}
                    onToggleSelect={toggleSelect}
                    onContextMenu={(mm, x, y) => setMenu({ m: mm, x, y })}
                    onReact={openEmoji}
                    onToggleReaction={sendReact}
                    onJumpToReply={jumpToMessage}
                    registerRef={registerRow}
                    onRetrySend={retrySend}
                    onEditFailedSend={(mm) => { const text = discardFailedSend(mm); setRestoreText((r) => ({ text, nonce: (r?.nonce ?? 0) + 1 })); }}
                    />
                  </Fragment>
                );
              })}
            </div>
            {newCount > 0 && !hasNewer && (
              <button type="button" className="mw-chat__newpill" onClick={toNewest}>
                {newCount} new message{newCount === 1 ? "" : "s"} <span aria-hidden="true">↓</span>
              </button>
            )}
            </div>

            {hasNewer && (
              // Viewing a detached window (jumped to an old message) — a way back to live.
              <button className="mw-chat__tolatest" onClick={() => void jumpToLatest()} aria-label="jump to latest messages">
                jump to latest ↓
              </button>
            )}

            {sentUnseen && (
              <div className="mw-chat__sentnote" role="status">
                <span>sent — jump to latest to see it</span>
                <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={() => void jumpToLatest()}>jump to latest</button>
              </div>
            )}

            {selectMode ? (
              <div className="mw-selectbar" role="toolbar" aria-label="selection actions">
                <span className="mw-selectbar__count">{selected.size} selected</span>
                <span className="mw-selectbar__spacer" />
                <button
                  className="mw-btn mw-btn--ghost mw-btn--sm"
                  onClick={forwardSelected}
                  disabled={selected.size === 0}
                  aria-label="forward"
                >
                  <span className="mw-tlabel">forward</span>
                  <span className="mw-ticon" aria-hidden="true"><Icon name="forward" size={14} /></span>
                </button>
                <button
                  className="mw-btn mw-btn--ghost mw-btn--sm"
                  onClick={copySelected}
                  disabled={selected.size === 0}
                  aria-label="copy"
                >
                  <span className="mw-tlabel">copy</span>
                  <span className="mw-ticon" aria-hidden="true"><Icon name="copy" size={14} /></span>
                </button>
                <button
                  className="mw-btn mw-btn--ghost mw-btn--sm mw-selectbar__danger"
                  onClick={requestDeleteSelected}
                  disabled={selected.size === 0}
                  aria-label="delete"
                >
                  <span className="mw-tlabel">delete</span>
                  <span className="mw-ticon" aria-hidden="true"><Icon name="trash" size={14} /></span>
                </button>
                <button
                  className="mw-btn mw-btn--primary mw-btn--sm"
                  onClick={exitSelect}
                  aria-label="cancel"
                >
                  <span className="mw-tlabel">cancel</span>
                  <span className="mw-ticon" aria-hidden="true"><Icon name="x" size={14} /></span>
                </button>
              </div>
            ) : channelComposerPending ? (
              // Channel roster still loading → role unknown. Reserve the composer's
              // footprint (no flash of the input) until we know member vs admin.
              <div className="mw-readonly mw-readonly--pending" aria-hidden="true" />
            ) : channelReadOnly ? (
              // Broadcast channel + the caller is a plain member → no Composer.
              <div className="mw-readonly" role="note">
                <Icon name="broadcast" size={18} className="mw-readonly__glyph" />
                <span>subscribed — only admins post in a channel.</span>
              </div>
            ) : (
              <Composer
                onSend={sendWith}
                onTyping={sendTyping}
                replyTo={replyDraft}
                onCancelReply={() => setReplyingTo(null)}
                onDraftChange={(t) => { draftRef.current = t; }}
                restore={restoreText}
              />
            )}
          </>
        )}
      </section>

      {menu && (
        <LazyPanel load={panels.menu} onClose={() => setMenu(null)} props={{ x: menu.x, y: menu.y, items: menuItems(menu.m, { x: menu.x, y: menu.y }), onClose: () => setMenu(null) }} />
      )}
      {emojiFor && (
        <LazyPanel
          load={panels.emoji}
          onClose={() => setEmojiFor(null)}
          props={{ x: emojiFor.x, y: emojiFor.y, onPick: (emoji: string) => sendReact(emojiFor.m, emoji), onClose: () => setEmojiFor(null) }}
        />
      )}
      {toast && <div className="mw-apptoast" role="status">{toast}</div>}

      <ConfirmDialog
        open={confirmBulk}
        title="delete messages"
        description={`delete ${deletableSelected.length} message${deletableSelected.length === 1 ? "" : "s"}? this can't be undone.`}
        confirmLabel="delete"
        variant="danger"
        onCancel={() => setConfirmBulk(false)}
        onConfirm={confirmDeleteSelected}
      />


      <LazyPanel
        load={panels.newChat}
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        props={{ base, open: newChatOpen, onClose: () => setNewChatOpen(false), onDirect, onCreated: onCreatedGroup }}
      />

      <LazyPanel
        load={panels.forward}
        open={forwardBodies !== null}
        onClose={() => setForwardBodies(null)}
        props={{ base, open: forwardBodies !== null, chats, bodies: forwardBodies ?? [], excludeId: activeId, onClose: () => setForwardBodies(null), onDone: onForwardDone }}
      />

      {drawerOpen && activeChat && isMembered && (
        <LazyPanel
          load={panels.members}
          onClose={() => setDrawerOpen(false)}
          props={{ base, chat: activeChat, meId: me?.id ?? null, online, onClose: () => setDrawerOpen(false), onChanged: refreshAfterMemberChange, onLeft: onLeftGroup }}
        />
      )}

      <LazyPanel
        load={panels.settings}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        props={{ base, userId: me?.id, open: settingsOpen, onClose: () => setSettingsOpen(false) }}
      />
    </div>
  );
}
