import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, getTheme, toggleTheme, THEME_INIT_SCRIPT } from "./theme";

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
});
