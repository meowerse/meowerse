import { useCallback, useEffect, useState } from "react";
import { request } from "./request";

export type SessionError = "network" | "timeout" | "server";
export type Session =
  | { loading: true; authenticated: false }
  | { loading: false; authenticated: false; error?: undefined }
  | { loading: false; authenticated: false; error: SessionError }
  | { loading: false; authenticated: true; username: string; verified: boolean };

type Resolved = Exclude<Session, { loading: true }>;
type Known = Exclude<Resolved, { error: SessionError }>;

const CACHE_KEY = "mw-session";
const TTL = 15_000;
export const SESSION_TIMEOUT_MS = 8_000;
const LOADING: Session = { loading: true, authenticated: false };

let inflight: Promise<Resolved> | null = null;
// Every mounted useSession instance subscribes here (in its effect) and
// unsubscribes on cleanup, so a resolved load — success, signed-out, error —
// and a retry's loading state reach every island sharing the cache/inflight
// fetch, not just the one that triggered it. Widened to `Session` (rather than
// just `Resolved`) so the retry's loading broadcast rides the same channel.
const subscribers = new Set<(d: Session) => void>();

function broadcast(data: Session): void {
  subscribers.forEach((fn) => fn(data));
}

function readCache(): Known | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as { at: number; data: Known };
    if (Date.now() - c.at > TTL) return null;
    return c.data;
  } catch {
    return null;
  }
}

function writeCache(data: Known): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* private mode / SSR — cache is best-effort */
  }
}

/** Drop the cached session — call after login, signup, or sign out. */
export function clearSessionCache(): void {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* private mode / SSR: best-effort */ }
  inflight = null;
}

// A back/forward-cache restore may show a page from before a sign-in or sign-out: re-check.
// Guarded by a realm-level flag so re-evaluating this module (duplicate bundling, HMR) never
// registers the listener twice.
const realm = globalThis as typeof globalThis & { __mwSessionPageshow?: boolean };
if (typeof window !== "undefined" && !realm.__mwSessionPageshow) {
  realm.__mwSessionPageshow = true;
  window.addEventListener("pageshow", (e) => { if ((e as PageTransitionEvent).persisted) clearSessionCache(); });
}

async function loadSession(base: string): Promise<Resolved> {
  const r = await request<{ authenticated?: boolean; username?: string; verified?: boolean }>(
    `${base}/api/session`, { timeoutMs: SESSION_TIMEOUT_MS });
  if (!r.ok) {
    if (r.error.kind === "unauthorized") { const d: Known = { loading: false, authenticated: false }; writeCache(d); return d; }
    const error: SessionError = r.error.kind === "timeout" ? "timeout" : r.error.kind === "network" ? "network" : "server";
    return { loading: false, authenticated: false, error };   // never cached
  }
  const j = r.data;
  const data: Known = j?.authenticated && j.username
    ? { loading: false, authenticated: true, username: j.username, verified: !!j.verified }
    : { loading: false, authenticated: false };
  writeCache(data);
  return data;
}

/** Start (or join) the one shared load, and broadcast its result to every subscriber. */
function runLoad(base: string): void {
  if (inflight) return; // a load is already in flight — its resolution will broadcast to us too
  const p = loadSession(base);
  inflight = p;
  // Identity-check `p` against `inflight` before acting: a retry started while `p`
  // is still pending replaces `inflight` with a newer promise. Without this check,
  // `p` resolving later (even after the newer load has already broadcast) would
  // still broadcast its stale result and null out the newer `inflight`, breaking
  // its own dedupe guard and letting a third load start early.
  p.then((data) => { if (inflight === p) broadcast(data); })
    .finally(() => { if (inflight === p) inflight = null; });
}

/**
 * Session for the header + guards. Reads a short-lived sessionStorage cache
 * synchronously (instant, no spinner on repeat navigations) and dedupes the
 * network call across every island on the page (one fetch, not one per island).
 * Every mounted instance subscribes to the shared load, so a retry triggered by
 * one island (e.g. AuthGate) heals every other island sharing the page (e.g. a
 * header) too, instead of leaving them stuck on the stale error.
 */
export function useSession(base: string): Session & { retry: () => void } {
  // ALWAYS start in `loading` so the server render and the first client render
  // are identical. Reading sessionStorage in the initializer would make the
  // client's first render diverge from the server's (which has no sessionStorage)
  // → a hydration mismatch. In an SSR'd island that mismatch made React reuse the
  // AuthGate loader div (`.mw-gate`, display:flex) for the gated content, laying
  // the account cards out in a ROW. Apply the cache in the effect instead (one
  // extra render tick — negligible, and still no network when cached).
  const [s, setS] = useState<Session>(LOADING);

  useEffect(() => {
    subscribers.add(setS);
    const cached = readCache();
    if (cached) {
      setS(cached);
    } else {
      runLoad(base);
    }
    return () => { subscribers.delete(setS); };
  }, [base]);

  const retry = useCallback(() => {
    clearSessionCache();
    broadcast(LOADING); // siblings show loading too, not just this island
    runLoad(base);
  }, [base]);

  return Object.assign({}, s, { retry });
}
