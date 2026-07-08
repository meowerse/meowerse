import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import {
  getMembers,
  addMember,
  removeMember,
  setMemberRole,
  leaveChat,
  updateChat,
  slugAvailable,
  slugify,
  getInvite,
  refreshInvite,
  revokeInvite,
  getRequests,
  approveRequest,
  rejectRequest,
  type Member,
  type ChatSummary,
  type JoinRequest,
} from "../lib/chat";

/** Map a server error code to a short inline message shown in the drawer. */
const ERROR_COPY: Record<string, string> = {
  forbidden: "you can't do that",
  not_member: "you can't do that",
  cannot_remove_owner: "can't remove the owner",
  cannot_remove_admin: "only the owner can remove an admin",
  target_not_member: "they're no longer a member",
  already_member: "already a member",
  user_not_found: "no user with that username",
  name_required: "name can't be empty",
  bad_slug: "slug must be 3–32 chars: a–z, 0–9, -",
  slug_taken: "that slug is taken",
  bad_visibility: "bad visibility",
  request_not_found: "that request is no longer pending",
  network: "couldn't reach the server",
};

/** Build the shareable /join link for an invite code (origin-relative in SSR). */
function inviteLink(code: string): string {
  const origin = typeof location !== "undefined" ? location.origin : "";
  return `${origin}/join?invite=${encodeURIComponent(code)}`;
}

const ROLE_RANK: Record<string, number> = { owner: 2, admin: 1, member: 0 };
function atLeast(role: string | undefined, min: "owner" | "admin"): boolean {
  return role != null && (ROLE_RANK[role] ?? -1) >= ROLE_RANK[min];
}

/**
 * The group member-management drawer, opened from the group header. It fetches the
 * live roster and derives the caller's own role from it (by matching `meId`), then
 * gates every action UX-side — the server re-enforces the authz table and answers
 * 403, which we surface as a small inline error (`err`).
 *
 * Actions by role:
 *  - owner: add, promote/demote, remove (anyone but self via leave), rename +
 *    visibility + slug (metadata), leave (transfers ownership server-side).
 *  - admin: add, remove members (not other admins/owner), leave.
 *  - member: leave only.
 *
 * `onChanged` is called after any successful mutation so the parent can refresh the
 * sidebar + its own member map; `onLeft` fires after the caller leaves.
 */
export function MemberDrawer({
  base,
  chat,
  meId,
  online,
  onClose,
  onChanged,
  onLeft,
}: {
  base: string;
  chat: ChatSummary;
  meId: string | null;
  online: Set<string>;
  onClose: () => void;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // per-row action lock

  // Which panel of the drawer is shown: the member roster or the join-requests inbox.
  const [tab, setTab] = useState<"members" | "requests">("members");

  // Add-member state.
  const [addInput, setAddInput] = useState("");
  const [adding, setAdding] = useState(false);
  // When an add targets someone who opted out of direct adds, the server returns an
  // invite code instead of adding them — we surface that link for the actor to share.
  const [inviteNote, setInviteNote] = useState<{ username: string; code: string } | null>(null);

  // Invite-link section state (owner/admin). The code is created on demand when the
  // drawer opens; `inviteBusy` locks the refresh/revoke buttons.
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Pending join requests (owner/admin). Fetched alongside the roster; the count
  // drives the tab badge, and each row has approve/reject actions.
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [reqBusyId, setReqBusyId] = useState<string | null>(null); // per-request action lock

  // Metadata edit state (owner/admin). Seeded from the chat + first roster load.
  // `visibility` is null until the owner picks one — the summary doesn't carry the
  // current value, so we only PATCH it when explicitly chosen (never clobber it).
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(chat.name ?? "");
  const [visibility, setVisibility] = useState<"private" | "public" | null>(null);
  const [slug, setSlug] = useState("");
  const [slugState, setSlugState] = useState<"idle" | "checking" | "ok" | "taken" | "bad">("idle");
  const [savingMeta, setSavingMeta] = useState(false);
  const slugSeq = useRef(0);

  const myRole = members.find((m) => m.userId === meId)?.role;
  const canManage = atLeast(myRole, "admin");
  const isOwner = myRole === "owner";
  // A channel reuses this drawer verbatim — only the noun in the copy differs.
  const noun = chat.type === "channel" ? "channel" : "group";

  const refresh = useCallback(async () => {
    const list = await getMembers(base, chat.id);
    setMembers(list);
    setLoading(false);
    // Derive the caller's role from the fresh roster; only owner/admin pull the
    // request inbox (a plain member gets a 403 → []). Keyed off the list we just
    // fetched so the very first load already gets the pending count for the badge.
    const role = list.find((m) => m.userId === meId)?.role;
    if (role === "owner" || role === "admin") {
      setRequests(await getRequests(base, chat.id));
    }
  }, [base, chat.id, meId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Close the drawer on Escape (a11y — matches the Modal + context-menu behavior).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Create-on-demand the invite code once the caller is known to be owner/admin, so
  // the invite section can show the link immediately (get-or-create is idempotent).
  useEffect(() => {
    if (!canManage || inviteCode) return;
    let cancelled = false;
    (async () => {
      const r = await getInvite(base, chat.id);
      if (!cancelled && r.code) setInviteCode(r.code);
    })();
    return () => { cancelled = true; };
  }, [canManage, inviteCode, base, chat.id]);

  // Live slug availability while editing metadata (same last-write-wins guard as
  // the new-chat modal). Empty slug clears it (allowed).
  useEffect(() => {
    if (!editing) return;
    if (!slug) { setSlugState("idle"); return; }
    if (slug.length < 3 || slug.length > 32) { setSlugState("bad"); return; }
    const seq = ++slugSeq.current;
    setSlugState("checking");
    const t = window.setTimeout(async () => {
      const free = await slugAvailable(base, slug);
      if (seq !== slugSeq.current) return;
      setSlugState(free ? "ok" : "taken");
    }, 350);
    return () => window.clearTimeout(t);
  }, [slug, editing, base]);

  function report(code: string | undefined) {
    setErr(ERROR_COPY[code ?? ""] ?? "something went wrong");
  }

  async function doAdd() {
    const u = addInput.trim().replace(/^@/, "");
    if (!u || adding) return;
    setAdding(true); setErr(null); setInviteNote(null);
    const r = await addMember(base, chat.id, u);
    setAdding(false);
    if (r.error) { report(r.error); return; }
    setAddInput("");
    // Opted-out target: the server didn't add them but handed back an invite code.
    // Surface it so the actor can share the link instead of silently failing.
    if (r.invited && r.inviteCode) { setInviteNote({ username: u, code: r.inviteCode }); return; }
    await refresh();
    onChanged();
  }

  // ---- invite-link actions (owner/admin) ----
  async function doRefreshInvite() {
    if (inviteBusy) return;
    setInviteBusy(true); setErr(null);
    const r = await refreshInvite(base, chat.id);
    setInviteBusy(false);
    if (r.error) { report(r.error); return; }
    if (r.code) { setInviteCode(r.code); setCopied(false); }
  }

  async function doRevokeInvite() {
    if (inviteBusy) return;
    setInviteBusy(true); setErr(null);
    const r = await revokeInvite(base, chat.id);
    setInviteBusy(false);
    if (r.error) { report(r.error); return; }
    setInviteCode(null); setCopied(false);
  }

  function doCopyInvite() {
    if (!inviteCode) return;
    void navigator.clipboard?.writeText(inviteLink(inviteCode)).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); },
      () => report("network"),
    );
  }

  // ---- join-request actions (owner/admin) ----
  async function doApprove(rq: JoinRequest) {
    if (reqBusyId) return;
    setReqBusyId(rq.id); setErr(null);
    const r = await approveRequest(base, chat.id, rq.id);
    setReqBusyId(null);
    if (r.error) { report(r.error); return; }
    await refresh(); // reloads roster (new member) + requests (dropped from pending)
    onChanged();
  }

  async function doReject(rq: JoinRequest) {
    if (reqBusyId) return;
    setReqBusyId(rq.id); setErr(null);
    const r = await rejectRequest(base, chat.id, rq.id);
    setReqBusyId(null);
    if (r.error) { report(r.error); return; }
    await refresh();
  }

  async function doRemove(m: Member) {
    if (busyId) return;
    setBusyId(m.userId); setErr(null);
    const r = await removeMember(base, chat.id, m.userId);
    setBusyId(null);
    if (r.error) { report(r.error); return; }
    await refresh();
    onChanged();
  }

  async function doRole(m: Member, role: "admin" | "member") {
    if (busyId) return;
    setBusyId(m.userId); setErr(null);
    const r = await setMemberRole(base, chat.id, m.userId, role);
    setBusyId(null);
    if (r.error) { report(r.error); return; }
    await refresh();
    onChanged();
  }

  async function doLeave() {
    if (busyId) return;
    setBusyId("__leave"); setErr(null);
    const r = await leaveChat(base, chat.id);
    setBusyId(null);
    if (r.error) { report(r.error); return; }
    onLeft();
  }

  function startEdit() {
    setName(chat.name ?? "");
    // We don't get visibility/slug in the summary; leave the toggle unset and slug
    // blank — saving only sends fields the owner actually changes.
    setVisibility(null);
    setSlug("");
    setSlugState("idle");
    setEditing(true);
    setErr(null);
  }

  async function saveMeta() {
    if (savingMeta) return;
    const trimmed = name.trim();
    if (!trimmed) { report("name_required"); return; }
    if (slug && slugState === "taken") { report("slug_taken"); return; }
    if (slug && slugState === "bad") { report("bad_slug"); return; }
    setSavingMeta(true); setErr(null);
    const patch: { name?: string; visibility?: string; slug?: string | null } = {};
    if (trimmed !== (chat.name ?? "")) patch.name = trimmed;
    if (visibility) patch.visibility = visibility;
    if (slug) patch.slug = slug;
    const r = await updateChat(base, chat.id, patch);
    setSavingMeta(false);
    if (r.error) { report(r.error); return; }
    setEditing(false);
    onChanged();
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
    <div className="mw-drawer" role="dialog" aria-label={`${noun} members`} aria-modal="true">
      <div className="mw-drawer__backdrop" onClick={onClose} />
      <aside className="mw-drawer__panel">
        <header className="mw-drawer__head">
          <h2 className="mw-drawer__title" data-case="preserve">{chat.name ?? noun}</h2>
          <button className="mw-btn mw-btn--ghost mw-btn--sm" aria-label="close" onClick={onClose}>✕</button>
        </header>

        {/* Owner/admin get a Members | Requests switcher; the requests tab carries a
            pending-count badge. A plain member only ever sees the roster (no tabs). */}
        {canManage && (
          <div className="mw-tabs mw-drawer__tabs" role="tablist" aria-label={`${noun} panels`}>
            <button
              role="tab"
              aria-selected={tab === "members"}
              className={`mw-tab${tab === "members" ? " is-active" : ""}`}
              onClick={() => setTab("members")}
            >members</button>
            <button
              role="tab"
              aria-selected={tab === "requests"}
              className={`mw-tab${tab === "requests" ? " is-active" : ""}`}
              onClick={() => setTab("requests")}
            >
              requests
              {requests.length > 0 && <span className="mw-tab__badge">{requests.length}</span>}
            </button>
          </div>
        )}

        {err && <p className="mw-drawer__err" role="alert">{err}</p>}

        {tab === "requests" ? (
          <div className="mw-drawer__list">
            {requests.length === 0 ? (
              <p className="mw-muted" style={{ padding: "var(--space-3) var(--space-4)" }}>no pending requests.</p>
            ) : (
              requests.map((rq) => {
                const label = rq.displayName || rq.username;
                const rowBusy = reqBusyId === rq.id;
                return (
                  <div key={rq.id} className="mw-mrow">
                    <span className="mw-mrow__avatar">
                      <Avatar url={rq.avatarUrl} name={label} size="sm" />
                    </span>
                    <span className="mw-mrow__body">
                      <span className="mw-mrow__name" data-case="preserve">{label}</span>
                      <span className="mw-mrow__req">wants to join</span>
                    </span>
                    <span className="mw-mrow__actions">
                      <button
                        className="mw-btn mw-btn--primary mw-btn--sm"
                        onClick={() => doApprove(rq)}
                        disabled={rowBusy}
                      >{rowBusy ? "…" : "approve"}</button>
                      <button
                        className="mw-btn mw-btn--ghost mw-btn--sm mw-mrow__danger"
                        onClick={() => doReject(rq)}
                        disabled={rowBusy}
                      >reject</button>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <>
        {canManage && !editing && (
          <div className="mw-drawer__section">
            <div className="mw-row" style={{ flexWrap: "nowrap", gap: "var(--space-2)" }}>
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="mw-input"
                value={addInput}
                placeholder="add member by username…"
                aria-label="add member by username"
                style={{ flex: 1, minWidth: 0 }}
                onChange={(e) => setAddInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void doAdd(); } }}
              />
              <button className="mw-btn mw-btn--primary mw-btn--sm" onClick={doAdd} disabled={adding || !addInput.trim()}>
                {adding ? "…" : "add"}
              </button>
            </div>
            {inviteNote && (
              // The target opted out of direct adds — share this invite link instead.
              <div className="mw-note mw-note--info mw-invitenote" role="status">
                <p style={{ margin: 0 }}>
                  <strong data-case="preserve">{inviteNote.username}</strong> has opted out of direct adds — send them this invite link:
                </p>
                <div className="mw-invite__link">
                  <input className="mw-input mw-invite__field" readOnly value={inviteLink(inviteNote.code)} aria-label="invite link" onFocus={(e) => e.currentTarget.select()} />
                  <button
                    className="mw-btn mw-btn--secondary mw-btn--sm"
                    onClick={() => void navigator.clipboard?.writeText(inviteLink(inviteNote.code))}
                  >copy</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Invite-link section (owner/admin): the shareable /join?invite=<code> link
            + copy / refresh (rotate) / revoke. Created on demand when the drawer opens. */}
        {canManage && !editing && (
          <div className="mw-drawer__section mw-invite">
            <span className="mw-field__label">invite link</span>
            {inviteCode ? (
              <>
                <div className="mw-invite__link">
                  <input
                    className="mw-input mw-invite__field"
                    readOnly
                    value={inviteLink(inviteCode)}
                    aria-label="invite link"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button className="mw-btn mw-btn--primary mw-btn--sm" onClick={doCopyInvite}>
                    {copied ? "copied" : "copy"}
                  </button>
                </div>
                <div className="mw-invite__actions">
                  <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={doRefreshInvite} disabled={inviteBusy}>refresh</button>
                  <button className="mw-btn mw-btn--ghost mw-btn--sm mw-mrow__danger" onClick={doRevokeInvite} disabled={inviteBusy}>revoke</button>
                </div>
                <p className="mw-invite__hint mw-muted">anyone with this link can join directly.</p>
              </>
            ) : (
              <button className="mw-btn mw-btn--secondary mw-btn--sm" onClick={doRefreshInvite} disabled={inviteBusy}>
                {inviteBusy ? "…" : "create invite link"}
              </button>
            )}
          </div>
        )}

        <div className="mw-drawer__list">
          {loading && <p className="mw-muted" style={{ padding: "var(--space-3)" }}>loading members…</p>}
          {!loading && members.map((m) => {
            const isMe = m.userId === meId;
            const label = m.displayName || m.username;
            const isOnline = online.has(m.userId);
            const rowBusy = busyId === m.userId;
            // Owner can act on anyone but self; admin can remove members (server
            // rejects removing owner/other admins → surfaced as an inline error).
            const canRemove = !isMe && m.role !== "owner" && canManage;
            const canPromote = isOwner && !isMe && m.role === "member";
            const canDemote = isOwner && !isMe && m.role === "admin";
            return (
              <div key={m.userId} className="mw-mrow">
                <span className="mw-mrow__avatar">
                  <Avatar url={m.avatarUrl} name={label} size="sm" />
                  {isOnline && <span className="mw-dot mw-dot--on" aria-label="online" />}
                </span>
                <span className="mw-mrow__body">
                  <span className="mw-mrow__name" data-case="preserve">
                    {label}{isMe && <span className="mw-mrow__you"> (you)</span>}
                  </span>
                  <span className={`mw-rolebadge mw-rolebadge--${m.role}`}>{m.role}</span>
                </span>
                {(canPromote || canDemote || canRemove) && (
                  <span className="mw-mrow__actions">
                    {canPromote && (
                      <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={() => doRole(m, "admin")} disabled={rowBusy}>
                        promote
                      </button>
                    )}
                    {canDemote && (
                      <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={() => doRole(m, "member")} disabled={rowBusy}>
                        demote
                      </button>
                    )}
                    {canRemove && (
                      <button className="mw-btn mw-btn--ghost mw-btn--sm mw-mrow__danger" onClick={() => doRemove(m)} disabled={rowBusy}>
                        remove
                      </button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {isOwner && (
          <div className="mw-drawer__section mw-drawer__meta">
            {!editing ? (
              <button className="mw-btn mw-btn--secondary mw-btn--sm" onClick={startEdit}>{noun} settings</button>
            ) : (
              <div className="mw-form">
                <label className="mw-field">
                  <span className="mw-field__label">name</span>
                  <input
                    type="text"
                    autoComplete="off"
                    className="mw-input"
                    value={name}
                    aria-label={`${noun} name`}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
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
                  <span className="mw-field__label">slug <span className="mw-field__opt">(optional)</span></span>
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
                <div className="mw-form__actions">
                  <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={() => { setEditing(false); setErr(null); }}>cancel</button>
                  <button className="mw-btn mw-btn--primary mw-btn--sm" onClick={saveMeta} disabled={savingMeta || !name.trim()}>
                    {savingMeta ? "…" : "save"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
          </>
        )}

        <footer className="mw-drawer__foot">
          <button
            className="mw-btn mw-btn--ghost mw-btn--sm mw-mrow__danger"
            onClick={doLeave}
            disabled={busyId === "__leave"}
          >
            {busyId === "__leave" ? "…" : `leave ${noun}`}
          </button>
        </footer>
      </aside>
    </div>
  );
}
