import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./Skeleton";

describe("Skeleton", () => {
  it("reserves the given box and is hidden from assistive tech", () => {
    const { container } = render(<Skeleton width={120} height="36px" className="x" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.style.width).toBe("120px");
    expect(el.style.height).toBe("36px");
    expect(el.className).toContain("mw-skeleton");
    expect(el.className).toContain("x");
  });
  it("renders no style attribute when no size is given (strict-CSP static pages size it with a class)", () => {
    const { container } = render(<Skeleton className="x" />);
    expect((container.firstElementChild as HTMLElement).hasAttribute("style")).toBe(false);
  });
});
