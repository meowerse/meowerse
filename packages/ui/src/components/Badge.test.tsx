import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders verified variant with icon + text", () => {
    render(<Badge variant="verified" icon="rosette-discount-check">verified</Badge>);
    const b = screen.getByText("verified").closest(".mw-badge")!;
    expect(b.className).toContain("mw-badge--verified");
    expect(b.querySelector("i")).toHaveClass("ti-rosette-discount-check");
  });
  it("defaults to neutral", () => {
    render(<Badge>public</Badge>);
    expect(screen.getByText("public").closest(".mw-badge")!.className).toContain("mw-badge--neutral");
  });
});
