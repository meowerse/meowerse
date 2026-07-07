import { useEffect, useState } from "react";
import { Spinner } from "@meowerse/ui";
import { getBySlug, joinChat, type ChatPreview } from "../lib/chat";
import { getSession, loginUrl } from "../lib/meowsengerApi";

/**
 * The public-discovery island rendered by /join. It reads the target slug from the
 * URL query (`?g=<slug>` for a group, `?c=<slug>` for a channel — set by the
 * shareable link) so nothing sensitive is server-rendered, then fetches
 * `getBySlug` client-side. This is the static-safe shape: /join is a real
 * generated file that any static host serves, and the slug lives only in the query
 * the client reads — Astro never has to prerender a per-slug page.
 *
 * States:
 *  - not signed in            → redirect to login (round-trips back to this page).
 *  - loading                  → spinner.
 *  - {error:"private"}/unknown → a "private or not found" lock card (no leak).
 *  - public + isMember:false  → preview card + Join (group) / Subscribe (channel).
 *  - isMember:true            → straight into /app?chat=<id> (already a member).
 * After a successful join we navigate to /app?chat=<id> so Chat opens that chat.
 */

/** Read the target slug + kind from the query. `?c=` = channel, `?g=` = group. */
function readTarget(): { slug: string; kind: "channel" | "group" } | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const c = q.get("c");
  if (c) return { slug: c, kind: "channel" };
  const g = q.get("g");
  if (g) return { slug: g, kind: "group" };
  return null;
}

/** Navigate into the app with a chat pre-opened (Chat.tsx reads ?chat=). */
function openInApp(chatId: string) {
  window.location.assign(`/app?chat=${encodeURIComponent(chatId)}`);
}

type State =
  | { kind: "loading" }
  | { kind: "locked" } // private / not found / bad link
  | { kind: "preview"; preview: ChatPreview };

export default function ChannelPreview({ base }: { base: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [joining, setJoining] = useState(false);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  // The kind from the link (channel|group) — used for the Join/Subscribe copy
  // even before the preview loads. The preview's own `type` takes precedence once
  // it arrives (the link key is just a hint).
  const [linkKind, setLinkKind] = useState<"channel" | "group">("group");

  useEffect(() => {
    let cancelled = false;
    const target = readTarget();
    if (!target) { setState({ kind: "locked" }); return; }
    setLinkKind(target.kind);
    (async () => {
      // Gate on a session first — discovery is behind the BFF. Unauthenticated
      // callers bounce to login and return here (?g=/?c= preserved in the URL).
      const s = await getSession(base);
      if (cancelled) return;
      if (!s.authenticated) { window.location.replace(loginUrl(base)); return; }
      const r = await getBySlug(base, target.slug);
      if (cancelled) return;
      if ("error" in r) { setState({ kind: "locked" }); return; }
      // Already a member → skip the preview and go straight into the chat.
      if (r.isMember) { openInApp(r.id); return; }
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

  const { preview } = state;
  const isChannel = preview.type === "channel" || (preview.type !== "group" && linkKind === "channel");
  const cta = isChannel ? "subscribe" : "join";
  const count = preview.memberCount;

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
          {isChannel ? "📡 channel" : "👥 group"}
        </span>
        <h1 className="mw-discover__title" data-case="preserve">{preview.name ?? (isChannel ? "channel" : "group")}</h1>
        <p className="mw-muted">
          {count} member{count === 1 ? "" : "s"}
          {isChannel ? " · broadcast — only admins post" : ""}
        </p>
        {joinErr && <p className="mw-chat__err" role="alert">{joinErr}</p>}
        <div className="mw-discover__actions">
          <button
            className="mw-btn mw-btn--primary mw-btn--md"
            onClick={() => onJoin(preview)}
            disabled={joining}
          >
            {joining ? "…" : cta}
          </button>
          <a className="mw-btn mw-btn--ghost mw-btn--md" href="/app">not now</a>
        </div>
      </div>
    </div>
  );
}
