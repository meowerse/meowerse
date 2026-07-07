import { useEffect, useRef, useState } from "react";
import type { Message } from "../lib/chat";
import { Avatar } from "./Avatar";

/** A rendered bubble: a real Message, plus a client-only tempId while optimistic. */
export interface Bubble extends Message {
  tempId?: string;
  pending?: boolean;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * One message row: avatar (peers) + a bubble carrying an optional quoted reply
 * preview, the body (or a "message deleted" placeholder), an inline editor, and
 * a select checkbox. The frame/socket logic lives in Chat.tsx — this component is
 * pure presentation + local edit-draft state, driven by callbacks.
 */
export function MessageItem({
  m,
  meId,
  mine,
  senderName,
  senderAvatarUrl,
  replyName,
  seen,
  canEdit,
  canDelete,
  selectMode,
  selected,
  editing,
  onReply,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onToggleSelect,
  onContextMenu,
  onReact,
  onToggleReaction,
  onJumpToReply,
  registerRef,
}: {
  m: Bubble;
  meId: string | null;
  mine: boolean;
  // The sender's resolved display name + avatar for a non-own message. In a DM
  // this is the peer; in a group it's looked up from the member map (or the raw
  // sender id if unknown). Own messages ignore both.
  senderName: string;
  senderAvatarUrl: string | null;
  // Name to show for THIS message's quoted-reply parent ("you" if it's mine,
  // otherwise the parent sender's resolved name — the peer in a DM).
  replyName: string;
  seen: boolean;
  canEdit: boolean;
  canDelete: boolean;
  selectMode: boolean;
  selected: boolean;
  editing: boolean;
  onReply: (m: Bubble) => void;
  onStartEdit: (m: Bubble) => void;
  onCancelEdit: () => void;
  onSaveEdit: (m: Bubble, body: string) => void;
  onDelete: (m: Bubble) => void;
  onToggleSelect: (m: Bubble) => void;
  onContextMenu: (m: Bubble, x: number, y: number) => void;
  // Slice 9 — open the emoji picker anchored at (x,y) to react to THIS message.
  onReact: (m: Bubble, x: number, y: number) => void;
  // Slice 9 — toggle a specific emoji on THIS message (clicking a reaction pill).
  onToggleReaction: (m: Bubble, emoji: string) => void;
  onJumpToReply: (id: string) => void;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const key = m.tempId ?? m.id;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const longPressRef = useRef<number | null>(null);
  const [draft, setDraft] = useState(m.body);

  // Re-seed the draft whenever we (re-)enter edit mode for this message.
  useEffect(() => {
    if (editing) setDraft(m.body);
  }, [editing, m.body]);

  // Register the row element for reply jump-to-original scroll/highlight (by real id).
  useEffect(() => {
    registerRef(m.id, rowRef.current);
    return () => registerRef(m.id, null);
  }, [m.id, registerRef]);

  function clearLongPress() {
    if (longPressRef.current != null) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }

  // Long-press (mobile) opens the context menu near the touch point. A move/scroll
  // or lift before the timer fires cancels it (so a swipe/scroll isn't hijacked).
  function onTouchStart(e: React.TouchEvent) {
    if (m.isDeleted) return;
    const t = e.touches[0];
    const { clientX, clientY } = t;
    clearLongPress();
    longPressRef.current = window.setTimeout(() => {
      longPressRef.current = null;
      onContextMenu(m, clientX, clientY);
    }, 480);
  }

  const deleted = !!m.isDeleted;

  return (
    <div
      key={key}
      ref={rowRef}
      data-mid={m.id}
      className={`mw-msg${mine ? " mw-msg--me" : ""}${selected ? " is-selected" : ""}`}
      onContextMenu={(e) => {
        if (deleted) return;
        e.preventDefault();
        onContextMenu(m, e.clientX, e.clientY);
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={clearLongPress}
      onTouchMove={clearLongPress}
    >
      {selectMode && !deleted && (
        <input
          type="checkbox"
          className="mw-msg__check"
          checked={selected}
          onChange={() => onToggleSelect(m)}
          aria-label="select message"
        />
      )}
      {!mine && <Avatar url={senderAvatarUrl} name={senderName} size="sm" />}
      <div className="mw-msg__col">
        {!mine && <span className="mw-msg__name" data-case="preserve">{senderName}</span>}

        {deleted ? (
          <div className={`mw-bubble mw-bubble--deleted${mine ? " mw-bubble--me" : ""}`}>
            <span className="mw-bubble__body mw-bubble__deleted">message deleted</span>
          </div>
        ) : editing ? (
          <div className={`mw-bubble mw-bubble--editing${mine ? " mw-bubble--me" : ""}`}>
            <div className="mw-edit">
              <textarea
                className="mw-edit__input"
                value={draft}
                autoFocus
                aria-label="edit message"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); onCancelEdit(); }
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSaveEdit(m, draft); }
                }}
              />
              <div className="mw-edit__actions">
                <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={onCancelEdit}>cancel</button>
                <button className="mw-btn mw-btn--primary mw-btn--sm" onClick={() => onSaveEdit(m, draft)} disabled={!draft.trim()}>save</button>
              </div>
            </div>
          </div>
        ) : (
          <div className={`mw-bubble${mine ? " mw-bubble--me" : ""}${m.pending ? " is-pending" : ""}`}>
            <div className="mw-bubble__stack">
              {m.isForwarded && (
                <span className="mw-bubble__forwarded" aria-label="forwarded message">
                  <span aria-hidden="true">↪</span> forwarded
                </span>
              )}
              {m.replyTo && (
                <button
                  type="button"
                  className="mw-quote"
                  onClick={() => onJumpToReply(m.replyTo!.id)}
                  aria-label="jump to replied message"
                >
                  <span className="mw-quote__name" data-case="preserve">
                    {meId != null && m.replyTo.senderId === meId ? "you" : replyName}
                  </span>
                  <span className="mw-quote__body">{m.replyTo.body}</span>
                </button>
              )}
              <span className="mw-bubble__row">
                <span className="mw-bubble__body">{m.body}</span>
                {m.editedAt ? <span className="mw-bubble__edited" title="edited">edited</span> : null}
                <span className="mw-bubble__time">{fmtTime(m.createdAt)}</span>
              </span>
            </div>

            {!selectMode && (
              <div className="mw-msg__actions" role="group" aria-label="message actions">
                <button
                  className="mw-msg__act"
                  title="react"
                  aria-label="react"
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    onReact(m, r.left + r.width / 2, r.bottom + 4);
                  }}
                >😀</button>
                <button className="mw-msg__act" title="reply" aria-label="reply" onClick={() => onReply(m)}>↩</button>
                {canEdit && <button className="mw-msg__act" title="edit" aria-label="edit" onClick={() => onStartEdit(m)}>✎</button>}
                {canDelete && <button className="mw-msg__act" title="delete" aria-label="delete" onClick={() => onDelete(m)}>🗑</button>}
                <button
                  className="mw-msg__act"
                  title="more"
                  aria-label="more actions"
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    onContextMenu(m, r.left, r.bottom);
                  }}
                >⋯</button>
              </div>
            )}
          </div>
        )}

        {/* Reaction pills below the bubble (Slice 9): emoji + count, highlighted
            when the viewer reacted; clicking one toggles it. Hidden while editing
            or on a tombstone. */}
        {!deleted && !editing && m.reactions && m.reactions.length > 0 && (
          <div className={`mw-reactions${mine ? " mw-reactions--me" : ""}`} role="group" aria-label="reactions">
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={`mw-reaction${r.mine ? " is-mine" : ""}`}
                aria-pressed={r.mine}
                aria-label={`${r.emoji} ${r.count}${r.mine ? " — you reacted" : ""}`}
                onClick={() => onToggleReaction(m, r.emoji)}
              >
                <span className="mw-reaction__emoji" aria-hidden="true">{r.emoji}</span>
                <span className="mw-reaction__count">{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {seen && !deleted && <span className="mw-msg__seen" aria-label="seen">seen</span>}
      </div>
    </div>
  );
}
