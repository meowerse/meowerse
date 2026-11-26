/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, act } from "@testing-library/react";
import { render, screen } from "../test/rtl";
import { ChatSidebar } from "./ChatSidebar";
import type { ChatSummary } from "../lib/chat";

const loadHistory = vi.fn();
vi.mock("../lib/chat", async (orig) => ({ ...(await orig<typeof import("../lib/chat")>()), loadHistory: (...a: unknown[]) => loadHistory(...a) }));
import { setScope, clearAll } from "../lib/store";
const msgs = [{ id: "m1", chatId: "a", senderId: "u", body: "b", createdAt: 1 }];

const chat = (id: string, name: string): ChatSummary => ({
  id, type: "group", name, lastMessage: "hi", lastSenderId: "u2", lastActivity: 1000, unreadCount: 0,
  peerId: null, peerUsername: null, peerDisplayName: null, peerAvatarUrl: null, peerLastSeenAt: null,
} as unknown as ChatSummary);

function mount(activeId: string | null = null) {
  render(<ChatSidebar chats={[chat("a", "alpha"), chat("b", "beta")]} activeId={activeId} online={new Set()} base="/b" onSelect={() => {}} onOpenResult={() => {}} onNewChatClick={() => {}} loading={false} />);
  return { a: screen.getByRole("button", { name: /alpha/ }), b: screen.getByRole("button", { name: /beta/ }) };
}
const flush = () => act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => { vi.useFakeTimers(); clearAll(); setScope("A"); loadHistory.mockReset(); loadHistory.mockResolvedValue({ ok: true, status: 200, data: msgs }); });
afterEach(() => vi.useRealTimers());

describe("ChatSidebar intent prefetch", () => {
  it("hover for 150 ms prefetches that chat once", async () => {
    const { a } = mount();
    fireEvent.pointerOver(a, { pointerType: "mouse" }); await flush();
    await flush();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(loadHistory).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    await flush();
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(loadHistory.mock.calls[0].slice(0, 2)).toEqual(["/b", "a"]);
  });
  it("a quick pass over rows fetches nothing", async () => {
    const { a, b } = mount();
    fireEvent.pointerOver(a, { pointerType: "mouse" }); await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(100); }); fireEvent.pointerOut(a);
    await flush();
    fireEvent.pointerOver(b, { pointerType: "mouse" }); await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(100); }); fireEvent.pointerOut(b);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(loadHistory).not.toHaveBeenCalled();
  });
  it("touch pointerdown prefetches at once; touch hover does not arm", async () => {
    const { a, b } = mount();
    fireEvent.pointerOver(a, { pointerType: "touch" }); await flush();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(loadHistory).not.toHaveBeenCalled();
    fireEvent.pointerDown(b, { pointerType: "touch" }); await flush();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await flush();
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(loadHistory.mock.calls[0].slice(0, 2)).toEqual(["/b", "b"]);
  });
  it("never arms for the open chat", async () => {
    const { a } = mount("a");
    fireEvent.pointerOver(a, { pointerType: "mouse" }); await flush();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(loadHistory).not.toHaveBeenCalled();
  });
});
