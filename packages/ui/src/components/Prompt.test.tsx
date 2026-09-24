import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Prompt } from "./Prompt";

function Harness({ onSubmit, enterSends = "always" as const, busy = false }: { onSubmit: (v: string) => void; enterSends?: "auto" | "always" | "never"; busy?: boolean }) {
  const [v, setV] = useState("");
  return <Prompt label="message" value={v} onChange={setV} onSubmit={(t) => { onSubmit(t); setV(""); }} enterSends={enterSends} busy={busy} />;
}

describe("Prompt", () => {
  it("is a labelled multiline textbox with a visible send button", () => {
    render(<Harness onSubmit={() => {}} />);
    expect(screen.getByRole("textbox", { name: "message" })).toHaveAttribute("enterkeyhint", "send");
    expect(screen.getByRole("button", { name: "send" })).toBeInTheDocument();
  });
  it("Enter sends trimmed text, Shift+Enter inserts a newline", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "  hi{Shift>}{Enter}{/Shift}there  {Enter}");
    expect(onSubmit).toHaveBeenCalledWith("hi\nthere");
  });
  it("never sends while an IME is composing", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("does not send empty text; the button says why", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "send" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "send" })).toHaveAttribute("aria-disabled", "true");
  });
  it("busy never disables typing", () => {
    render(<Harness onSubmit={() => {}} busy />);
    expect(screen.getByRole("textbox")).not.toBeDisabled();
  });
  it("enterSends=never makes Enter a newline", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} enterSends="never" />);
    await userEvent.type(screen.getByRole("textbox"), "a{Enter}b");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("a\nb");
  });

  function stubMatchMedia(matches: boolean) {
    return vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  }

  it("enterSends=auto with a coarse pointer inserts a newline; the button still sends", async () => {
    const onSubmit = vi.fn();
    const original = window.matchMedia;
    window.matchMedia = stubMatchMedia(true);
    try {
      render(<Harness onSubmit={onSubmit} enterSends="auto" />);
      const box = screen.getByRole("textbox");
      await userEvent.type(box, "a{Enter}b");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(box).toHaveValue("a\nb");
      await userEvent.click(screen.getByRole("button", { name: "send" }));
      expect(onSubmit).toHaveBeenCalledWith("a\nb");
    } finally {
      window.matchMedia = original;
    }
  });

  it("enterSends=auto with a fine pointer sends on Enter", async () => {
    const onSubmit = vi.fn();
    const original = window.matchMedia;
    window.matchMedia = stubMatchMedia(false);
    try {
      render(<Harness onSubmit={onSubmit} enterSends="auto" />);
      await userEvent.type(screen.getByRole("textbox"), "hi{Enter}");
      expect(onSubmit).toHaveBeenCalledWith("hi");
    } finally {
      window.matchMedia = original;
    }
  });
});
