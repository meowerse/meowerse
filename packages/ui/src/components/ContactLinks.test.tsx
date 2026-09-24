import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContactLinks, DEFAULT_CONTACTS } from "./ContactLinks";

describe("ContactLinks", () => {
  it("renders one labelled link per default contact", () => {
    render(<ContactLinks />);
    expect(screen.getByRole("link", { name: /telegram/i })).toHaveAttribute("href", "https://t.me/ALXNK0");
    expect(screen.getAllByRole("link")).toHaveLength(DEFAULT_CONTACTS.length);
  });
  // F9: external links say so in their accessible name, without adding visible text; mailto: (not
  // external) never gets a target and never gets the "(opens in a new tab)" suffix.
  it("external links get an sr-only \"(opens in a new tab)\" in their accessible name; mailto doesn't", () => {
    render(<ContactLinks />);
    const telegram = screen.getByRole("link", { name: /telegram \(opens in a new tab\)/i });
    expect(telegram).toHaveAttribute("target", "_blank");
    expect(telegram).toHaveAttribute("rel", "noreferrer noopener");
    const email = screen.getByRole("link", { name: "email" });
    expect(email).not.toHaveAttribute("target");
    expect(email.getAttribute("aria-label") ?? email.textContent).not.toMatch(/opens in a new tab/i);
  });
});
