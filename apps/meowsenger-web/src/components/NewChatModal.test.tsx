/** @vitest-environment happy-dom */
/**
 * Focused behavior tests for the new-chat modal's group/channel submit path. The
 * audit (#11) flagged that a username typed into the add-member box but not yet
 * "added" (chipped) was silently dropped on submit — and, worse, left the create
 * button disabled so a group could never be created that way. These pin the fix:
 * a pending typed username is folded into the effective roster for both the gate
 * and the create call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "../test/rtl";

const H = vi.hoisted(() => ({
  createGroup: vi.fn(),
  createChannel: vi.fn(),
}));

vi.mock("../lib/chat", async (importActual) => {
  const actual = await importActual<typeof import("../lib/chat")>();
  return {
    ...actual, // keep slugify + the rest real
    createGroup: H.createGroup,
    createChannel: H.createChannel,
    slugAvailable: vi.fn(async () => true),
  };
});

import { NewChatModal } from "./NewChatModal";

beforeEach(() => {
  H.createGroup.mockReset().mockResolvedValue({ chatId: "g1" });
  H.createChannel.mockReset().mockResolvedValue({ chatId: "ch1" });
});

function mount() {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const onDirect = vi.fn(async () => null);
  render(<NewChatModal base="" open onClose={onClose} onDirect={onDirect} onCreated={onCreated} />);
  // Move to the group tab (opens on "direct").
  act(() => fireEvent.click(screen.getByRole("tab", { name: "group" })));
  return { onCreated, onClose };
}

describe("NewChatModal — typed-not-added member (#11)", () => {
  it("includes a username typed but not yet added when creating a group", async () => {
    const { onCreated } = mount();
    act(() => fireEvent.change(screen.getByLabelText("group name"), { target: { value: "weekend plans" } }));
    // Type a member into the add box but do NOT click "add".
    act(() => fireEvent.change(screen.getByLabelText("add member by username"), { target: { value: "@bob" } }));

    // The create button must be enabled (the pending member satisfies the gate)…
    const create = screen.getByRole("button", { name: "create group" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);

    act(() => fireEvent.click(create));
    await waitFor(() => expect(H.createGroup).toHaveBeenCalledTimes(1));
    // …and the typed username (@ stripped) is in the create payload.
    expect((H.createGroup.mock.calls[0][1] as { members: string[] }).members).toEqual(["bob"]);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("g1"));
  });

  it("does not duplicate a pending username that already matches a chip (case-insensitive)", async () => {
    mount();
    act(() => fireEvent.change(screen.getByLabelText("group name"), { target: { value: "weekend plans" } }));
    // Add "bob" as a chip, then type "BOB" (unadded) — the dedup must drop the dupe.
    act(() => fireEvent.change(screen.getByLabelText("add member by username"), { target: { value: "bob" } }));
    act(() => fireEvent.click(screen.getByRole("button", { name: "add" })));
    act(() => fireEvent.change(screen.getByLabelText("add member by username"), { target: { value: "BOB" } }));

    act(() => fireEvent.click(screen.getByRole("button", { name: "create group" })));
    await waitFor(() => expect(H.createGroup).toHaveBeenCalledTimes(1));
    expect((H.createGroup.mock.calls[0][1] as { members: string[] }).members).toEqual(["bob"]);
  });

  it("clears the add-member input after folding it into the group on submit", async () => {
    mount();
    act(() => fireEvent.change(screen.getByLabelText("group name"), { target: { value: "weekend plans" } }));
    const memberBox = screen.getByLabelText("add member by username") as HTMLInputElement;
    act(() => fireEvent.change(memberBox, { target: { value: "carol" } }));
    act(() => fireEvent.click(screen.getByRole("button", { name: "create group" })));
    await waitFor(() => expect(H.createGroup).toHaveBeenCalledTimes(1));
    expect(memberBox.value).toBe("");
  });
});
