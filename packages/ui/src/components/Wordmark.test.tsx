import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Wordmark } from "./Wordmark";
describe("Wordmark", () => {
  it("renders name_ with an aria-hidden cursor and an accessible name", () => {
    render(<Wordmark name="meowsenger" href="/" />);
    const link = screen.getByRole("link", { name: "meowsenger home" });
    expect(link).toHaveTextContent("meowsenger_");
    expect(link.querySelector(".mw-cursor")).toHaveAttribute("aria-hidden", "true");
  });
  it("renders a span without href", () => {
    const { container } = render(<Wordmark name="auth" />);
    expect(container.querySelector("span.mw-wordmark")).toHaveTextContent("auth_");
  });
});
