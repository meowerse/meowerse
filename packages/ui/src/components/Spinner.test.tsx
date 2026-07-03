import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
  it("renders an accessible busy indicator", () => {
    render(<Spinner label="loading account" />);
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("aria-label", "loading account");
  });
  it("applies size modifier + extra className", () => {
    render(<Spinner size="lg" className="x" />);
    expect(screen.getByRole("status").className).toContain("mw-spinner--lg");
    expect(screen.getByRole("status").className).toContain("x");
  });
});
