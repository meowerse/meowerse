// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindThemeButtons, themeLabel } from "./theme-button";

const button = () => {
  const b = document.createElement("button");
  b.setAttribute("data-theme-button", "");
  b.hidden = true; // as ThemeButton.astro renders it
  document.body.append(b);
  return b;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("theme button", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); document.body.replaceChildren(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("labels the action, not the state", () => {
    expect(themeLabel("dark")).toBe("switch to light theme");
    expect(themeLabel("light")).toBe("switch to dark theme");
  });
  it("is hidden until bound (it does nothing without JS), then revealed", () => {
    const b = button();
    expect(b.hidden).toBe(true);
    bindThemeButtons(document);
    expect(b.hidden).toBe(false);
  });
  it("starts from the resolved theme (dark by default), toggles and persists", async () => {
    const b = button();
    bindThemeButtons(document);
    expect(b.getAttribute("aria-label")).toBe("switch to light theme");
    b.click();
    await tick();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("mw-theme")).toBe("light");
    expect(b.getAttribute("aria-label")).toBe("switch to dark theme");
  });
  it("follows another tab's choice", async () => {
    const b = button();
    bindThemeButtons(document);
    dispatchEvent(new StorageEvent("storage", { key: "mw-theme", newValue: "light" }));
    await tick();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(b.getAttribute("aria-label")).toBe("switch to dark theme");
    dispatchEvent(new StorageEvent("storage", { key: "mw-theme", newValue: null }));
    await tick();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
  it("still flips the page when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const b = button();
    bindThemeButtons(document);
    b.click();
    await tick();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.classList.contains("mw-no-transitions")).toBe(false);
    expect(b.getAttribute("aria-label")).toBe("switch to dark theme");
  });
  // Fix round 1 (Important): jsdom never defines matchMedia, so — without stubbing it, the same way
  // packages/ui/src/lib/theme.test.ts does — current()'s own system-preference fallback (reached
  // only once resolvedTheme() itself throws), the OS change listener, the light→dark click branch
  // and the unrelated-storage-key early return are never exercised.
  it("falls back to the system preference (light) when storage is blocked", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-color-scheme: light)", media: q }));
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const b = button();
    bindThemeButtons(document);
    // resolvedTheme() threw (storage blocked), so current() falls back to matchMedia: the system
    // prefers light, so the button offers to switch to dark.
    expect(b.getAttribute("aria-label")).toBe("switch to dark theme");
  });
  it("still flips the page — light to dark — when storage is blocked", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const b = button();
    bindThemeButtons(document);
    b.click();
    await tick();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(b.getAttribute("aria-label")).toBe("switch to light theme");
  });
  it("updates the button when the OS colour scheme changes and the page has no explicit theme", async () => {
    let systemPrefersLight = false;
    let onChange: (() => void) | undefined;
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: systemPrefersLight,
      media: q,
      addEventListener: (_type: string, cb: () => void) => { onChange = cb; },
    }));
    const b = button();
    bindThemeButtons(document);
    expect(b.getAttribute("aria-label")).toBe("switch to light theme");
    systemPrefersLight = true;
    onChange?.();
    await tick();
    expect(b.getAttribute("aria-label")).toBe("switch to dark theme");
  });
  it("ignores a storage event for an unrelated key", async () => {
    const b = button();
    bindThemeButtons(document);
    dispatchEvent(new StorageEvent("storage", { key: "some-other-key", newValue: "light" }));
    await tick();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(b.getAttribute("aria-label")).toBe("switch to light theme");
  });
  it("does nothing without buttons", () => expect(() => bindThemeButtons(document)).not.toThrow());
});
