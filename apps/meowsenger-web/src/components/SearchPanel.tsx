import { useEffect, useRef, useState } from "react";
import { searchChat, type Message } from "../lib/chat";
import { Avatar } from "./Avatar";
import { Icon } from "@meowerse/ui";

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The within-chat search panel (Slice 9): an inline input in the chat header plus a
 * results list. On submit it calls `searchChat` (member-gated, server-side over the
 * plaintext bodies) and shows sender + a matched snippet + time; clicking a result
 * calls `onJump(id)` (which reuses Chat's jump-to-original loads-until-found + flash)
 * and closes. Escape / the ✕ clears + closes. Owns its own query + results so Chat
 * stays lean; `resolveName` maps a senderId → a display name for the roster/peer.
 */
export function SearchPanel({
  base,
  chatId,
  resolveName,
  meId,
  onJump,
  onClose,
}: {
  base: string;
  chatId: string;
  resolveName: (senderId: string) => string;
  meId: string | null;
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Message[] | null>(null); // null = not searched yet
  // The term the current `results` correspond to — so the "no match" label doesn't
  // show a mismatched query after the input is edited but before a new run (#36).
  const [searchedTerm, setSearchedTerm] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Bump on every run so a slow earlier request can't overwrite a newer one.
  const runRef = useRef(0);

  // Focus the input as the panel opens.
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Reset when switching chats (the panel is re-mounted per chat via a key).
  useEffect(() => { setQ(""); setResults(null); setSearchedTerm(""); setLoading(false); }, [chatId]);

  async function run(term: string) {
    const query = term.trim();
    if (!query) { setResults(null); setLoading(false); return; }
    const run = ++runRef.current;
    setLoading(true);
    const found = await searchChat(base, chatId, query);
    if (run !== runRef.current) return; // a newer search superseded this one
    setSearchedTerm(query); // pin the term these results answer, before showing them
    setResults(found);
    setLoading(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "Enter") { e.preventDefault(); void run(q); }
  }

  return (
    <div className="mw-search" role="search">
      <div className="mw-search__bar">
        <span className="mw-search__icon" aria-hidden="true"><Icon name="search" size={16} /></span>
        <input
          ref={inputRef}
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          className="mw-search__input"
          placeholder="search this chat…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="search this chat"
        />
        <button
          type="button"
          className="mw-btn mw-btn--ghost mw-btn--sm"
          onClick={() => void run(q)}
          disabled={!q.trim()}
        >search</button>
        <button
          type="button"
          className="mw-search__close mw-btn mw-btn--ghost mw-btn--sm"
          onClick={onClose}
          aria-label="close search"
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      {(loading || results !== null) && (
        <div className="mw-search__results" role="listbox" aria-label="search results">
          {loading ? (
            <p className="mw-search__note mw-muted">searching…</p>
          ) : results && results.length === 0 ? (
            <p className="mw-search__note mw-muted">no messages match “{searchedTerm}”.</p>
          ) : (
            results?.map((m) => {
              const name = m.senderId === meId ? "you" : resolveName(m.senderId);
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected="false"
                  className="mw-searchrow"
                  onClick={() => { onJump(m.id); onClose(); }}
                >
                  <Avatar url={null} name={name} size="sm" />
                  <span className="mw-searchrow__col">
                    <span className="mw-searchrow__top">
                      <span className="mw-searchrow__name" data-case="preserve">{name}</span>
                      <span className="mw-searchrow__time">{fmtWhen(m.createdAt)}</span>
                    </span>
                    <span className="mw-searchrow__snippet">{m.body}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
