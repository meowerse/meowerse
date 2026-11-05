// LRU of the newest message window per chat. Never holds a detached (?around=) window.
import type { Message } from "../chat";
import { getEpoch, isCurrent, notify, registerCache, useStore } from "./scope";

export const MAX_CHATS = 12;
export const MAX_MESSAGES = 200;

export interface ScrollAnchor { messageId: string; offsetPx: number; atBottom: boolean }
export interface ConversationEntry {
  messages: Message[];
  hasMore: boolean;
  fetchedAt: number;
  scrollAnchor?: ScrollAnchor;
}

// Map insertion order = recency (oldest first).
const lru = new Map<string, ConversationEntry>();
registerCache(() => { lru.clear(); });

function capped(e: ConversationEntry): ConversationEntry {
  if (e.messages.length <= MAX_MESSAGES) return e;
  // Messages are ordered oldest-first: keep the newest window; older rows now exist.
  return { ...e, messages: e.messages.slice(-MAX_MESSAGES), hasMore: true };
}
function set(chatId: string, e: ConversationEntry): void {
  lru.delete(chatId);
  lru.set(chatId, e);
  while (lru.size > MAX_CHATS) lru.delete(lru.keys().next().value as string);
  notify();
}

/** Read AND touch recency. Not for render paths; use `peek`/`useConversationEntry`. */
export function get(chatId: string): ConversationEntry | undefined {
  const e = lru.get(chatId);
  if (e) { lru.delete(chatId); lru.set(chatId, e); }
  return e;
}
/** Snapshot read: no recency change, stable reference between writes. */
export function peek(chatId: string): ConversationEntry | undefined { return lru.get(chatId); }
export function ids(): string[] { return [...lru.keys()]; }

/** Store the newest window. Refused (false) when stale, or for a detached jump window. */
export function put(chatId: string, entry: ConversationEntry, epoch: number, opts?: { detached?: boolean }): boolean {
  if (opts?.detached || !isCurrent(epoch)) return false;
  set(chatId, capped(entry));
  return true;
}
/** Update an existing entry (no-op when absent or stale). `epoch` omitted = sync caller. */
export function patch(chatId: string, change: Partial<ConversationEntry> | ((e: ConversationEntry) => ConversationEntry), epoch?: number): boolean {
  const cur = lru.get(chatId);
  if (!cur || (epoch !== undefined ? !isCurrent(epoch) : !isCurrent(getEpoch()))) return false;
  set(chatId, capped(typeof change === "function" ? change(cur) : { ...cur, ...change }));
  return true;
}
export function setAnchor(chatId: string, scrollAnchor: ScrollAnchor | undefined, epoch?: number): boolean {
  return patch(chatId, { scrollAnchor }, epoch);
}
export function purge(chatId: string): void {
  if (lru.delete(chatId)) notify();
}

export function useConversationEntry(chatId: string | null): ConversationEntry | undefined {
  return useStore(() => (chatId ? lru.get(chatId) : undefined));
}
