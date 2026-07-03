import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContactLinks, DEFAULT_CONTACTS } from "./ContactLinks";

describe("ContactLinks", () => {
  it("renders one labelled link per default contact", () => {
    render(<ContactLinks />);
    expect(screen.getByRole("link", { name: /telegram/i })).toHaveAttribute("href", "https://t.me/ALXNK0");
    expect(screen.getAllByRole("link")).toHaveLength(DEFAULT_CONTACTS.length);
  });
});
