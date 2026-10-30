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
  it("opens absolute links in a new tab without opener or referrer; site paths stay in the tab", () => {
    render(<Footer links={[{ label: "privacy", href: "https://auth.alxnko.dev/privacy" }, { label: "home", href: "/" }]} />);
    const ext = screen.getByRole("link", { name: "privacy" });
    expect(ext).toHaveAttribute("target", "_blank");
    expect(ext).toHaveAttribute("rel", "noopener noreferrer");
    const own = screen.getByRole("link", { name: "home" });
    expect(own).not.toHaveAttribute("target");
    expect(own).not.toHaveAttribute("rel");
  });
});
