import type { ChatSummary } from "../lib/chat";
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
  onSelect,
  onNewChatClick,
  loading,
}: {
  chats: ChatSummary[];
  activeId: string | null;
  online: Set<string>;
  onSelect: (id: string) => void;
  // Open the new-chat modal (Direct | Group). The modal lives in Chat.tsx.
  onNewChatClick: () => void;
  loading: boolean;
}) {
  return (
    <aside className="mw-chat__side">
      <div className="mw-chat__new">
        <button className="mw-btn mw-btn--primary mw-btn--md mw-chat__newbtn" onClick={onNewChatClick}>
          + new chat
        </button>
      </div>

      <nav className="mw-chat__list" aria-label="chats">
        {loading && chats.length === 0 && <p className="mw-muted" style={{ padding: "var(--space-3) var(--space-4)" }}>loading chats…</p>}
        {!loading && chats.length === 0 && (
          <p className="mw-muted" style={{ padding: "var(--space-3) var(--space-4)" }}>no chats yet. start one above.</p>
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
                <span className="mw-chatrow__preview">{c.lastMessage ?? "no messages yet"}</span>
              </span>
              {unread && <span className="mw-chatrow__unread">{c.unreadCount}</span>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
