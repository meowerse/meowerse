// Last good chat list. Single-flight, sequence-guarded, epoch-guarded refresh.
import type { RequestResult } from "@meowerse/ui";
import type { ChatSummary } from "../chat";
import { begin, isCurrent, notify, registerCache, useStore } from "./scope";

export type ListFetcher = (signal: AbortSignal) => Promise<RequestResult<ChatSummary[]>>;
export interface ListState { list: ChatSummary[] | null; error: unknown }

let state: ListState = { list: null, error: null };
let seq = 0;        // sequence handed to the newest fetch
let applied = 0;    // sequence of the newest applied response
let inflight: Promise<void> | null = null;
const removedHooks = new Set<(chatId: string) => void>();

registerCache(() => { state = { list: null, error: null }; inflight = null; seq = 0; applied = 0; });

export function getState(): ListState { return state; }
export function subscribeRemoved(fn: (chatId: string) => void): () => void {
  removedHooks.add(fn);
  return () => { removedHooks.delete(fn); };
}

/** Replace the list. Chats that vanished from it are purged from every cache. */
export function apply(list: ChatSummary[], epoch?: number): void {
  if (epoch !== undefined && !isCurrent(epoch)) return;
  const prev = state.list;
  state = { list, error: null };
  if (prev) {
    const keep = new Set(list.map((c) => c.id));
    for (const c of prev) if (!keep.has(c.id)) for (const h of [...removedHooks]) h(c.id);
  }
  notify();
}
/** Drop one chat from the list (no removal hooks; used by purgeChat). */
export function removeChat(chatId: string): void {
  if (!state.list?.some((c) => c.id === chatId)) return;
  state = { ...state, list: state.list.filter((c) => c.id !== chatId) };
  notify();
}

/** Concurrent calls share one fetch; `force` starts a newer one (the older result is dropped). */
export function refresh(fetcher: ListFetcher, opts?: { force?: boolean }): Promise<void> {
  if (inflight && !opts?.force) return inflight;
  const token = begin();
  const mine = ++seq;
  const run = (async () => {
    let res: RequestResult<ChatSummary[]> | null = null;
    try { res = await fetcher(token.signal); } catch { res = null; }
    token.done();
    if (!isCurrent(token.epoch) || token.signal.aborted || mine < applied) return;
    applied = mine;
    if (res && res.ok) apply(res.data);
    else { state = { ...state, error: res ? res.error : new Error("failed") }; notify(); }
  })();
  const p: Promise<void> = run.finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

export function useChatList(): ListState { return useStore(getState); }
