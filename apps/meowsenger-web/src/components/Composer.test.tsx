/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "../test/rtl";
import { Composer } from "./Composer";

const mm = window.matchMedia;
afterEach(() => { window.matchMedia = mm; });
const touch = (on: boolean) => { window.matchMedia = ((q: string) => ({ matches: on && q.includes("coarse"), media: q })) as never; };
function type(onSend = vi.fn(() => "sent" as const)) {
  render(<Composer onSend={onSend} />);
  const ta = screen.getByLabelText("message");
  fireEvent.change(ta, { target: { value: "hi" } });
  return { ta, onSend };
}

describe("Composer Enter key", () => {
  it("desktop: Enter sends, Shift+Enter does not", () => {
    touch(false);
    const { ta, onSend } = type();
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hi");
  });
  it("touch: Enter is a newline (not sent); the send button sends", () => {
    touch(true);
    const { ta, onSend } = type();
    const ev = fireEvent.keyDown(ta, { key: "Enter" });
    expect(ev).toBe(true); // not preventDefault-ed: the textarea inserts the newline
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(onSend).toHaveBeenCalledWith("hi");
  });
  it("IME composition never sends (desktop)", () => {
    touch(false);
    const { ta, onSend } = type();
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true });
    fireEvent.keyDown(ta, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });
});
