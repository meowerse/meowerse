import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon, ICON_NAMES } from "./Icon";

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
  it("renders newly added chat and navigation icons", () => {
    const icons = ["settings", "search", "link", "dots", "plus", "trash", "edit", "message", "users", "user", "arrow-left", "send", "mood-smile", "broadcast", "reply", "forward", "refresh", "share"];
    for (const name of icons) {
      const { container } = render(<Icon name={name} />);
      expect(container.querySelector(`svg[data-icon='${name}']`)).toBeTruthy();
    }
  });
  it("draws its paths as <path> elements, never through innerHTML (Trusted Types, U-28)", () => {
    const { container } = render(<Icon name="sun" />);
    expect(container.querySelectorAll("svg[data-icon='sun'] > path")).toHaveLength(2);
  });
  it("ICON_NAMES lists exactly the icons it can draw", () => {
    expect(ICON_NAMES).toContain("send");
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(36);
    for (const name of ICON_NAMES) {
      const { container } = render(<Icon name={name} />);
      expect(container.querySelector("path"), name).not.toBeNull();
    }
  });
});
