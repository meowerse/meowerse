import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("renders a known icon as an svg carrying data-icon + paths", () => {
    const { container } = render(<Icon name="check" />);
    const svg = container.querySelector("svg[data-icon='check']");
    expect(svg).toBeTruthy();
    expect(svg!.innerHTML).toContain("path");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
  it("renders nothing for an unknown icon name", () => {
    const { container } = render(<Icon name="definitely-not-an-icon" />);
    expect(container.querySelector("svg")).toBeNull();
  });
  it("becomes an accessible image when given a label", () => {
    render(<Icon name="check" label="done" />);
    expect(screen.getByRole("img", { name: "done" })).toBeTruthy();
  });
});
