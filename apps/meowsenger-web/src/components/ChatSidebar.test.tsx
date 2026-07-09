/** @vitest-environment happy-dom */
/**
 * Focused test for the sidebar chat-type a11y label (#35): a row's type (group /
 * channel / direct message) was conveyed only by an aria-hidden emoji, so a screen
 * reader announced nothing. Each row now carries a visually-hidden type word.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "../test/rtl";
import { ChatSidebar } from "./ChatSidebar";
import type { ChatSummary } from "../lib/chat";

function chat(over: Partial<ChatSummary>): ChatSummary {
  return {
    id: "c1", type: "direct", name: null, lastMessage: "hi", lastSenderId: "u2",
    lastActivity: 1000, unreadCount: 0, peerId: "u2", peerUsername: "bob",
    peerDisplayName: "Bob", peerAvatarUrl: null, peerLastSeenAt: null, ...over,
  };
}

describe("ChatSidebar — chat-type a11y label (#35)", () => {
  it("adds a visually-hidden type word to each row", () => {
    const chats = [
      chat({ id: "g1", type: "group", name: "weekend plans", peerId: null }),
      chat({ id: "ch1", type: "channel", name: "announcements", peerId: null }),
      chat({ id: "d1", type: "direct", peerDisplayName: "Bob" }),
    ];
    render(
      <ChatSidebar
        chats={chats}
        activeId={null}
        online={new Set()}
        base=""
        onSelect={() => {}}
        onOpenResult={() => {}}
        onNewChatClick={() => {}}
        loading={false}
      />,
    );
    for (const word of ["group", "channel", "direct message"]) {
      const el = screen.getByText(word);
      expect(el.className).toBe("mw-sr-only");
    }
  });
});
