/** @vitest-environment happy-dom */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../test/rtl";
import { MessageItem, type Bubble } from "./MessageItem";

const noop = () => {};
function show(over: Partial<Bubble>, extra: { onRetrySend?: (m: Bubble) => void; onEditFailedSend?: (m: Bubble) => void } = {}) {
  const m: Bubble = { id: "m1", chatId: "c1", senderId: "u1", body: "hi", createdAt: 1000, ...over };
  render(
    <MessageItem
      m={m} meId="u1" mine senderName="me" senderAvatarUrl={null} grouped={false} showSenderMeta={false}
      firstInRun replyName="you" seen={false} canEdit={false} canDelete={false} selectMode={false}
      selected={false} editing={false} onReply={noop} onStartEdit={noop} onCancelEdit={noop} onSaveEdit={noop}
      onDelete={noop} onToggleSelect={noop} onContextMenu={noop} onReact={noop} onToggleReaction={noop}
      onJumpToReply={noop} registerRef={noop} {...extra}
    />,
  );
}
const TAIL = "sends when you're back online (kept only while this tab is open)";

describe("MessageItem — queued copy says the queue is not durable", () => {
  it.each([
    ["send", `not sent yet · ${TAIL}`],
    ["edit", `edit not sent yet · ${TAIL}`],
    ["delete", `delete not sent yet · ${TAIL}`],
  ] as const)("%s", (queued, text) => {
    show({ queued, pending: queued === "send" });
    expect(screen.getByText(text)).toBeTruthy();
  });
  it("a refused edit shows 'edit couldn't be saved'", () => {
    show({ editFailed: true });
    expect(screen.getByText("edit couldn't be saved")).toBeTruthy();
  });
});

describe("MessageItem — a refused send", () => {
  it("shows 'not sent' with retry and edit actions wired to the callbacks", () => {
    const onRetrySend = vi.fn();
    const onEditFailedSend = vi.fn();
    show({ id: "t-1", tempId: "t-1", sendFailed: true }, { onRetrySend, onEditFailedSend });
    expect(screen.getByText("not sent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(onRetrySend).toHaveBeenCalledWith(expect.objectContaining({ tempId: "t-1" }));
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(onEditFailedSend).toHaveBeenCalledTimes(1);
  });
});
