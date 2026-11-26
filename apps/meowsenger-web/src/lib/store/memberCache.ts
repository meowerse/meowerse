// Per-chat roster, stale-while-revalidate: an entry past its 5-minute TTL is still returned
// (so an open chat never blanks) but `isFresh` is false and the open chat revalidates it.
import type { Member } from "../chat";
import { isCurrent, notify, registerCache, useStore } from "./scope";

export const MEMBER_TTL_MS = 5 * 60_000;
const MAX_ROSTERS = 30; // bounded: the oldest roster is evicted
const rosters = new Map<string, { roster: Member[]; at: number }>();
// Per-chat generation, bumped on every invalidate/purge/stale: a fetch that started before it must not store.
const gens = new Map<string, number>();
registerCache(() => { rosters.clear(); gens.clear(); });

const bump = (chatId: string) => { gens.set(chatId, (gens.get(chatId) ?? 0) + 1); };
export const generation = (chatId: string): number => gens.get(chatId) ?? 0;

export function get(chatId: string): Member[] | undefined { return rosters.get(chatId)?.roster; }
export function isFresh(chatId: string): boolean {
  const e = rosters.get(chatId);
  return !!e && Date.now() - e.at < MEMBER_TTL_MS;
}
export function put(chatId: string, roster: Member[], epoch: number, g = generation(chatId)): boolean {
  if (!isCurrent(epoch) || g !== generation(chatId)) return false;
  rosters.delete(chatId);
  rosters.set(chatId, { roster, at: Date.now() });
  if (rosters.size > MAX_ROSTERS) rosters.delete(rosters.keys().next().value!);
  notify();
  return true;
}
/** Keep showing the roster but force a revalidation (e.g. the caller's role changed). */
export function markStale(chatId: string): void {
  const e = rosters.get(chatId);
  if (!e) return;
  e.at = 0; bump(chatId); notify();
}
export function invalidate(chatId: string): void {
  bump(chatId);
  if (rosters.delete(chatId)) notify();
}
export const purge = invalidate;

export function useMembers(chatId: string | null): Member[] | undefined {
  return useStore(() => (chatId ? get(chatId) : undefined));
}
/** True while the chat has a cached roster that is past its TTL or marked stale (snapshot changes on markStale/put). */
export function useStale(chatId: string | null): boolean {
  return useStore(() => (chatId ? rosters.has(chatId) && !isFresh(chatId) : false));
}
