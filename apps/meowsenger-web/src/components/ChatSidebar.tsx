import { useState } from "react";
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

/** A DM's display title: the peer's name, else username, else a generic label. */
function chatTitle(c: ChatSummary): string {
  return c.peerDisplayName || c.peerUsername || c.name || "direct message";
}

export function ChatSidebar({
  chats,
  activeId,
  onSelect,
  onNewChat,
  loading,
}: {
  chats: ChatSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: (username: string) => Promise<string | null>;
  loading: boolean;
}) {
  const [uname, setUname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    const u = uname.trim().replace(/^@/, "");
    if (!u || busy) return;
    setBusy(true);
    setError(null);
    const err = await onNewChat(u);
    setBusy(false);
    if (err) {
      setError(err);
    } else {
      setUname("");
    }
  }

  return (
    <aside className="mw-chat__side">
      <div className="mw-chat__new">
        <div className="mw-row" style={{ flexWrap: "nowrap", gap: "var(--space-2)" }}>
          <input
            type="text"
            value={uname}
            placeholder="start a chat by username…"
            aria-label="username"
            onChange={(e) => setUname(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") start(); }}
            style={{ flex: 1, minWidth: 0, minHeight: 38, padding: "8px 12px", font: "inherit", fontSize: "var(--text-sm)", color: "var(--text-primary)", background: "var(--surface-1)", border: "0.5px solid var(--border-strong)", borderRadius: "var(--radius)" }}
          />
          <button className="mw-btn mw-btn--primary mw-btn--sm" onClick={start} disabled={busy || !uname.trim()}>
            {busy ? "…" : "chat"}
          </button>
        </div>
        {error && <p className="mw-chat__err">{error}</p>}
      </div>

      <nav className="mw-chat__list" aria-label="chats">
        {loading && chats.length === 0 && <p className="mw-muted" style={{ padding: "var(--space-3) var(--space-4)" }}>loading chats…</p>}
        {!loading && chats.length === 0 && (
          <p className="mw-muted" style={{ padding: "var(--space-3) var(--space-4)" }}>no chats yet. start one above.</p>
        )}
        {chats.map((c) => {
          const title = chatTitle(c);
          return (
            <button
              key={c.id}
              className={`mw-chatrow${c.id === activeId ? " is-active" : ""}`}
              onClick={() => onSelect(c.id)}
            >
              <Avatar url={c.peerAvatarUrl} name={title} size="md" />
              <span className="mw-chatrow__body">
                <span className="mw-chatrow__top">
                  <span className="mw-chatrow__name" data-case="preserve">{title}</span>
                  <span className="mw-chatrow__time">{relTime(c.lastActivity)}</span>
                </span>
                <span className="mw-chatrow__preview">{c.lastMessage ?? "no messages yet"}</span>
              </span>
              {c.unreadCount > 0 && <span className="mw-chatrow__unread">{c.unreadCount}</span>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
