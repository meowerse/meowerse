// Typed REST + WebSocket helpers for the chat UI. All fetches are credentialed
// so the __Host-mw_session cookie rides along (same-origin worker). This is the
// only unit-tested frontend code (>=90% on src/lib/**); the React islands are
// validated by astro check + build.

/** A chat summary as rendered in the sidebar (mirrors the worker's ChatSummary). */
export interface ChatSummary {
  id: string;
  type: string;
  name: string | null;
  lastMessage: string | null;
  lastSenderId: string | null;
  lastActivity: number;
  unreadCount: number;
  // DM peer identity (null for groups — Slice 5).
  peerUsername: string | null;
  peerDisplayName: string | null;
  peerAvatarUrl: string | null;
}

/** A message on the wire / out of history (mirrors the DO's Wire shape). */
export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  body: string;
  createdAt: number;
}

/** GET /api/chats — the caller's sidebar list. Empty array on any failure. */
export async function listChats(base: string): Promise<ChatSummary[]> {
  try {
    const r = await fetch(`${base}/api/chats`, { credentials: "include" });
    const d = (await r.json()) as { chats?: ChatSummary[] };
    return d.chats ?? [];
  } catch {
    return [];
  }
}

/** POST /api/chats { username } — open-or-create a DM. Returns the chatId or an error code. */
export async function openDirect(base: string, username: string): Promise<{ chatId?: string; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    return (await r.json()) as { chatId?: string; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** GET /api/chats/:id/messages?before= — a history page (ascending), oldest first. */
export async function loadHistory(base: string, chatId: string, before?: string): Promise<Message[]> {
  try {
    const q = before ? `?before=${encodeURIComponent(before)}` : "";
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/messages${q}`, { credentials: "include" });
    const d = (await r.json()) as { messages?: Message[] };
    return d.messages ?? [];
  } catch {
    return [];
  }
}

/**
 * WebSocket URL for a chat on the SAME origin as the API. `base` is "" in prod
 * (UI + BFF are one worker), so fall back to `location.origin`. `http`→`ws` /
 * `https`→`wss` via a single prefix swap.
 */
export function wsUrl(base: string, chatId: string): string {
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const wsOrigin = origin.replace(/^http/, "ws");
  return `${wsOrigin}/ws?chat=${encodeURIComponent(chatId)}`;
}
