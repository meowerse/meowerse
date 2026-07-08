import { useEffect, useState } from "react";
import { searchGlobal, type ChatSummary, type Message } from "../lib/chat";
import { Avatar } from "./Avatar";

/** Short relative time for the sidebar (now / 5m / 3h / 2d, else a date). */
function relTime(ms: number): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** True for a channel (broadcast). */
function isChannel(c: ChatSummary): boolean {
  return c.type === "channel";
}

/** True for a group OR channel — both carry a name + roster (vs a 1:1 DM). */
function isMembered(c: ChatSummary): boolean {
  return c.type === "group" || c.type === "channel";
}

/** A chat's display title: groups/channels by their name; DMs by the peer's name. */
function chatTitle(c: ChatSummary): string {
  if (isMembered(c)) return c.name || (isChannel(c) ? "channel" : "group");
  return c.peerDisplayName || c.peerUsername || c.name || "direct message";
}

export function ChatSidebar({
  chats,
  activeId,
  online,
  meId,
  base,
  onSelect,
  onOpenResult,
  onNewChatClick,
  loading,
}: {
  chats: ChatSummary[];
  activeId: string | null;
  online: Set<string>;
  // The signed-in user's id — to prefix their own last message with "you:".
  meId?: string;
  base: string;
  onSelect: (id: string) => void;
  // Open a global-search hit: (chatId, messageId) → parent opens the chat + jumps.
  onOpenResult: (chatId: string, msgId: string) => void;
  // Open the new-chat modal (Direct | Group). The modal lives in Chat.tsx.
  onNewChatClick: () => void;
  loading: boolean;
}) {
  // Global cross-chat search: debounced query → server → results shown IN PLACE of
  // the chat list. Clicking a hit opens that chat + jumps to the message.
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Message[] | null>(null); // null = not searching
  const [searching, setSearching] = useState(false);
  const chatById = new Map(chats.map((c) => [c.id, c]));
  useEffect(() => {
    const query = q.trim();
    if (!query) { setResults(null); setSearching(false); return; }
    setSearching(true);
    let cancelled = false;
    const t = window.setTimeout(() => {
      searchGlobal(base, query).then((r) => { if (!cancelled) { setResults(r); setSearching(false); } });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [q, base]);
  const searchMode = q.trim().length > 0;

  return (
    <aside className="mw-chat__side">
      <div className="mw-chat__new">
        <button className="mw-btn mw-btn--primary mw-btn--md mw-chat__newbtn" onClick={onNewChatClick}>
          + new chat
        </button>
        <input
          type="search"
          className="mw-input mw-side__search"
          placeholder="search all messages…"
          aria-label="search all messages"
          autoComplete="off"
          enterKeyHint="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {searchMode ? (
        <nav className="mw-chat__list" aria-label="search results">
          {searching && <div className="mw-side__searchnote mw-muted">searching…</div>}
          {!searching && results && results.length === 0 && (
            <div className="mw-side__searchnote mw-muted">no matches</div>
          )}
          {!searching && results && results.map((m) => {
            const c = chatById.get(m.chatId);
            const title = c ? chatTitle(c) : "chat";
            return (
              <button key={m.id} className="mw-chatrow" onClick={() => { onOpenResult(m.chatId, m.id); setQ(""); }}>
                <span className="mw-chatrow__body">
                  <span className="mw-chatrow__top">
                    <span className="mw-chatrow__name" data-case="preserve">{title}</span>
                    <span className="mw-chatrow__time">{relTime(m.createdAt)}</span>
                  </span>
                  <span className="mw-chatrow__preview">{m.body || "…"}</span>
                </span>
              </button>
            );
          })}
        </nav>
      ) : (

      <nav className="mw-chat__list" aria-label="chats">
        {loading && chats.length === 0 && (
          // Shimmer placeholder rows while the first list load is in flight.
          <div className="mw-skel-list" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="mw-skelrow">
                <span className="mw-skel mw-skel--avatar" />
                <span className="mw-skelrow__body">
                  <span className="mw-skel mw-skel--line mw-skel--w60" />
                  <span className="mw-skel mw-skel--line mw-skel--w80" />
                </span>
              </div>
            ))}
          </div>
        )}
        {!loading && chats.length === 0 && (
          <div className="mw-emptychats">
            <span className="mw-emptychats__glyph" aria-hidden="true">💬</span>
            <p className="mw-emptychats__title">no chats yet</p>
            <p className="mw-emptychats__sub mw-muted">start one to get going.</p>
            <button className="mw-btn mw-btn--primary mw-btn--sm" onClick={onNewChatClick}>+ new chat</button>
          </div>
        )}
        {chats.map((c) => {
          const title = chatTitle(c);
          const membered = isMembered(c);
          const channel = isChannel(c);
          const unread = c.unreadCount > 0;
          // Only DMs carry a peer presence dot — a group/channel's "online" is shown in its header.
          const isOnline = !membered && c.peerId != null && online.has(c.peerId);
          return (
            <button
              key={c.id}
              className={`mw-chatrow${c.id === activeId ? " is-active" : ""}${unread ? " has-unread" : ""}`}
              onClick={() => onSelect(c.id)}
            >
              <span className="mw-chatrow__avatar">
                {membered
                  ? <span className={`mw-avatar mw-avatar--md mw-groupavatar${channel ? " mw-groupavatar--channel" : ""}`} aria-label={title}><span aria-hidden="true" className="mono" data-case="preserve">{(title[0] ?? "#").toUpperCase()}</span></span>
                  : <Avatar url={c.peerAvatarUrl} name={title} size="md" />}
                {isOnline && <span className="mw-dot mw-dot--on" aria-label="online" />}
              </span>
              <span className="mw-chatrow__body">
                <span className="mw-chatrow__top">
                  <span className="mw-chatrow__name" data-case="preserve">
                    {channel && <span className="mw-chatrow__glyph" aria-hidden="true">📡 </span>}
                    {membered && !channel && <span className="mw-chatrow__glyph" aria-hidden="true">👥 </span>}
                    {title}
                  </span>
                  <span className="mw-chatrow__time">{relTime(c.lastActivity)}</span>
                </span>
                <span className="mw-chatrow__preview">
                  {c.lastMessage
                    ? <>{c.lastSenderId && c.lastSenderId === meId && <span className="mw-chatrow__you">you: </span>}{c.lastMessage}</>
                    : "no messages yet"}
                </span>
              </span>
              {unread && <span className="mw-chatrow__unread">{c.unreadCount}</span>}
            </button>
          );
        })}
      </nav>
      )}
    </aside>
  );
}
