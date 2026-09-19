import { useEffect, useState } from "react";
import { Icon, Spinner } from "@meowerse/ui";
import {
  getBySlug,
  joinChat,
  getInviteByCode,
  acceptInvite,
  requestJoin,
  type ChatPreview,
  type InvitePreview,
} from "../lib/chat";
import { getSession, loginUrl } from "../lib/meowsengerApi";

/**
 * The public-discovery island rendered by /join. It reads the target from the URL
 * query so nothing sensitive is server-rendered, then fetches client-side. Two
 * link shapes:
 *  - `?g=<slug>` / `?c=<slug>` — a discoverable group/channel, resolved via
 *    `getBySlug`. Public → open-join; private+slug → request access (Slice 7).
 *  - `?invite=<code>` — a 12-char invite code, resolved via `getInviteByCode`.
 *    Accepting bypasses the visibility gate (Slice 7).
 * This is the static-safe shape: /join is a real generated file the host always
 * serves; the target lives only in the query the client reads.
 *
 * States:
 *  - not signed in              → redirect to login (round-trips back to this page).
 *  - loading                    → spinner.
 *  - locked                     → a "private or not found" lock card (no leak).
 *  - preview (slug)             → preview card + Join/Subscribe, OR (private+slug)
 *                                 Request access / "requested — waiting" / auto-open.
 *  - invite (code)              → preview card + Accept invite (direct join).
 *  - isMember / approved        → straight into /app?chat=<id>.
 */

/** Read the target from the query: an invite code, or a slug + kind. */
function readTarget():
  | { mode: "invite"; code: string }
  | { mode: "slug"; slug: string; kind: "channel" | "group" }
  | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const invite = q.get("invite");
  if (invite) return { mode: "invite", code: invite };
  const c = q.get("c");
  if (c) return { mode: "slug", slug: c, kind: "channel" };
  const g = q.get("g");
  if (g) return { mode: "slug", slug: g, kind: "group" };
  return null;
}

/** Navigate into the app with a chat pre-opened (Chat.tsx reads ?chat=). */
function openInApp(chatId: string) {
  window.location.assign(`/app?chat=${encodeURIComponent(chatId)}`);
}

type State =
  | { kind: "loading" }
  | { kind: "locked" } // private / not found / bad link / dead invite
  | { kind: "preview"; preview: ChatPreview }
  // `code` is the original invite code — the accept route is keyed on the CODE
  // (POST /api/invite/:code/accept), not the previewed chat id.
  | { kind: "invite"; preview: InvitePreview; code: string };

export default function ChannelPreview({ base }: { base: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [joining, setJoining] = useState(false);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  // The kind from the link (channel|group) — used for the Join/Subscribe copy
  // even before the preview loads. The preview's own `type` takes precedence once
  // it arrives (the link key is just a hint).
  const [linkKind, setLinkKind] = useState<"channel" | "group">("group");
  // The caller's own request status for a private+slug chat (drives the
  // "request access" / "requested — waiting for approval" button state).
  const [requestStatus, setRequestStatus] = useState<"none" | "pending" | "approved" | "rejected">("none");

  useEffect(() => {
    let cancelled = false;
    const target = readTarget();
    if (!target) { setState({ kind: "locked" }); return; }
    if (target.mode === "slug") setLinkKind(target.kind);
    (async () => {
      // Gate on a session first — discovery is behind the BFF. Unauthenticated
      // callers bounce to login and return here (query preserved in the URL).
      const s = await getSession(base);
      if (cancelled) return;
      if (!s.authenticated) { window.location.replace(loginUrl(base)); return; }
      if (target.mode === "invite") {
        const inv = await getInviteByCode(base, target.code);
        if (cancelled) return;
        if ("error" in inv) { setState({ kind: "locked" }); return; }
        setState({ kind: "invite", preview: inv, code: target.code });
        return;
      }
      const r = await getBySlug(base, target.slug);
      if (cancelled) return;
      if ("error" in r) { setState({ kind: "locked" }); return; }
      // Already a member → skip the preview and go straight into the chat.
      if (r.isMember) { openInApp(r.id); return; }
      // Private+slug with a prior approval → the request was accepted; auto-open.
      if (r.requestStatus === "approved") { openInApp(r.id); return; }
      if (r.requestStatus) setRequestStatus(r.requestStatus);
      setState({ kind: "preview", preview: r });
    })();
    return () => { cancelled = true; };
  }, [base]);

  async function onJoin(preview: ChatPreview) {
    if (joining) return;
    setJoining(true); setJoinErr(null);
    const r = await joinChat(base, preview.id);
    if (r.error || !r.ok) {
      setJoining(false);
      setJoinErr(r.error === "must_request" ? "this chat is invite-only" : "couldn't join — try again");
      return;
    }
    // Joined (or already a member) → open the chat in the app.
    openInApp(preview.id);
  }

  // Accept an invite code → join directly (bypasses visibility) → open the chat.
  // Keyed on the CODE (the accept route is /api/invite/:code/accept).
  async function onAcceptInvite(code: string) {
    if (joining) return;
    setJoining(true); setJoinErr(null);
    const r = await acceptInvite(base, code);
    if (r.error || !r.chatId) {
      setJoining(false);
      setJoinErr(r.error === "bad_invite" ? "this invite link is no longer valid" : "couldn't join — try again");
      return;
    }
    openInApp(r.chatId);
  }

  // Request access to a private+slug chat → flip to the "requested" pending state.
  async function onRequest(preview: ChatPreview) {
    if (joining) return;
    setJoining(true); setJoinErr(null);
    const r = await requestJoin(base, preview.id);
    setJoining(false);
    if (r.error || !r.ok) {
      setJoinErr(r.error === "already_member" ? "you're already a member" : "couldn't send the request — try again");
      return;
    }
    setRequestStatus("pending");
  }

  if (state.kind === "loading") {
    return (
      <div className="mw-discover">
        <div className="mw-discover__card mw-discover__card--loading">
          <Spinner size="lg" label="loading chat" />
          <p className="mw-muted">loading…</p>
        </div>
      </div>
    );
  }

  if (state.kind === "locked") {
    return (
      <div className="mw-discover">
        <div className="mw-discover__card mw-discover__card--lock">
          <span className="mw-discover__lockglyph" aria-hidden="true">🔒</span>
          <h1 className="mw-discover__title">private or not found</h1>
          <p className="mw-muted">
            this chat is private, or the link is wrong. ask an admin for an invite.
          </p>
          <a className="mw-btn mw-btn--secondary mw-btn--md" href="/app">go to meowsenger</a>
        </div>
      </div>
    );
  }

  // Invite-code card: a valid code lets its holder join directly (bypasses private).
  if (state.kind === "invite") {
    const inv = state.preview;
    const isChannel = inv.type === "channel";
    const count = inv.memberCount;
    return (
      <div className="mw-discover">
        <div className="mw-discover__card">
          <span
            className={`mw-avatar mw-avatar--lg mw-groupavatar mw-discover__avatar${isChannel ? " mw-groupavatar--channel" : ""}`}
            aria-hidden="true"
          >
            <span className="mono" data-case="preserve">{(inv.name?.[0] ?? "#").toUpperCase()}</span>
          </span>
          <span className={`mw-typebadge mw-typebadge--${isChannel ? "channel" : "group"}`}>
            <Icon name={isChannel ? "broadcast" : "users"} size={13} />
            <span>{isChannel ? "channel" : "group"}</span>
          </span>
          <h1 className="mw-discover__title" data-case="preserve">{inv.name ?? (isChannel ? "channel" : "group")}</h1>
          <p className="mw-muted">
            {count} member{count === 1 ? "" : "s"} · you've been invited
          </p>
          {joinErr && <p className="mw-chat__err" role="alert">{joinErr}</p>}
          <div className="mw-discover__actions">
            <button
              className="mw-btn mw-btn--primary mw-btn--md"
              onClick={() => onAcceptInvite(state.code)}
              disabled={joining}
            >
              {joining ? "…" : "accept invite"}
            </button>
            <a className="mw-btn mw-btn--ghost mw-btn--md" href="/app">not now</a>
          </div>
        </div>
      </div>
    );
  }

  const { preview } = state;
  const isChannel = preview.type === "channel" || (preview.type !== "group" && linkKind === "channel");
  const count = preview.memberCount;
  // A private+slug chat viewed by a non-member is "discoverable but gated": no
  // open-join, only a request-to-join flow (approve/reject by an owner/admin).
  const gated = preview.canRequest === true;
  const cta = isChannel ? "subscribe" : "join";

  return (
    <div className="mw-discover">
      <div className="mw-discover__card">
        <span
          className={`mw-avatar mw-avatar--lg mw-groupavatar mw-discover__avatar${isChannel ? " mw-groupavatar--channel" : ""}`}
          aria-hidden="true"
        >
          <span className="mono" data-case="preserve">{(preview.name?.[0] ?? "#").toUpperCase()}</span>
        </span>
        <span className={`mw-typebadge mw-typebadge--${isChannel ? "channel" : "group"}`}>
          <Icon name={isChannel ? "broadcast" : "users"} size={13} />
          <span>{isChannel ? "channel" : "group"}</span>
        </span>
        <h1 className="mw-discover__title" data-case="preserve">{preview.name ?? (isChannel ? "channel" : "group")}</h1>
        <p className="mw-muted">
          {count} member{count === 1 ? "" : "s"}
          {gated ? " · private — request to join" : isChannel ? " · broadcast — only admins post" : ""}
        </p>
        {joinErr && <p className="mw-chat__err" role="alert">{joinErr}</p>}
        <div className="mw-discover__actions">
          {gated ? (
            requestStatus === "pending" ? (
              <button className="mw-btn mw-btn--secondary mw-btn--md" disabled>
                requested — waiting for approval
              </button>
            ) : (
              <button
                className="mw-btn mw-btn--primary mw-btn--md"
                onClick={() => onRequest(preview)}
                disabled={joining}
              >
                {joining ? "…" : requestStatus === "rejected" ? "request again" : "request access"}
              </button>
            )
          ) : (
            <button
              className="mw-btn mw-btn--primary mw-btn--md"
              onClick={() => onJoin(preview)}
              disabled={joining}
            >
              {joining ? "…" : cta}
            </button>
          )}
          <a className="mw-btn mw-btn--ghost mw-btn--md" href="/app">not now</a>
        </div>
      </div>
    </div>
  );
}
