import { useEffect, useRef, useState } from "react";
import { Modal } from "@meowerse/ui";
import { createGroup, createChannel, slugAvailable, slugify } from "../lib/chat";

/** A chosen group member, held as a chip until the group is created. */
interface Chip {
  username: string;
}

/** Human-readable copy for the server error codes the create path can return. */
const ERROR_COPY: Record<string, string> = {
  name_required: "give it a name",
  user_not_found: "no user with that username",
  bad_slug: "slug must be 3–32 chars: a–z, 0–9, -",
  slug_taken: "that slug is taken",
  too_many_members: "too many members at once (max 200)",
  network: "couldn't reach the server",
};

/**
 * The "new chat" modal: a Direct | Group | Channel tabbed dialog. Direct resolves
 * an exact username → open-or-create a DM (via the parent's `onDirect`, which wraps
 * the existing `openDirect`). Group and Channel share the same form (name, member
 * chips, visibility toggle, optional live-checked slug) but call `createGroup` vs
 * `createChannel` — a channel is a broadcast group where only owner/admin post
 * (the DO enforces the read-only rule). On success the parent selects the new chat
 * and the modal closes.
 *
 * There is no fuzzy user search in v1 (exact usernames only) — the pickers resolve
 * usernames on submit/add, and the server surfaces `user_not_found` for typos.
 */
export function NewChatModal({
  base,
  open,
  onClose,
  onDirect,
  onCreated,
}: {
  base: string;
  open: boolean;
  onClose: () => void;
  // Resolve a DM by username. Returns an error message to show, or null on success.
  onDirect: (username: string) => Promise<string | null>;
  // Called with the new group's chatId after a successful create.
  onCreated: (chatId: string) => void;
}) {
  const [tab, setTab] = useState<"direct" | "group" | "channel">("direct");
  const isChannel = tab === "channel";

  // ---- Direct tab ----
  const [directName, setDirectName] = useState("");
  const [directErr, setDirectErr] = useState<string | null>(null);

  // ---- Group / Channel tab (shared form; the tab picks create* + copy) ----
  const [name, setName] = useState("");
  const [memberInput, setMemberInput] = useState("");
  const [members, setMembers] = useState<Chip[]>([]);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [slug, setSlug] = useState("");
  const [slugState, setSlugState] = useState<"idle" | "checking" | "ok" | "taken" | "bad">("idle");
  const [groupErr, setGroupErr] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const slugSeq = useRef(0);

  // Reset all fields whenever the modal (re)opens, so a prior draft never leaks in.
  useEffect(() => {
    if (!open) return;
    setTab("direct");
    setDirectName(""); setDirectErr(null);
    setName(""); setMemberInput(""); setMembers([]);
    setVisibility("private"); setSlug(""); setSlugState("idle");
    setGroupErr(null); setBusy(false);
  }, [open]);

  // Live slug availability: normalize as the user types, then debounce a check
  // against the server. `slugSeq` guards against a stale response overwriting a
  // newer one (last-write-wins). Empty slug is allowed (optional) → idle.
  useEffect(() => {
    const normalized = slug;
    if (!normalized) { setSlugState("idle"); return; }
    if (normalized.length < 3 || normalized.length > 32) { setSlugState("bad"); return; }
    const seq = ++slugSeq.current;
    setSlugState("checking");
    const t = window.setTimeout(async () => {
      const free = await slugAvailable(base, normalized);
      if (seq !== slugSeq.current) return; // a newer keystroke superseded us
      setSlugState(free ? "ok" : "taken");
    }, 350);
    return () => window.clearTimeout(t);
  }, [slug, base]);

  function addChip() {
    const u = memberInput.trim().replace(/^@/, "");
    if (!u) return;
    if (!members.some((m) => m.username.toLowerCase() === u.toLowerCase())) {
      setMembers((prev) => [...prev, { username: u }]);
    }
    setMemberInput("");
  }
  function removeChip(username: string) {
    setMembers((prev) => prev.filter((m) => m.username !== username));
  }

  async function submitDirect() {
    const u = directName.trim().replace(/^@/, "");
    if (!u || busy) return;
    setBusy(true); setDirectErr(null);
    const err = await onDirect(u);
    setBusy(false);
    if (err) setDirectErr(err);
    else onClose();
  }

  // A username typed into the add-member box but not yet "added" (chipped) still
  // counts as a chosen member. Fold it into the effective roster — deduped the same
  // way addChip does — so it isn't silently dropped and can't wrongly block submit
  // (#11). Both the gate and the create call use this, and the button enables off it.
  const pendingMember = memberInput.trim().replace(/^@/, "");
  const effectiveMembers: Chip[] =
    pendingMember && !members.some((m) => m.username.toLowerCase() === pendingMember.toLowerCase())
      ? [...members, { username: pendingMember }]
      : members;

  async function submitGroup() {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { setGroupErr(ERROR_COPY.name_required); return; }
    // Groups need at least one other member; a channel is broadcast — the owner can
    // create it empty and share the link, so initial members are optional there.
    if (!isChannel && effectiveMembers.length < 1) { setGroupErr("add at least one member"); return; }
    if (slug && slugState === "taken") { setGroupErr(ERROR_COPY.slug_taken); return; }
    if (slug && slugState === "bad") { setGroupErr(ERROR_COPY.bad_slug); return; }
    setBusy(true); setGroupErr(null);
    // Reflect the folded-in member as a chip and clear the input we just consumed.
    setMembers(effectiveMembers);
    setMemberInput("");
    const usernames = effectiveMembers.map((m) => m.username);
    const r = isChannel
      ? await createChannel(base, { name: trimmed, members: usernames, visibility, slug: slug || null })
      : await createGroup(base, { name: trimmed, members: usernames, visibility, slug: slug || null });
    setBusy(false);
    if (r.error || !r.chatId) {
      setGroupErr(ERROR_COPY[r.error ?? ""] ?? `could not create ${isChannel ? "channel" : "group"}`);
      return;
    }
    onCreated(r.chatId);
    onClose();
  }

  const slugHint = (() => {
    if (!slug) return null;
    if (slugState === "checking") return <span className="mw-slug__hint">checking…</span>;
    if (slugState === "ok") return <span className="mw-slug__hint is-ok">available</span>;
    if (slugState === "taken") return <span className="mw-slug__hint is-bad">taken</span>;
    if (slugState === "bad") return <span className="mw-slug__hint is-bad">3–32 chars: a–z 0–9 -</span>;
    return null;
  })();

  return (
    <Modal open={open} onClose={onClose} title="new chat" className="mw-newchat">
      <div className="mw-tabs" role="tablist" aria-label="chat type">
        <button
          role="tab"
          aria-selected={tab === "direct"}
          className={`mw-tab${tab === "direct" ? " is-active" : ""}`}
          onClick={() => setTab("direct")}
        >direct</button>
        <button
          role="tab"
          aria-selected={tab === "group"}
          className={`mw-tab${tab === "group" ? " is-active" : ""}`}
          onClick={() => setTab("group")}
        >group</button>
        <button
          role="tab"
          aria-selected={tab === "channel"}
          className={`mw-tab${tab === "channel" ? " is-active" : ""}`}
          onClick={() => setTab("channel")}
        >channel</button>
      </div>

      {tab === "direct" ? (
        <div className="mw-form" role="tabpanel">
          <label className="mw-field">
            <span className="mw-field__label">username</span>
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="mw-input"
              value={directName}
              placeholder="username…"
              aria-label="username"
              data-autofocus
              onChange={(e) => setDirectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitDirect(); }}
            />
          </label>
          {directErr && <p className="mw-chat__err">{directErr}</p>}
          <div className="mw-form__actions">
            <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={onClose}>cancel</button>
            <button className="mw-btn mw-btn--primary mw-btn--sm" onClick={submitDirect} disabled={busy || !directName.trim()}>
              {busy ? "…" : "start chat"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mw-form" role="tabpanel">
          {isChannel && (
            <p className="mw-note mw-note--info">
              a channel is broadcast — only admins post. everyone else subscribes to read.
            </p>
          )}
          <label className="mw-field">
            <span className="mw-field__label">{isChannel ? "channel name" : "group name"}</span>
            <input
              type="text"
              autoComplete="off"
              className="mw-input"
              value={name}
              placeholder={isChannel ? "e.g. announcements" : "e.g. weekend plans"}
              aria-label={isChannel ? "channel name" : "group name"}
              data-autofocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="mw-field">
            <span className="mw-field__label">
              members {isChannel && <span className="mw-field__opt">(optional)</span>}
            </span>
            {members.length > 0 && (
              <div className="mw-chips">
                {members.map((m) => (
                  <span key={m.username} className="mw-chip" data-case="preserve">
                    {m.username}
                    <button
                      type="button"
                      className="mw-chip__x"
                      aria-label={`remove ${m.username}`}
                      onClick={() => removeChip(m.username)}
                    >✕</button>
                  </span>
                ))}
              </div>
            )}
            <div className="mw-row" style={{ flexWrap: "nowrap", gap: "var(--space-2)" }}>
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="mw-input"
                value={memberInput}
                placeholder="add by username…"
                aria-label="add member by username"
                style={{ flex: 1, minWidth: 0 }}
                onChange={(e) => setMemberInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addChip(); } }}
              />
              <button className="mw-btn mw-btn--ghost mw-btn--sm" aria-label="add" onClick={addChip} disabled={!memberInput.trim()}>
                <span className="mw-tlabel">add</span>
                <span className="mw-ticon" aria-hidden="true">+</span>
              </button>
            </div>
          </div>

          <div className="mw-field">
            <span className="mw-field__label">visibility</span>
            <div className="mw-toggle" role="radiogroup" aria-label="visibility">
              <button
                role="radio"
                aria-checked={visibility === "private"}
                className={`mw-toggle__opt${visibility === "private" ? " is-active" : ""}`}
                onClick={() => setVisibility("private")}
              >private</button>
              <button
                role="radio"
                aria-checked={visibility === "public"}
                className={`mw-toggle__opt${visibility === "public" ? " is-active" : ""}`}
                onClick={() => setVisibility("public")}
              >public</button>
            </div>
          </div>

          <label className="mw-field">
            <span className="mw-field__label">
              slug <span className="mw-field__opt">(optional)</span>
            </span>
            <div className="mw-slug">
              <span className="mw-slug__at">/</span>
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="mw-input mw-slug__input"
                value={slug}
                placeholder="url-slug"
                aria-label="slug"
                onChange={(e) => setSlug(slugify(e.target.value))}
              />
              {slugHint}
            </div>
          </label>

          {groupErr && <p className="mw-chat__err">{groupErr}</p>}
          <div className="mw-form__actions">
            <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={onClose}>cancel</button>
            <button
              className="mw-btn mw-btn--primary mw-btn--sm"
              onClick={submitGroup}
              disabled={busy || !name.trim() || (!isChannel && effectiveMembers.length < 1)}
            >
              {busy ? "…" : isChannel ? "create channel" : "create group"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
