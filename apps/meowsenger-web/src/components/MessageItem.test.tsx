/** @vitest-environment happy-dom */
import { describe, it, expect } from "vitest";
import { render, screen } from "../test/rtl";
import { MessageItem, type Bubble } from "./MessageItem";

const noop = () => {};
function show(over: Partial<Bubble>) {
  const m: Bubble = { id: "m1", chatId: "c1", senderId: "u1", body: "hi", createdAt: 1000, ...over };
  render(
    <MessageItem
      m={m} meId="u1" mine senderName="me" senderAvatarUrl={null} grouped={false} showSenderMeta={false}
      firstInRun replyName="you" seen={false} canEdit={false} canDelete={false} selectMode={false}
      selected={false} editing={false} onReply={noop} onStartEdit={noop} onCancelEdit={noop} onSaveEdit={noop}
      onDelete={noop} onToggleSelect={noop} onContextMenu={noop} onReact={noop} onToggleReaction={noop}
      onJumpToReply={noop} registerRef={noop}
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
