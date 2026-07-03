import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("renders variant + size classes and children", () => {
    render(<Button variant="danger" size="sm">revoke</Button>);
    const b = screen.getByRole("button", { name: "revoke" });
    expect(b.className).toContain("mw-btn--danger");
    expect(b.className).toContain("mw-btn--sm");
  });
  it("loading disables and shows a status indicator", () => {
    render(<Button loading>save</Button>);
    const b = screen.getByRole("button");
    expect(b).toBeDisabled();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
  it("fires onClick when enabled", async () => {
    const fn = vi.fn();
    render(<Button onClick={fn}>go</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(fn).toHaveBeenCalledOnce();
  });
});
