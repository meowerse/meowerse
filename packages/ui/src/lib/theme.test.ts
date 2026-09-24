import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, getTheme, resolvedTheme, toggleTheme, THEME_INIT_SCRIPT } from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to system when nothing stored", () => {
    expect(getTheme()).toBe("system");
  });

  it("applyTheme('dark') sets attribute + persists", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("mw-theme")).toBe("dark");
    expect(getTheme()).toBe("dark");
  });

  it("applyTheme('system') clears attribute + storage", () => {
    applyTheme("dark");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("mw-theme")).toBe(null);
  });

  it("toggleTheme flips light<->dark", () => {
    applyTheme("light");
    toggleTheme();
    expect(getTheme()).toBe("dark");
    toggleTheme();
    expect(getTheme()).toBe("light");
  });

  it("exports a non-empty init script string", () => {
    expect(typeof THEME_INIT_SCRIPT).toBe("string");
    expect(THEME_INIT_SCRIPT).toContain("data-theme");
  });

  it("resolvedTheme follows matchMedia when the stored theme is system", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-color-scheme: light)" }));
    expect(resolvedTheme()).toBe("light");
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false }));
    expect(resolvedTheme()).toBe("dark");
  });

  it("resolves to dark when there is no stored choice and no system light preference", () => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
    expect(resolvedTheme()).toBe("dark");
  });

  it("resolves to light only when the system prefers light", () => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-color-scheme: light)", media: q }));
    expect(resolvedTheme()).toBe("light");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
