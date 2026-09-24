import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusLine } from "./StatusLine";

describe("StatusLine", () => {
  it.each([["ok", "[ ok ]"], ["wait", "[wait]"], ["fail", "[fail]"], ["info", "[info]"]] as const)(
    "%s shows the tag and text", (state, tag) => {
      render(<StatusLine state={state}>connected</StatusLine>);
      expect(screen.getByText(tag)).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByText("connected")).toBeInTheDocument();
    });
  it("fail is an alert, others are polite status when live", () => {
    const { rerender } = render(<StatusLine state="fail">x</StatusLine>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<StatusLine state="wait" live>x</StatusLine>);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
  it("renders an action", () => {
    render(<StatusLine state="fail" action={<button>retry</button>}>x</StatusLine>);
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
  });
  it.each([["ok", "ok"], ["wait", "working"], ["fail", "error"], ["info", "info"]] as const)(
    "%s exposes the state word ('%s') to assistive tech, not just the aria-hidden tag", (state, word) => {
      const { container } = render(<StatusLine state={state}>connected</StatusLine>);
      const srWord = container.querySelector(".mw-status > .sr-only");
      expect(srWord).not.toBeNull();
      expect(srWord).toHaveTextContent(`${word}:`);
      expect(srWord).not.toHaveAttribute("aria-hidden");
    });
});
