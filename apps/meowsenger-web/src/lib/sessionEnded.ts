// App-level "session ended" signal. Any authenticated read that gets a definitive
// 401 raises it; AppShell listens, swaps the app for a "session ended" banner (no
// auto-redirect) and so drops all in-memory chat content. Transient failures
// (network, timeout, 5xx) never raise it.
//
// In-memory only: at the moment the session ends, the mounted chat view is asked for
// a snapshot of the ACTIVE composer's unsent text + whether any send was still
// un-acked, so the banner can hand the draft back. It is never written to
// localStorage/sessionStorage/IndexedDB, and it holds no other chat content.
type Listener = () => void;
export interface EndedSnapshot { draft: string; pendingSend: boolean }
const listeners = new Set<Listener>();
let ended = false;
let source: (() => EndedSnapshot) | null = null;
let snapshot: EndedSnapshot | null = null;

/** The chat view registers how to read its draft/pending state (null to unregister). */
export function setSnapshotSource(fn: (() => EndedSnapshot) | null): void { source = fn; }

export function getEndedSnapshot(): EndedSnapshot | null { return snapshot; }

export function notifySessionEnded(): void {
  if (ended) return;
  ended = true;
  try { snapshot = source ? source() : null; } catch { snapshot = null; }
  for (const l of [...listeners]) l();
}

export function hasSessionEnded(): boolean { return ended; }

export function subscribeSessionEnded(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Test/sign-in reset. */
export function resetSessionEnded(): void { ended = false; snapshot = null; }
