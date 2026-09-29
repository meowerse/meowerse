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
  // T11 review: an Astro page nested <Button slot="..."> inside another framework component (Astro
  // slot syntax doesn't apply to framework children), and it landed on the native <button> as a
  // meaningless DOM attribute. `slot` isn't a real prop here — it must never be forwarded.
  it("never forwards a stray `slot` attribute to the native button", () => {
    render(<Button slot="action">try again</Button>);
    expect(screen.getByRole("button")).not.toHaveAttribute("slot");
  });
});
