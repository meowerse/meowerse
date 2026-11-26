// Chat-list fetch coordinator: ONE gate for every listChats call. Soft callers (poll, tab
// resume) are single-flight and rate-limited; forced callers (unknown-chat delta, revoked,
// invalidate, reconnect, user actions) always reach the server but never overlap: while one
// is in flight they collapse into ONE trailing fetch.

export const LIST_MIN_GAP_MS = 10_000;
export const RESUME_DEBOUNCE_MS = 250;

export function createListGate<T>(run: () => Promise<T | null>, opts: { gap?: number; now?: () => number } = {}) {
  const gap = opts.gap ?? LIST_MIN_GAP_MS;
  const now = opts.now ?? Date.now;
  let last = now(); // the boot list counts as the first fetch
  let inflight: Promise<T | null> | null = null;
  let trailing = false;
  const start = (): Promise<T | null> => {
    last = now();
    const p: Promise<T | null> = run().catch(() => null).then(async (r) => {
      if (trailing) { trailing = false; inflight = null; return request("force"); }
      return r;
    }).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  };
  function request(kind: "soft" | "force"): Promise<T | null> {
    if (inflight) {
      if (kind === "force") trailing = true;
      return inflight;
    }
    if (kind === "soft" && now() - last < gap) return Promise.resolve(null);
    return start();
  }
  return request;
}

/** Merge focus + visibilitychange into one debounced "resume" (visible only). Returns cleanup. */
export function watchResume(cb: () => void, ms = RESUME_DEBOUNCE_MS): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (document.visibilityState !== "visible") return;
    if (t != null) clearTimeout(t);
    t = setTimeout(() => { t = null; cb(); }, ms);
  };
  window.addEventListener("focus", fire);
  document.addEventListener("visibilitychange", fire);
  return () => {
    if (t != null) clearTimeout(t);
    window.removeEventListener("focus", fire);
    document.removeEventListener("visibilitychange", fire);
  };
}
