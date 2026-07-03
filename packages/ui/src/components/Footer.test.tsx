import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Footer } from "./Footer";

describe("Footer", () => {
  it("renders legal + dev links and the contact block", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: "privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("navigation", { name: "contact" })).toBeInTheDocument();
  });
});
