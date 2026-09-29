import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  it("shows uppercase initials from the name but keeps an accessible label", () => {
    render(<Avatar name="meow_alex" />);
    const el = screen.getByLabelText("meow_alex");
    expect(el).toHaveTextContent("M");
  });
  it("applies size", () => {
    render(<Avatar name="ab" size="lg" />);
    expect(screen.getByLabelText("ab").className).toContain("mw-avatar--lg");
  });
  it("is an image named by the person (a label on a generic span is prohibited, U-15)", () => {
    render(<Avatar name="Cats & Co" />);
    expect(screen.getByRole("img", { name: "Cats & Co" })).toHaveTextContent("C");
  });
  it("decorative: hidden from assistive tech, for when the name is already shown next to it", () => {
    const { container } = render(<p><Avatar name="alex" decorative /> alex</p>);
    expect(screen.queryByRole("img")).toBeNull();
    const el = container.querySelector(".mw-avatar")!;
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el).not.toHaveAttribute("aria-label");
    expect(el).toHaveTextContent("A");
  });
});
