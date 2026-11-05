// Account scope + lifecycle for the in-memory store. MEMORY ONLY: nothing here (or in
// any sibling file) may persist chat data. Tab close equals wipe.
//
// Contract: every store write that follows async work takes a token from `begin()`
// and is dropped unless `isCurrent(token.epoch)`. `clearAll()` is the single wipe.
import { useSyncExternalStore } from "react";

type Listener = () => void;

let scope: string | null = null;
let epoch = 0;
const controllers = new Set<AbortController>();
const resets = new Set<() => void>();
const listeners = new Set<Listener>();

export interface Token { epoch: number; signal: AbortSignal; done: () => void }

export function getScope(): string | null { return scope; }
export function getEpoch(): number { return epoch; }

/** Caches register a reset fn that drops all their data (run by clearAll). */
export function registerCache(reset: () => void): () => void {
  resets.add(reset);
  return () => { resets.delete(reset); };
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Caches call this after a mutation so useSyncExternalStore readers re-check. */
export function notify(): void {
  for (const l of [...listeners]) l();
}

/** True while `e` is the live epoch AND a scope is set (no scope => nothing may be stored). */
export function isCurrent(e: number): boolean {
  return e === epoch && scope !== null;
}

/** Start async work: registers an AbortController that clearAll() aborts. */
export function begin(): Token {
  const c = new AbortController();
  const e = epoch;
  if (scope === null) c.abort(); // no signed-in scope: the work is dead on arrival
  else controllers.add(c);
  return { epoch: e, signal: c.signal, done: () => { controllers.delete(c); } };
}

/** Bind the store to a user. A different non-null scope wipes first, so data left over
 *  from user A can never be read under user B, whichever trigger was missed. */
export function setScope(userId: string): void {
  if (scope === userId) return;
  if (scope !== null) clearAll();
  // Any binding change (including null -> user) starts a new epoch, so a token taken
  // while unbound (or under the previous user) can never become current again.
  epoch++;
  scope = userId;
}

/** The wipe. Order matters: abort in-flight, bump epoch, drop data, unset scope, notify.
 *  Idempotent and safe on an empty store. */
export function clearAll(): void {
  for (const c of controllers) c.abort();
  controllers.clear();
  epoch++;
  for (const r of [...resets]) r();
  scope = null;
  notify();
}

/** Re-render when anything in the store changes; `read` must return a stable snapshot. */
export function useStore<T>(read: () => T): T {
  return useSyncExternalStore(subscribe, read, read);
}
