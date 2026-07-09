import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@meowerse/ui";
import { getSession, type SessionUser } from "../lib/meowsengerApi";
import { listChats, openDirect, resolveChat, getMembers, type ChatSummary, type Member } from "../lib/chat";
import { fmtDay } from "../lib/messageText";
import { useConversation } from "../hooks/useConversation";
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
export default function Chat({ base }: { base: string }) {
  const [me, setMe] = useState<SessionUser | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

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
  // Slice 5 — group UI state.
  const [newChatOpen, setNewChatOpen] = useState(false); // the Direct|Group modal
  const [drawerOpen, setDrawerOpen] = useState(false); // the member-management drawer
  // Slice 8 — the forward modal + the message bodies queued for forwarding. Non-null ⇒ open.
  const [forwardBodies, setForwardBodies] = useState<string[] | null>(null);
  // Slice 9 — the emoji picker anchored over a message (non-null ⇒ open).
  const [emojiFor, setEmojiFor] = useState<{ m: Bubble; x: number; y: number } | null>(null);
  // Slice 9 — the in-chat search panel: whether it's open (the panel owns its results).
  const [searchOpen, setSearchOpen] = useState(false);
  // Mobile header overflow ("⋯") menu anchor — collapses the header actions on phones.
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  // Browser connectivity, for the header connection dot (offline=red vs reconnecting=amber).
  const [netOnline, setNetOnline] = useState(true);
  // Resolved per-sender identity for the ACTIVE group, keyed by userId. Empty for DMs.
  const [memberMap, setMemberMap] = useState<Map<string, SenderInfo>>(new Map());

  const toastTimerRef = useRef<number | null>(null);

  // SR-announce bookkeeping (#7): whether the initial history for the active chat has
  // settled (so the backlog isn't announced), and a createdAt high-water mark so only
  // genuinely-newer incoming tail messages announce (paged-in / jumped history never
  // crosses it). Reset on every chat switch.
  const announceSettledRef = useRef(false);
  const announceHighWaterRef = useRef(-Infinity);
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
  const myRole = me ? memberMap.get(me.id)?.role : undefined;
  // Has the active channel's roster loaded yet? Until it has we can't know the role,
  // so we DON'T flash the Composer (a member would see it briefly before the read-
  // only note replaces it) — the input area stays empty meanwhile.
  const channelRoleKnown = memberMap.size > 0;
  // A channel is broadcast: only owner/admin post. A plain member sees a read-only note.
  const channelReadOnly = isChannel && myRole === "member";
  // Suppress the Composer on a channel until the role is known (avoids the flash).
  const channelComposerPending = isChannel && !channelRoleKnown;

  const peerName = activeChat ? (activeChat.peerDisplayName || activeChat.peerUsername || activeChat.name || "direct message") : "";

  // Resolve a sender id → a human name for the backgrounded-message notification: a
  // group/channel uses the roster (falling back to the raw id), a DM uses the peer
  // name (Slice 9). Fed into the hook, which mirrors it so its stable applyFrame reads
  // the current roster/peer. Recomputed each render (cheap; the hook re-mirrors it).
  const resolveSenderName = (senderId: string): string =>
    isMembered ? (memberMap.get(senderId)?.name ?? senderId) : (peerName || "new message");
  // Mirror into refs so the SR-announce effect reads the current resolver + user id
  // without re-running every render (it depends only on messages + loadingHistory).
  resolveNameRef.current = resolveSenderName;
  meIdRef.current = me?.id ?? null;

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
  // Membership revoked (removed by an admin / left elsewhere): close the chat, tell
  // the user, and refresh the sidebar (the revoked chat drops out — they're no longer
  // a member). The socket already stopped reconnecting on the `revoked` frame.
  const onRevoked = useCallback(() => {
    showToast("you're no longer a member of this chat");
    setActiveId(null);
    void listChats(base).then(setChats);
  }, [showToast, base]);

  // The realtime engine for the active chat (socket + history + presence + actions).
  const {
    messages, connected, loadingHistory, hasNewer, online, away, peerTyping, peerLastReadAt,
    logRef, onLogScroll, registerRow, activeRef,
    send, sendEdit, sendDelete, sendReact, sendTyping,
    jumpToMessage, jumpToLatest, armJump,
  } = useConversation({ base, activeId, me, resolveSenderName, onToast: showToast, onActiveRead, onMessageDeleted, consumeReply, onRevoked });

  // Fetch + index the active group's roster into a userId→{name,avatar,role} map so
  // MessageItem can render each sender's identity. No-op for DMs.
  const loadMembers = useCallback(async (chatId: string) => {
    const list: Member[] = await getMembers(base, chatId);
    if (activeRef.current !== chatId) return; // switched away mid-fetch
    const map = new Map<string, SenderInfo>();
    for (const m of list) {
      map.set(m.userId, { name: m.displayName || m.username, avatarUrl: m.avatarUrl, role: m.role });
    }
    setMemberMap(map);
  }, [base, activeRef]);

  // Load who-am-i + the sidebar list once, then honor a deep-link in the URL:
  //   /app?chat=<idOrSlug>[&m=<messageId>]
  // The URL is kept in sync with the open chat (see the sync effect below) so a
  // reload / shared link lands back in the same chat (+ jumps to the message).
  useEffect(() => {
    getSession(base).then((s) => setMe(s.user ?? null));
    listChats(base).then((cs) => {
      setChats(cs);
      setLoadingChats(false);
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
    });
  }, [base, armJump, showToast]);

  // Keep the address bar in sync with the open chat, so a reload / copied link
  // returns here. replaceState (not push) — chat switches aren't history entries.
  const urlSyncReadyRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Skip the FIRST run: on mount activeId is null and the deep-link (?chat/?m) is
    // still being read asynchronously (after listChats resolves). Stripping the params
    // here would clobber the link before it's consumed — the bug that broke deep-links.
    if (!urlSyncReadyRef.current) { urlSyncReadyRef.current = true; return; }
    const url = new URL(window.location.href);
    if (activeId) url.searchParams.set("chat", activeId);
    else url.searchParams.delete("chat");
    url.searchParams.delete("m"); // the message anchor is one-shot (consumed on open)
    window.history.replaceState({}, "", url.pathname + url.search);
  }, [activeId]);

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
    setMemberMap(new Map());
    setConfirmBulk(false);
    // Re-arm the SR announcer so the next chat's backlog isn't read out (#7).
    announceSettledRef.current = false;
    announceHighWaterRef.current = -Infinity;
    setAnnouncements([]);
  }, [activeId]);

  // Announce ONLY new incoming messages (#7): once the initial history settles, a tail
  // message whose timestamp beats the high-water mark and that isn't ours/deleted is
  // pushed into the aria-live region. The backlog, paged-in older pages, and jumped
  // windows never cross the water mark, so they stay silent.
  useEffect(() => {
    if (loadingHistory) return; // initial history still loading — not settled yet
    if (!announceSettledRef.current) {
      // Settle point: baseline the water mark at the newest loaded message (or leave it
      // at -Infinity for an empty chat so its first live message announces).
      announceSettledRef.current = true;
      let hi = -Infinity;
      for (const m of messages) if (m.createdAt > hi) hi = m.createdAt;
      announceHighWaterRef.current = hi;
      return;
    }
    const tail = messages[messages.length - 1];
    if (!tail || tail.createdAt <= announceHighWaterRef.current) return;
    announceHighWaterRef.current = tail.createdAt;
    // Own sends bump the water mark but aren't announced; deleted/empty are skipped.
    if (tail.senderId === meIdRef.current || tail.isDeleted || tail.pending) return;
    const who = resolveNameRef.current(tail.senderId);
    const body = tail.body.trim().slice(0, 120) || "sent a message";
    setAnnouncements((prev) => [...prev, { id: tail.tempId ?? tail.id, text: `${who}: ${body}` }].slice(-3));
  }, [messages, loadingHistory]);

  // When the active chat is a group OR channel, (re)load its roster into the sender
  // map (channels need it to render per-sender identity and derive the caller's role).
  useEffect(() => {
    if (activeId && isMembered) void loadMembers(activeId);
  }, [activeId, isMembered, loadMembers]);

  // Live-ish sidebar: refresh listChats on window focus + a 45s interval while the
  // tab is visible. Surfaces unread for background chats. Merge so the active chat's
  // optimistic unread=0 isn't clobbered by a stale poll. (The read catch-up on focus
  // lives in the conversation hook — these listeners only refresh the list.)
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
  }, [base, activeRef]);

  // Reply/edit/delete route through the hook; ownership + windows are UX gating only.
  function sendWith(body: string) {
    send(body, replyingTo?.id ?? null);
  }
  function onSaveEdit(m: Bubble, body: string) {
    setEditingId(null);
    sendEdit(m, body);
  }

  // Can I still edit / delete this message? (own + within window, ignoring optimistic
  // bubbles and tombstones). Mirrors the server's checks — purely for showing the action.
  function canEdit(m: Bubble): boolean {
    return !!me && m.senderId === me.id && !m.pending && !m.isDeleted && Date.now() - m.createdAt <= EDIT_WINDOW_MS;
  }
  function canDelete(m: Bubble): boolean {
    return !!me && m.senderId === me.id && !m.pending && !m.isDeleted && Date.now() - m.createdAt <= DELETE_WINDOW_MS;
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
    setActiveId(chatId);
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
    // Bulk-delete only my own, still-deletable messages; silently skip the rest.
    for (const m of messages) {
      if (selected.has(m.id) && canDelete(m)) sendDelete(m);
    }
    setConfirmBulk(false);
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
    const items: MenuItem[] = [{ label: "react", onClick: () => openEmoji(m, at.x, at.y) }];
    items.push({ label: "reply", onClick: () => setReplyingTo(m) });
    if (canEdit(m)) items.push({ label: "edit", onClick: () => setEditingId(m.id) });
    if (canDelete(m)) items.push({ label: "delete", onClick: () => sendDelete(m) });
    items.push({ label: "forward", onClick: () => forwardOne(m) });
    items.push({ label: "copy", onClick: () => copyText(m.body) });
    if (!m.pending) items.push({ label: "copy link", onClick: () => copyMessageLink(m) });
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
        network: "couldn't reach the server — try again",
      };
      // Generic fallback so a raw server code never leaks into the UI.
      return copy[r.error ?? ""] ?? "could not start chat";
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
  // after a member-drawer mutation, without disturbing the socket/messages.
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

  const peerOnline = peerId != null && online.has(peerId);
  // Online but all their tabs are backgrounded → "away".
  const peerAway = peerOnline && peerId != null && away.has(peerId);
  // Membered-chat header derivations.
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
        base={base}
        onSelect={setActiveId}
        onOpenResult={openSearchResult}
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
              <span
                className="mw-chat__conn"
                data-state={connected ? "on" : netOnline ? "wait" : "off"}
                role="status"
                title={connected ? "connected" : netOnline ? "reconnecting…" : "offline"}
                aria-label={connected ? "connected" : netOnline ? "reconnecting" : "offline"}
              />
              {/* Inline actions on desktop; collapsed into the ⋯ menu on phones (CSS). */}
              <div className="mw-chat__actions">
                <button
                  className="mw-btn mw-btn--ghost mw-btn--sm mw-chat__linkbtn"
                  onClick={copyChatLink}
                  aria-label="copy link to this chat"
                  title="copy link"
                >🔗</button>
                <button
                  className={`mw-btn mw-btn--ghost mw-btn--sm mw-chat__searchbtn${searchOpen ? " is-on" : ""}`}
                  onClick={() => setSearchOpen((v) => !v)}
                  aria-label="search this chat"
                  aria-pressed={searchOpen}
                  title="search"
                >🔍</button>
              </div>
              <button
                className="mw-btn mw-btn--ghost mw-btn--sm mw-chat__more"
                aria-label="more chat actions"
                aria-haspopup="menu"
                aria-expanded={moreMenu != null}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMoreMenu({ x: r.right - 168, y: r.bottom + 6 });
                }}
              >⋯</button>
            </header>

            {moreMenu && (
              <MessageMenu
                x={moreMenu.x}
                y={moreMenu.y}
                items={[
                  { label: "🔍 search", onClick: () => setSearchOpen((v) => !v) },
                  { label: "🔗 copy link", onClick: copyChatLink },
                ]}
                onClose={() => setMoreMenu(null)}
              />
            )}

            {searchOpen && activeId && (
              <SearchPanel
                key={activeId}
                base={base}
                chatId={activeId}
                resolveName={(id) => resolveSenderName(id)}
                meId={me?.id ?? null}
                onJump={jumpToMessage}
                onClose={() => setSearchOpen(false)}
              />
            )}

            <div className="mw-chat__log" ref={logRef} onScroll={onLogScroll}>
              {loadingHistory && messages.length === 0 && (
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
                  ? (memberMap.get(m.senderId) ?? { name: m.senderId, avatarUrl: null })
                  : { name: peerName, avatarUrl: activeChat.peerAvatarUrl };
                const replyName = isMembered && m.replyTo
                  ? (memberMap.get(m.replyTo.senderId)?.name ?? m.replyTo.senderId)
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
                    />
                  </Fragment>
                );
              })}
            </div>

            {hasNewer && (
              // Viewing a detached window (jumped to an old message) — a way back to live.
              <button className="mw-chat__tolatest" onClick={() => void jumpToLatest()} aria-label="jump to latest messages">
                jump to latest ↓
              </button>
            )}

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
                  onClick={requestDeleteSelected}
                  disabled={selected.size === 0}
                >delete</button>
                <button className="mw-btn mw-btn--primary mw-btn--sm" onClick={exitSelect}>cancel</button>
              </div>
            ) : channelComposerPending ? (
              // Channel roster still loading → role unknown. Reserve the composer's
              // footprint (no flash of the input) until we know member vs admin.
              <div className="mw-readonly mw-readonly--pending" aria-hidden="true" />
            ) : channelReadOnly ? (
              // Broadcast channel + the caller is a plain member → no Composer.
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
