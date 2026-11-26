// Chat-list fetch coordinator: ONE gate for every listChats call. Soft callers (poll, tab
// resume) are single-flight and rate-limited; forced callers (unknown-chat delta, revoked,
// invalidate, reconnect, user actions) always reach the server but never overlap: while one
// is in flight they collapse into ONE trailing fetch (quiet only if every requester was quiet;
// dropped if the account scope changed, or the gate was disposed, before it could start).
import { getEpoch } from "./scope";

export const LIST_MIN_GAP_MS = 10_000;
export const RESUME_DEBOUNCE_MS = 250;

type Trailing<T> = { quiet: boolean; epoch: number; resolve: (r: T | null) => void; p: Promise<T | null> };

export function createListGate<T>(run: (quiet: boolean) => Promise<T | null>, opts: { gap?: number; now?: () => number } = {}) {
  const gap = opts.gap ?? LIST_MIN_GAP_MS;
  const now = opts.now ?? (() => Date.now());
  let last = now(); // the boot list counts as the first fetch
  let inflight: Promise<T | null> | null = null;
  let trailing: Trailing<T> | null = null;
  const cancelTrailing = () => { trailing?.resolve(null); trailing = null; };
  const start = (quiet: boolean): Promise<T | null> => {
    last = now();
    const p: Promise<T | null> = run(quiet).catch(() => null).then((r) => {
      // Clear inflight and consume the trailing fetch in ONE synchronous step: a request can
      // never land between the two and be lost.
      inflight = null;
      const t = trailing;
      trailing = null;
      if (t) { if (t.epoch === getEpoch()) void start(t.quiet).then(t.resolve); else t.resolve(null); }
      return r;
    });
    inflight = p;
    return p;
  };
  function request(kind: "soft" | "force", quiet = false): Promise<T | null> {
    if (trailing && trailing.epoch !== getEpoch()) cancelTrailing(); // queued under another account
    if (inflight) {
      if (kind === "soft") return inflight;
      if (!trailing) {
        let resolve!: (r: T | null) => void;
        const p = new Promise<T | null>((r) => { resolve = r; });
        trailing = { quiet, epoch: getEpoch(), resolve, p };
      } else trailing.quiet = trailing.quiet && quiet;
      return trailing.p;
    }
    if (kind === "soft" && now() - last < gap) return Promise.resolve(null);
    return start(quiet);
  }
  /** Unmount / base change: drop the queued trailing fetch. */
  return { request, dispose: cancelTrailing };
}

/** Merge focus + visibilitychange into one debounced "resume" (visible only; hiding cancels it). Returns cleanup. */
export function watchResume(cb: () => void, ms = RESUME_DEBOUNCE_MS): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (t != null) { clearTimeout(t); t = null; } };
  const fire = () => {
    clear();
    if (document.visibilityState !== "visible") return;
    t = setTimeout(() => { t = null; cb(); }, ms);
  };
  window.addEventListener("focus", fire);
  document.addEventListener("visibilitychange", fire);
  return () => {
    clear();
    window.removeEventListener("focus", fire);
    document.removeEventListener("visibilitychange", fire);
  };
}
