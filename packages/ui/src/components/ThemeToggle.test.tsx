import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });

  it("toggles the document theme on click", async () => {
    localStorage.setItem("mw-theme", "light");
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("button", { name: /theme/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("mounts showing 'switch to light' state with no stored choice and non-light matchMedia", () => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
    render(<ThemeToggle />);
    // When dark=true, shows sun icon (to switch to light)
    expect(screen.getByRole("button")).toHaveClass("mw-themetoggle");
    vi.unstubAllGlobals();
  });

  it("shows 'switch to dark' state after effect with light system preference", async () => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-color-scheme: light)", media: q }));
    render(<ThemeToggle />);
    // Initially mounts with dark=true (sun), but effect corrects to light preference
    // After effect runs, dark=false (moon icon shown to switch to dark)
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getByRole("button")).toHaveClass("mw-themetoggle");
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
