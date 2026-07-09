/** @vitest-environment happy-dom */
/**
 * Focused a11y tests for the member drawer's focus management (#8). The drawer is an
 * aria-modal dialog; it must move focus into the panel on open, trap Tab within it,
 * and restore focus to the opener on close — mirroring packages/ui Modal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "../test/rtl";
import type { ChatSummary, Member } from "../lib/chat";

const H = vi.hoisted(() => ({ members: [] as Member[] }));

vi.mock("../lib/chat", async (importActual) => {
  const actual = await importActual<typeof import("../lib/chat")>();
  return {
    ...actual,
    getMembers: vi.fn(async () => H.members),
    getInvite: vi.fn(async () => ({})),
    getRequests: vi.fn(async () => []),
  };
});

import { MemberDrawer } from "./MemberDrawer";

function chat(over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: "c1", type: "group", name: "weekend plans", lastMessage: null, lastSenderId: null,
    lastActivity: 1000, unreadCount: 0, peerId: null, peerUsername: null,
    peerDisplayName: null, peerAvatarUrl: null, peerLastSeenAt: null, ...over,
  };
}

function drawer() {
  // The caller is a plain member (no manage tabs / action buttons) → a minimal panel.
  return (
    <MemberDrawer
      base=""
      chat={chat()}
      meId="u1"
      online={new Set()}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onLeft={vi.fn()}
    />
  );
}

beforeEach(() => {
  H.members = [{ userId: "u1", username: "me", displayName: "Me", avatarUrl: null, role: "member", joinedAt: 0 }];
});

describe("MemberDrawer — focus management (#8)", () => {
  it("moves focus to the panel's close button on open and restores it on close", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = render(drawer());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("close")));

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("wraps Shift+Tab from the first focusable back to the last", async () => {
    render(drawer());
    const close = await screen.findByLabelText("close");
    await waitFor(() => expect(document.activeElement).toBe(close));

    act(() => fireEvent.keyDown(document, { key: "Tab", shiftKey: true }));
    // Last focusable is the footer "leave group" button.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "leave group" }));
  });
});
