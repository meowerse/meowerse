/** @vitest-environment happy-dom */
/**
 * Focused test for the in-chat search panel's "no match" label (#36): after a search
 * returns nothing, editing the query must NOT retro-change the label — it should keep
 * naming the term the shown results actually answer (`searchedTerm`), not the live q.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "../test/rtl";
import type { Message } from "../lib/chat";

const H = vi.hoisted(() => ({ searchChat: vi.fn() }));

vi.mock("../lib/chat", async (importActual) => {
  const actual = await importActual<typeof import("../lib/chat")>();
  return { ...actual, searchChat: H.searchChat };
});

import { SearchPanel } from "./SearchPanel";

beforeEach(() => { H.searchChat.mockReset(); });

function mount() {
  render(
    <SearchPanel
      base=""
      chatId="c1"
      resolveName={() => "someone"}
      meId="u1"
      onJump={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return screen.getByLabelText("search this chat") as HTMLInputElement;
}

describe("SearchPanel — stale query label (#36)", () => {
  it("keeps the no-match label on the searched term after the query is edited", async () => {
    H.searchChat.mockResolvedValue([] as Message[]); // no matches for "foo"
    const input = mount();
    act(() => fireEvent.change(input, { target: { value: "foo" } }));
    act(() => fireEvent.keyDown(input, { key: "Enter" }));

    const note = await screen.findByText(/no messages match/);
    expect(note.textContent).toContain("foo");

    // Edit the query WITHOUT re-running — the label must not follow the live input.
    act(() => fireEvent.change(input, { target: { value: "foobar" } }));
    expect(note.textContent).toContain("foo");
    expect(note.textContent).not.toContain("foobar");
  });

  it("updates the no-match term once a new search runs", async () => {
    H.searchChat.mockResolvedValue([] as Message[]);
    const input = mount();
    act(() => fireEvent.change(input, { target: { value: "foo" } }));
    act(() => fireEvent.keyDown(input, { key: "Enter" }));
    await waitFor(() => expect(screen.getByText(/no messages match/).textContent).toContain("foo"));

    act(() => fireEvent.change(input, { target: { value: "foobar" } }));
    act(() => fireEvent.keyDown(input, { key: "Enter" }));
    await waitFor(() => expect(screen.getByText(/no messages match/).textContent).toContain("foobar"));
  });
});
