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
const inflight = new Set<string>();

function networkAllows(): boolean {
  const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !(c?.saveData || /^(slow-)?2g$/.test(c?.effectiveType ?? ""));
}

/** Best effort: dropped (not queued) when gated, busy, or the chat already has a cache entry
 *  (an entry paints warm already and revalidates on open). A result is stored only under the
 *  existing EntryToken guard, so clearAll / account switch / purge(chat) drops it. */
export async function prefetchChat(d: Deps, base: string, chatId: string): Promise<void> {
  const { enter, beginWork, peekEntry, putT, loadHistory } = d;
  if (!networkAllows() || inflight.size >= MAX_CONCURRENT || inflight.has(chatId) || peekEntry(chatId)) return;
  const tok = enter(chatId);
  const work = beginWork(); // aborted by clearAll()
  inflight.add(chatId);
  try {
    const r = await loadHistory(base, chatId, undefined, { signal: work.signal });
    if (!r.ok || r.unknown || r.data.length === 0 || peekEntry(chatId)) return; // a visit may have cached it meanwhile
    putT(tok, { messages: r.data, hasMore: r.data.length >= PAGE, fetchedAt: Date.now() });
  } catch { /* aborted / network: nothing to warm */ } finally {
    inflight.delete(chatId);
    work.done();
  }
}

const DELAY_MS = 150;
let timer = 0;
interface IntentEvent { type: string; target: EventTarget; relatedTarget?: EventTarget | null; pointerType?: string }
const rowOf = (t: EventTarget | null | undefined) => (t as Element | null)?.closest?.("[data-intent]") ?? null;

/** Delegated sidebar events: hover / focus-visible arm a 150 ms timer, leaving cancels it (a pass over
 *  rows fetches nothing); touch arms on pointerdown at once. The open chat has no `data-intent`. */
export function onIntent(d: Deps, base: string, e: IntentEvent): void {
  const row = rowOf(e.target);
  const touch = e.pointerType === "touch";
  if (e.type === "pointerout" || e.type === "blur") {
    if (!(row && row === rowOf(e.relatedTarget))) window.clearTimeout(timer); // moving inside one row keeps it armed
    return;
  }
  if (!row || (e.type === "pointerover" && touch) || (e.type === "pointerdown" && !touch)
    || (e.type === "focus" && !(e.target as Element).matches(":focus-visible"))) return;
  window.clearTimeout(timer);
  const id = (row as HTMLElement).dataset.intent!;
  timer = window.setTimeout(() => { void prefetchChat(d, base, id); }, e.type === "pointerdown" ? 0 : DELAY_MS);
}
