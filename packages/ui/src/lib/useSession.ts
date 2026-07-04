import { useEffect, useState } from "react";

export type Session =
  | { loading: true; authenticated: false }
  | { loading: false; authenticated: false }
  | { loading: false; authenticated: true; username: string; verified: boolean };

type Resolved = Exclude<Session, { loading: true }>;

const CACHE_KEY = "mw-session";
const TTL = 15_000;
let inflight: Promise<Resolved> | null = null;

function readCache(): Resolved | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as { at: number; data: Resolved };
    if (Date.now() - c.at > TTL) return null;
    return c.data;
  } catch {
    return null;
  }
}

function writeCache(data: Resolved): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* private mode / SSR — cache is best-effort */
  }
}

/** Drop the cached session — call after login, signup, or sign out. */
export function clearSessionCache(): void {
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
  inflight = null;
}

async function loadSession(base: string): Promise<Resolved> {
  try {
    const res = await fetch(`${base}/api/session`, { credentials: "include" });
    const j = (await res.json()) as { authenticated?: boolean; username?: string; verified?: boolean };
    const data: Resolved =
      j.authenticated && j.username
        ? { loading: false, authenticated: true, username: j.username, verified: !!j.verified }
        : { loading: false, authenticated: false };
    writeCache(data);
    return data;
  } catch {
    return { loading: false, authenticated: false };
  }
}

/**
 * Session for the header + guards. Reads a short-lived sessionStorage cache
 * synchronously (instant, no spinner on repeat navigations) and dedupes the
 * network call across every island on the page (one fetch, not one per island).
 */
export function useSession(base: string): Session {
  // ALWAYS start in `loading` so the server render and the first client render
  // are identical. Reading sessionStorage in the initializer would make the
  // client's first render diverge from the server's (which has no sessionStorage)
  // → a hydration mismatch. In an SSR'd island that mismatch made React reuse the
  // AuthGate loader div (`.mw-gate`, display:flex) for the gated content, laying
  // the account cards out in a ROW. Apply the cache in the effect instead (one
  // extra render tick — negligible, and still no network when cached).
  const [s, setS] = useState<Session>({ loading: true, authenticated: false });

  useEffect(() => {
    const cached = readCache();
    if (cached) {
      setS(cached);
      return;
    }
    let live = true;
    inflight ??= loadSession(base);
    inflight
      .then((data) => {
        if (live) setS(data);
      })
      .finally(() => {
        inflight = null;
      });
    return () => {
      live = false;
    };
  }, [base]);

  return s;
}
