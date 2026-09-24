import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Cursor } from "./Cursor";
describe("Cursor", () => {
  it("is decorative and blinks by default", () => {
    const { container } = render(<Cursor />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstChild).toHaveClass("mw-cursor--blink");
  });
  it("can be static", () => {
    const { container } = render(<Cursor blink={false} />);
    expect(container.firstChild).not.toHaveClass("mw-cursor--blink");
  });
});
