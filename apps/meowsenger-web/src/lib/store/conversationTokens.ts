// The ONLY store surface the conversation hook may import: token-authorised writes.
// Every write is refused unless its token (taken at chat entry / fetch start) is still
// valid, i.e. no clearAll / setScope(other) / purge(chat) happened since. MEMORY ONLY.
import * as cc from "./conversationCache";
import type { ConversationEntry } from "./conversationCache";
import { begin } from "./scope";

export type { EntryToken, ConversationEntry, ScrollAnchor } from "./conversationCache";
export const enter = cc.enter;
export const valid = cc.valid;
/** Scope-tracked async work: `clearAll()` aborts `signal`; call `done()` in a `finally`. */
export const beginWork = begin;
/** Snapshot read: no recency change (safe in render). */
export function peekEntry(chatId: string): ConversationEntry | undefined { return cc.peek(chatId); }
/** LRU recency touch (an effect, never render). */
export function touch(chatId: string): void { cc.get(chatId); }
/** Store the newest window. Refused (false) unless `tok` is still valid. */
export function putT(tok: cc.EntryToken, entry: ConversationEntry, opts?: { detached?: boolean }): boolean {
  if (!cc.valid(tok)) return false;
  return cc.put(tok.chatId, entry, tok.epoch, opts);
}
/** Update an existing entry (no-op when absent). Refused unless `tok` is still valid. */
export function patchT(tok: cc.EntryToken, fn: (e: ConversationEntry) => ConversationEntry): boolean {
  if (!cc.valid(tok)) return false;
  return cc.patch(tok.chatId, fn, tok.epoch);
}
