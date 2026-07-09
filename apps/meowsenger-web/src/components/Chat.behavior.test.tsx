/** @vitest-environment happy-dom */
/**
 * Black-box behavior tests for the chat island (the audit flagged it as a
 * 1253-line god component with ZERO behavior coverage). These drive the REAL
 * component through a mocked WebSocket + mocked lib, asserting the risky behaviors
 * the audit named. They are deliberately black-box (against <Chat>, not internals)
 * so they pin behavior ACROSS the useConversation extraction — a regression there
 * fails these.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, MockWebSocket, setVisibility } from "../test/rtl";
import type { ChatSummary, Message, Member } from "../lib/chat";

// Controlled fixtures + spies, referenced from the hoisted vi.mock factories.
const H = vi.hoisted(() => ({
  session: {
    authenticated: true,
    user: { id: "u1", username: "alice", displayName: "Alice", avatarUrl: null, verified: true },
  } as { authenticated: boolean; user?: unknown },
  chats: [] as ChatSummary[],
  history: {} as Record<string, Message[]>,
  members: {} as Record<string, Member[]>,
  around: null as { found: boolean; messages: Message[]; hasOlder: boolean; hasNewer: boolean } | null,
  after: [] as Message[],
}));

vi.mock("../lib/meowsengerApi", () => ({
  getSession: vi.fn(async () => H.session),
  loginUrl: (b: string) => `${b}/auth/login`,
  logoutUrl: (b: string) => `${b}/auth/logout`,
}));

vi.mock("../lib/chat", async (importActual) => {
  const actual = await importActual<typeof import("../lib/chat")>();
  return {
    ...actual, // keep the PURE helpers real: applyReaction, wsUrl, slugify
    listChats: vi.fn(async () => H.chats),
    loadHistory: vi.fn(async (_b: string, chatId: string) => H.history[chatId] ?? []),
    loadHistoryAround: vi.fn(async () => H.around ?? { found: false, messages: [], hasOlder: false, hasNewer: false }),
    loadHistoryAfter: vi.fn(async () => H.after),
    getMembers: vi.fn(async (_b: string, chatId: string) => H.members[chatId] ?? []),
    resolveChat: vi.fn(async () => ({ error: "not_found" })),
    openDirect: vi.fn(async () => ({ error: "user_not_found" })),
  };
});

// Imported AFTER the mocks register (vi.mock is hoisted, so this order is fine).
import Chat from "./Chat";

function dm(over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: "c1", type: "direct", name: null, lastMessage: "hi", lastSenderId: "u2",
    lastActivity: 1000, unreadCount: 0, peerId: "u2", peerUsername: "bob",
    peerDisplayName: "Bob", peerAvatarUrl: null, peerLastSeenAt: null, ...over,
  };
}
function msg(over: Partial<Message> = {}): Message {
  return { id: "m1", chatId: "c1", senderId: "u2", body: "hello there", createdAt: 1000, ...over };
}
function setUrl(path: string): void {
  window.history.replaceState({}, "", path);
}

/** Mount at ?chat=c1, wait for the socket to be created + first history to render. */
async function mountOpen(): Promise<MockWebSocket> {
  setUrl("/app?chat=c1");
  render(<Chat base="" />);
  await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
  return MockWebSocket.last;
}
/** Open the socket (connected) so sends/read/away frames flow. */
function open(ws: MockWebSocket): void {
  act(() => ws.mockOpen());
}
function emit(ws: MockWebSocket, frame: unknown): void {
  act(() => ws.mockEmit(frame));
}

beforeEach(() => {
  H.chats = [dm()];
  H.history = { c1: [msg({ id: "m1", body: "hello there", createdAt: 1000 })] };
  H.members = {};
  H.around = null;
  H.after = [];
  H.session = { authenticated: true, user: { id: "u1", username: "alice", displayName: "Alice", avatarUrl: null, verified: true } };
  setUrl("/app");
});

describe("Chat island — deep-link + connection", () => {
  it("opens ?chat= and connects a socket (URL-sync guard doesn't strip the link before consume)", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    expect(ws.url).toContain("c1");
  });

  it("appends a live message frame to the log", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    open(ws);
    emit(ws, { type: "message", message: msg({ id: "m2", senderId: "u2", body: "a new live line", createdAt: 2000 }) });
    await waitFor(() => expect(screen.getByText("a new live line")).toBeTruthy());
  });
});

describe("Chat island — read-receipt visibility gate (audit)", () => {
  it("does NOT send a read while the tab is hidden, and DOES once visible", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    // Hidden tab: opening the socket must NOT auto-ack (would advance the peer's
    // "seen" tick + wipe unread for messages no human saw).
    setVisibility("hidden");
    open(ws);
    expect(ws.sentFrames().some((f) => f.type === "read")).toBe(false);
    // Becoming visible + a focus catch-up acks up to the newest loaded message.
    act(() => setVisibility("visible"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(ws.sentFrames().some((f) => f.type === "read" && f.upTo === 1000)).toBe(true));
  });
});

describe("Chat island — detached-window suppression (audit)", () => {
  it("a deep-link ?m jump into a detached window suppresses live-append + shows 'jump to latest'", async () => {
    H.history = { c1: [msg({ id: "m50", body: "recent tail", createdAt: 5000 })] };
    H.around = {
      found: true,
      messages: [msg({ id: "mOld", body: "way back when", createdAt: 100 })],
      hasOlder: false,
      hasNewer: true, // there ARE newer messages below the loaded window
    };
    setUrl("/app?chat=c1&m=mOld");
    render(<Chat base="" />);
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.last;
    // The jump lands: the old message + a "jump to latest" affordance are shown.
    await waitFor(() => expect(screen.getByText("way back when")).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText("jump to latest messages")).toBeTruthy());
    // A live message must NOT append into the detached window.
    open(ws);
    emit(ws, { type: "message", message: msg({ id: "m99", body: "should be suppressed", createdAt: 6000 }) });
    expect(screen.queryByText("should be suppressed")).toBeNull();
  });
});

describe("Chat island — away presence on visibilitychange (audit)", () => {
  it("emits away:true when hidden and away:false when visible again", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    open(ws);
    act(() => setVisibility("hidden"));
    await waitFor(() => expect(ws.sentFrames().some((f) => f.type === "away" && f.away === true)).toBe(true));
    act(() => setVisibility("visible"));
    await waitFor(() => expect(ws.sentFrames().some((f) => f.type === "away" && f.away === false)).toBe(true));
  });
});

describe("Chat island — reconnect backoff", () => {
  it("opens a fresh socket after an unexpected drop", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    open(ws);
    act(() => ws.mockDrop()); // unexpected close → schedule a backoff reconnect
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2), { timeout: 2000 });
    expect(MockWebSocket.last).not.toBe(ws);
  });
});

describe("Chat island — optimistic send + reconcile", () => {
  it("shows an optimistic pending bubble, sends {type:send}, then reconciles on {sent}", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    open(ws);
    const box = screen.getByLabelText("message") as HTMLTextAreaElement;
    act(() => fireEvent.change(box, { target: { value: "outgoing hi" } }));
    act(() => fireEvent.click(screen.getByRole("button", { name: "send" })));
    // Optimistic bubble + a send frame carrying the tempId.
    await waitFor(() => expect(screen.getByText("outgoing hi")).toBeTruthy());
    const sendFrame = ws.sentFrames().find((f) => f.type === "send");
    expect(sendFrame).toBeTruthy();
    expect(sendFrame!.body).toBe("outgoing hi");
    // Server ack reconciles the tempId → real message (no duplicate row).
    emit(ws, { type: "sent", tempId: sendFrame!.tempId, message: msg({ id: "srv1", senderId: "u1", body: "outgoing hi", createdAt: 3000 }) });
    await waitFor(() => expect(screen.getAllByText("outgoing hi").length).toBe(1));
  });
});

describe("Chat island — edit / delete / reaction frames", () => {
  it("applies an edited frame in place", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    emit(ws, { type: "edited", id: "m1", body: "edited body", editedAt: 4000 });
    await waitFor(() => expect(screen.getByText("edited body")).toBeTruthy());
    expect(screen.queryByText("hello there")).toBeNull();
  });

  it("renders a tombstone on a deleted frame", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    emit(ws, { type: "deleted", id: "m1" });
    await waitFor(() => expect(screen.getByText("message deleted")).toBeTruthy());
    expect(screen.queryByText("hello there")).toBeNull();
  });
});

describe("Chat island — presence + typing", () => {
  it("shows the peer online from a snapshot and 'typing…' from a typing frame", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    emit(ws, { type: "presence_snapshot", online: ["u2"], away: [] });
    await waitFor(() => expect(screen.getAllByText("online").length).toBeGreaterThan(0));
    emit(ws, { type: "typing", userId: "u2", on: true });
    await waitFor(() => expect(screen.getByText("typing…")).toBeTruthy());
  });
});

describe("Chat island — error frame", () => {
  it("surfaces a mapped toast for a server error frame", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    emit(ws, { type: "error", code: "rate_limited" });
    await waitFor(() => expect(screen.getByText("you're sending too fast — slow down a moment")).toBeTruthy());
  });
});

describe("Chat island — day separators (#10/#12)", () => {
  it("renders a separator before the first message of each calendar day", async () => {
    // Two messages ~25h apart → two distinct calendar days → two separators.
    H.history = {
      c1: [
        msg({ id: "d1", body: "first day", createdAt: 1000 }),
        msg({ id: "d2", body: "next day", createdAt: 90_000_000 }),
      ],
    };
    await mountOpen();
    await waitFor(() => expect(screen.getByText("next day")).toBeTruthy());
    expect(screen.getAllByRole("separator").length).toBe(2);
  });

  it("renders a single separator when all messages share a day", async () => {
    H.history = {
      c1: [
        msg({ id: "s1", body: "one", createdAt: 1000 }),
        msg({ id: "s2", body: "two", createdAt: 2000 }),
      ],
    };
    await mountOpen();
    await waitFor(() => expect(screen.getByText("two")).toBeTruthy());
    expect(screen.getAllByRole("separator").length).toBe(1);
  });
});

describe("Chat island — tab-title unread badge (#14)", () => {
  it("reflects the count of chats with unread in document.title, and restores on unmount", async () => {
    H.chats = [
      dm({ unreadCount: 2 }),
      dm({ id: "c2", peerId: "u3", peerUsername: "carol", peerDisplayName: "Carol", unreadCount: 1 }),
    ];
    setUrl("/app"); // no active chat → no read zeroes the counts
    const { unmount } = render(<Chat base="" />);
    await waitFor(() => expect(document.title).toBe("(2) meowsenger"));
    unmount();
    expect(document.title).toBe("meowsenger");
  });
});

describe("Chat island — SR announce of new incoming messages (#7)", () => {
  it("announces new incoming messages only — never the backlog or own sends", async () => {
    const ws = await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).toBeTruthy();
    // The initial backlog message must NOT be announced.
    expect(live.textContent ?? "").not.toContain("hello there");
    // A live incoming frame IS announced, naming the sender.
    open(ws);
    emit(ws, { type: "message", message: msg({ id: "m2", senderId: "u2", body: "a fresh line", createdAt: 2000 }) });
    await waitFor(() => expect(live.textContent ?? "").toContain("a fresh line"));
    expect(live.textContent ?? "").toContain("Bob");
    // My own outgoing message is NOT announced.
    const box = screen.getByLabelText("message") as HTMLTextAreaElement;
    act(() => fireEvent.change(box, { target: { value: "my own line" } }));
    act(() => fireEvent.click(screen.getByRole("button", { name: "send" })));
    await waitFor(() => expect(screen.getByText("my own line")).toBeTruthy());
    expect(live.textContent ?? "").not.toContain("my own line");
  });
});

describe("Chat island — bulk-delete confirmation (#37)", () => {
  it("confirms before deleting the eligible selection, then sends the delete frame", async () => {
    H.history = { c1: [msg({ id: "mine1", senderId: "u1", body: "delete me", createdAt: Date.now() })] };
    const ws = await mountOpen();
    open(ws);
    await waitFor(() => expect(screen.getByText("delete me")).toBeTruthy());
    // Enter select mode via the row context menu → "select".
    act(() => fireEvent.contextMenu(screen.getByText("delete me")));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "select" })).toBeTruthy());
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "select" })));
    // The select-bar delete opens a confirm dialog — no delete frame is sent yet.
    act(() => fireEvent.click(screen.getByRole("button", { name: "delete" })));
    await waitFor(() => expect(screen.getByText(/delete 1 message\?/)).toBeTruthy());
    expect(ws.sentFrames().some((f) => f.type === "delete")).toBe(false);
    // Confirming actually sends the delete.
    const deletes = screen.getAllByRole("button", { name: "delete" });
    act(() => fireEvent.click(deletes[deletes.length - 1]));
    await waitFor(() => expect(ws.sentFrames().some((f) => f.type === "delete" && f.id === "mine1")).toBe(true));
  });
});

describe("Chat island — message actions toolbar (#43)", () => {
  it("is a role=toolbar with a single tab stop; arrow keys rove focus", async () => {
    await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    const toolbar = document.querySelector('[role="toolbar"][aria-label="message actions"]') as HTMLElement;
    expect(toolbar).toBeTruthy();
    const btns = Array.from(toolbar.querySelectorAll("button"));
    expect(btns.filter((b) => b.getAttribute("tabindex") === "0").length).toBe(1);
    expect(btns.filter((b) => b.getAttribute("tabindex") === "-1").length).toBe(btns.length - 1);
    btns[0].focus();
    act(() => fireEvent.keyDown(toolbar, { key: "ArrowRight" }));
    expect(document.activeElement).toBe(btns[1]);
  });
});

describe("Chat island — menu focus restore (#9)", () => {
  it("returns focus to the ⋯ trigger when the menu closes", async () => {
    await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    const toolbar = document.querySelector('[role="toolbar"][aria-label="message actions"]') as HTMLElement;
    const moreBtn = Array.from(toolbar.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "more actions",
    ) as HTMLElement;
    moreBtn.focus();
    act(() => fireEvent.click(moreBtn));
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(moreBtn);
  });
});

describe("Chat island — per-chat UI reset on switch (audit trap)", () => {
  it("closes the search panel when switching chats", async () => {
    H.chats = [dm(), dm({ id: "c2", peerId: "u3", peerUsername: "carol", peerDisplayName: "Carol", lastMessage: "yo" })];
    H.history = {
      c1: [msg({ id: "m1", body: "hello there", createdAt: 1000 })],
      c2: [msg({ id: "n1", chatId: "c2", senderId: "u3", body: "carol says hi", createdAt: 1500 })],
    };
    await mountOpen();
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy());
    // Open the in-chat search panel (its "close search" button is a unique marker).
    act(() => fireEvent.click(screen.getByLabelText("search this chat")));
    await waitFor(() => expect(screen.getByLabelText("close search")).toBeTruthy());
    // Switch to the other chat via its sidebar row → the search panel must reset (close).
    act(() => fireEvent.click(screen.getByText("Carol")));
    await waitFor(() => expect(screen.getByText("carol says hi")).toBeTruthy());
    expect(screen.queryByLabelText("close search")).toBeNull();
  });
});
