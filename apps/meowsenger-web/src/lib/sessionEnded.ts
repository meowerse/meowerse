// App-level "session ended" signal. Any authenticated read that gets a definitive
// 401 raises it; AppShell listens, swaps the app for a "session ended" banner (no
// auto-redirect) and so drops all in-memory chat content. Transient failures
// (network, timeout, 5xx) never raise it.
type Listener = () => void;
const listeners = new Set<Listener>();
let ended = false;

export function notifySessionEnded(): void {
  if (ended) return;
  ended = true;
  for (const l of [...listeners]) l();
}

export function hasSessionEnded(): boolean { return ended; }

export function subscribeSessionEnded(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Test/sign-in reset. */
export function resetSessionEnded(): void { ended = false; }
