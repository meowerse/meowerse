import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
  it("renders a labeled checkbox and toggles", async () => {
    const fn = vi.fn();
    render(<Checkbox label="your username and avatar" onChange={fn} />);
    const box = screen.getByRole("checkbox", { name: "your username and avatar" });
    await userEvent.click(box);
    expect(fn).toHaveBeenCalled();
  });
  it("respects disabled", () => {
    render(<Checkbox label="openid" disabled checked readOnly />);
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
});
