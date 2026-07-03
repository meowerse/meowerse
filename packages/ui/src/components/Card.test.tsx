import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
  it("renders a titled region with children", () => {
    render(<Card title="connected apps">body</Card>);
    expect(screen.getByRole("region", { name: "connected apps" })).toHaveTextContent("body");
  });
  it("renders plain card without title", () => {
    render(<Card className="x">bare</Card>);
    expect(screen.getByText("bare").closest(".mw-card")).toHaveClass("x");
  });
});
