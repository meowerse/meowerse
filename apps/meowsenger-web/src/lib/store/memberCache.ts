// Per-chat roster with a 5-minute TTL.
import type { Member } from "../chat";
import { isCurrent, notify, registerCache, useStore } from "./scope";

export const MEMBER_TTL_MS = 5 * 60_000;
const rosters = new Map<string, { roster: Member[]; at: number }>();
let gen = 0; // bumped on every invalidation: an in-flight fetch that predates one must not store
registerCache(() => { rosters.clear(); gen++; });
export const generation = (): number => gen;

export function get(chatId: string): Member[] | undefined {
  const e = rosters.get(chatId);
  if (!e) return undefined;
  // Pure read (safe as a useSyncExternalStore snapshot): an expired roster is just not
  // returned; it is replaced by the next put or dropped by purge/clearAll.
  if (Date.now() - e.at >= MEMBER_TTL_MS) return undefined;
  return e.roster;
}
export function put(chatId: string, roster: Member[], epoch: number, g = gen): boolean {
  if (!isCurrent(epoch) || g !== gen) return false;
  rosters.set(chatId, { roster, at: Date.now() });
  notify();
  return true;
}
export function invalidate(chatId: string): void {
  gen++;
  if (rosters.delete(chatId)) notify();
}
export const purge = invalidate;

export function useMembers(chatId: string | null): Member[] | undefined {
  return useStore(() => (chatId ? get(chatId) : undefined));
}
