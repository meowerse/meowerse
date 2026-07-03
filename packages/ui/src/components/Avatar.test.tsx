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
});
