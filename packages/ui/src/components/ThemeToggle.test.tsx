import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });

  it("toggles the document theme on click", async () => {
    localStorage.setItem("mw-theme", "light");
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("button", { name: "switch to dark theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("mounts showing 'switch to light theme' with no stored choice and non-light matchMedia", () => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
    render(<ThemeToggle />);
    // Verify aria-label and icon indicate dark state (sun icon to switch to light)
    expect(screen.getByRole("button", { name: "switch to light theme" })).toBeInTheDocument();
    expect(screen.getByRole("button").querySelector('[data-icon="sun"]')).toBeInTheDocument();
  });

  it("shows 'switch to dark theme' after effect with light system preference", async () => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-color-scheme: light)", media: q }));
    render(<ThemeToggle />);
    // After effect runs, should show light state (moon icon to switch to dark)
    const button = await screen.findByRole("button", { name: "switch to dark theme" });
    expect(button).toBeInTheDocument();
    expect(button.querySelector('[data-icon="moon"]')).toBeInTheDocument();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
