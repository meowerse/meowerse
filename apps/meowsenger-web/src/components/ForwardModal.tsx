import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Icon } from "@meowerse/ui";
import { forwardMessages, type ChatSummary } from "../lib/chat";
import { Avatar } from "./Avatar";

/** A chat's display title: groups/channels by name; DMs by the peer's name. */
function chatTitle(c: ChatSummary): string {
  if (c.type === "group" || c.type === "channel") return c.name || (c.type === "channel" ? "channel" : "group");
  return c.peerDisplayName || c.peerUsername || c.name || "direct message";
}

/**
 * The forward modal: pick one or more chats and forward the given message bodies
 * into each. The list is searchable by title; the source chat is excluded (a
 * message can still be forwarded elsewhere). "forward" calls `forwardMessages` for
 * every selected target in parallel, tolerating partial failures — it reports how
 * many chats actually received the batch (skipping ones the server refused, e.g. a
 * channel where the caller can't post). On success the parent shows a toast, exits
 * select mode, and closes.
 *
 * `bodies` are the already-resolved message texts (deleted/empty ones filtered by
 * the caller). `onDone(count)` is called with the number of chats forwarded to
 * (0 ⇒ everything failed → the parent surfaces an error toast).
 */
export function ForwardModal({
  base,
  open,
  chats,
  bodies,
  excludeId,
  onClose,
  onDone,
}: {
  base: string;
  open: boolean;
  chats: ChatSummary[];
  bodies: string[];
  // The source chat id — excluded from the target list (you rarely forward to self).
  excludeId: string | null;
  onClose: () => void;
  // Called after a forward attempt: `sent` = chats that accepted, `failed` = chats
  // that errored. The parent maps this to a toast + exits select mode.
  onDone: (result: { sent: number; failed: number }) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset the picker whenever it (re)opens so a prior draft never leaks in.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(new Set());
    setBusy(false);
  }, [open]);

  // The forwardable targets: every chat except the source, filtered by the search
  // query (case-insensitive title match). Memoized so typing stays snappy.
  const targets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chats.filter((c) => {
      if (c.id === excludeId) return false;
      if (!q) return true;
      return chatTitle(c).toLowerCase().includes(q);
    });
  }, [chats, excludeId, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function doForward() {
    if (busy || selected.size === 0 || bodies.length === 0) return;
    setBusy(true);
    const ids = [...selected];
    // Fan out to every selected target; tolerate partial failure. `forwardMessages`
    // never rejects (it maps a network error to `{error:"network"}`), so a plain
    // Promise.all is safe. A target counts as "sent" only if the server acknowledged
    // (no error + forwarded > 0).
    const results = await Promise.all(ids.map((id) => forwardMessages(base, id, bodies)));
    const sent = results.filter((r) => !r.error && (r.forwarded ?? 0) > 0).length;
    const failed = ids.length - sent;
    setBusy(false);
    onDone({ sent, failed });
  }

  const count = bodies.length;

  return (
    <Modal open={open} onClose={onClose} title="forward" className="mw-forward">
      <p className="mw-forward__lead mw-muted">
        forward {count} message{count === 1 ? "" : "s"} to…
      </p>

      <label className="mw-field">
        <span className="mw-field__label">search chats</span>
        <input
          type="text"
          autoComplete="off"
          enterKeyHint="search"
          className="mw-input"
          value={query}
          placeholder="search by name…"
          aria-label="search chats"
          data-autofocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className="mw-forward__list" ref={listRef} role="listbox" aria-label="forward targets" aria-multiselectable="true">
        {targets.length === 0 ? (
          <p className="mw-muted mw-forward__empty">
            {chats.length <= (excludeId ? 1 : 0) ? "no other chats to forward to." : "no chats match."}
          </p>
        ) : (
          targets.map((c) => {
            const title = chatTitle(c);
            const membered = c.type === "group" || c.type === "channel";
            const channel = c.type === "channel";
            const isSel = selected.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={isSel}
                className={`mw-forwardrow${isSel ? " is-selected" : ""}`}
                onClick={() => toggle(c.id)}
              >
                <span className="mw-forwardrow__avatar">
                  {membered
                    ? <span className={`mw-avatar mw-avatar--md mw-groupavatar${channel ? " mw-groupavatar--channel" : ""}`} aria-label={title}><span aria-hidden="true" className="mono" data-case="preserve">{(title[0] ?? "#").toUpperCase()}</span></span>
                    : <Avatar url={c.peerAvatarUrl} name={title} size="md" />}
                </span>
                <span className="mw-forwardrow__name" data-case="preserve">
                  {channel && <Icon name="broadcast" size={14} className="mw-chatrow__glyph" />}
                  {membered && !channel && <Icon name="users" size={14} className="mw-chatrow__glyph" />}
                  {title}
                </span>
                <span className={`mw-forwardrow__check${isSel ? " is-on" : ""}`} aria-hidden="true">
                  {isSel ? <Icon name="check" size={14} /> : ""}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="mw-form__actions">
        <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={onClose}>cancel</button>
        <button
          className="mw-btn mw-btn--primary mw-btn--sm"
          onClick={doForward}
          disabled={busy || selected.size === 0}
        >
          {busy ? "…" : `forward${selected.size > 0 ? ` to ${selected.size}` : ""}`}
        </button>
      </div>
    </Modal>
  );
}
