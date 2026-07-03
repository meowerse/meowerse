import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Code } from "./Code";

describe("Code", () => {
  it("preserves case (does not lowercase) and marks the mono class", () => {
    render(<Code value="7F3K-9QW2-XM4L" />);
    const el = screen.getByText("7F3K-9QW2-XM4L");
    expect(el).toHaveClass("mono");
    expect(el).toHaveAttribute("data-case", "preserve");
  });
  it("copy button writes the raw value to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Code value="mw_live_abc" copy />);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("mw_live_abc");
  });
});
