// Intent prefetch: warm the newest history page of a chat into the ConversationCache before it is
// opened. Lazy-loaded by ChatSidebar (eager JS budget). HTTP only: no WebSocket, never marks read,
// never touches the chat list (presence/read/lastActivity semantics are unchanged).
// It imports NOTHING shared with the eager bundle (that would split a shared chunk into the
// eager closure and cost budget): the sidebar passes the store/network functions in.
import type { loadHistory as LoadHistory } from "../chat";
import type * as Tokens from "./conversationTokens";

export type Deps = Pick<typeof Tokens, "enter" | "beginWork" | "peekEntry" | "putT"> & { loadHistory: typeof LoadHistory };

export const MAX_CONCURRENT = 2;
const PAGE = 50; // mirrors useConversation HISTORY_PAGE (a full page means older rows exist)
export const MAX_STORES_PER_MIN = 4; // bounds how many LRU slots (MAX_CHATS = 12) hovering can claim
const COOLDOWN_MS = 30_000;
const inflight = new Set<string>();
const lastTried = new Map<string, number>();
let stores: number[] = [];
/** @internal test-only */
export function _resetForTests(): void { inflight.clear(); lastTried.clear(); stores = []; clearTimeout(timer); }

function networkAllows(): boolean {
  const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !(c?.saveData || /^(slow-)?2g$/.test(c?.effectiveType ?? ""));
}

/** Best effort: dropped (not queued) when gated, busy, or the chat already has a cache entry
 *  (an entry paints warm already and revalidates on open). A result is stored only under the
 *  existing EntryToken guard, so clearAll / account switch / purge(chat) drops it. */
export async function prefetchChat(d: Deps, base: string, chatId: string): Promise<void> {
  const { enter, beginWork, peekEntry, putT, loadHistory } = d;
  const now = Date.now();
  stores = stores.filter((t) => now - t < 60_000);
  if (!networkAllows() || inflight.size >= MAX_CONCURRENT || stores.length + inflight.size >= MAX_STORES_PER_MIN
    || inflight.has(chatId) || peekEntry(chatId) || now - (lastTried.get(chatId) ?? -Infinity) < COOLDOWN_MS) return;
  lastTried.set(chatId, now); // negative cooldown: empty / failed / unknown results are not retried on every hover
  const tok = enter(chatId);
  const work = beginWork(); // aborted by clearAll()
  inflight.add(chatId);
  try {
    const r = await loadHistory(base, chatId, undefined, { signal: work.signal });
    if (!r.ok || r.unknown || r.data.length === 0 || peekEntry(chatId)) return; // a visit may have cached it meanwhile
    if (putT(tok, { messages: r.data, hasMore: r.data.length >= PAGE, fetchedAt: Date.now() })) stores.push(Date.now());
  } catch { /* aborted / network: nothing to warm */ } finally {
    inflight.delete(chatId);
    work.done();
  }
}

const DELAY_MS = 150;
let timer = 0;
interface IntentEvent { type: string; target: EventTarget; relatedTarget?: EventTarget | null; pointerType?: string }
const rowOf = (t: EventTarget | null | undefined) => (t as Element | null)?.closest?.("[data-intent]") ?? null;

/** Delegated sidebar events (desktop only): mouse hover / focus-visible arm a 150 ms timer; leaving, a
 *  press or a click cancels it, and at fire time the row must still be there and not the open chat
 *  (it then has no `data-intent`). Touch and pen never prefetch. */
export function onIntent(d: Deps, base: string, e: IntentEvent): void {
  const row = rowOf(e.target);
  if (e.type === "pointerout" || e.type === "blur") {
    if (!(row && row === rowOf(e.relatedTarget))) window.clearTimeout(timer); // moving inside one row keeps it armed
    return;
  }
  if (e.type === "pointerdown" || e.type === "click") { window.clearTimeout(timer); return; }
  if (!row || (e.type === "pointerover" && e.pointerType !== "mouse")
    || (e.type === "focus" && !(e.target as Element).matches(":focus-visible"))) return;
  window.clearTimeout(timer);
  const id = (row as HTMLElement).dataset.intent!;
  timer = window.setTimeout(() => { if (row.isConnected && (row as HTMLElement).dataset.intent === id) void prefetchChat(d, base, id); }, DELAY_MS);
}
