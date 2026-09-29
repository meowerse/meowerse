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

  it("an empty or blank value renders (never throws), with send disabled and nothing sent", async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<Prompt label="message" value="" onChange={() => {}} onSubmit={onSubmit} />);
    const send = screen.getByRole("button", { name: "send" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(send);
    rerender(<Prompt label="message" value={"   \n "} onChange={() => {}} onSubmit={onSubmit} />);
    expect(send).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a blank sendLabel falls back to \"send\"; maxRows below 1 (or NaN) still grows to one row, never collapses", () => {
    const sh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 500 });
    try {
      for (const maxRows of [0, -3, NaN]) {
        const { unmount } = render(<Prompt label="message" value="x" onChange={() => {}} onSubmit={() => {}} sendLabel=" " maxRows={maxRows} />);
        expect(screen.getByRole("button", { name: "send" })).toBeInTheDocument();
        expect((screen.getByRole("textbox") as HTMLTextAreaElement).style.height).toBe("44px");
        unmount();
      }
    } finally {
      if (sh) Object.defineProperty(HTMLElement.prototype, "scrollHeight", sh);
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });

  it("labelPlacement defaults to hidden: a visually-hidden label and the label as placeholder", () => {
    const { container } = render(<Prompt label="message" value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(container.firstElementChild).not.toHaveClass("mw-prompt--float");
    const box = screen.getByRole("textbox", { name: "message" });
    expect(box).toHaveAttribute("placeholder", "message");
    expect(container.querySelector("label")).toHaveClass("sr-only");
  });

  it("labelPlacement=float: a visible label after the textarea, same accessible name, a space placeholder unless one is given", () => {
    const { container, rerender } = render(<Prompt label="message" labelPlacement="float" value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(container.firstElementChild).toHaveClass("mw-prompt", "mw-prompt--float");
    const box = screen.getByRole("textbox", { name: "message" });
    expect(box).toHaveAttribute("placeholder", " ");
    const label = box.nextElementSibling!;
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveClass("mw-prompt__label");
    expect(label).not.toHaveClass("sr-only");
    expect(label).toHaveAttribute("for", box.id);
    expect(container.querySelectorAll("label")).toHaveLength(1);
    rerender(<Prompt label="message" labelPlacement="float" placeholder="say hi" value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(box).toHaveAttribute("placeholder", "say hi");
    expect(screen.getByRole("button", { name: "send" })).toBeInTheDocument();
  });
});
