// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindThemeButtons, themeLabel } from "./theme-button";

const button = () => {
  const b = document.createElement("button");
  b.setAttribute("data-theme-button", "");
  document.body.append(b);
  return b;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("theme button", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); document.body.replaceChildren(); });
  afterEach(() => vi.restoreAllMocks());

  it("labels the action, not the state", () => {
    expect(themeLabel("dark")).toBe("switch to light theme");
    expect(themeLabel("light")).toBe("switch to dark theme");
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
  it("does nothing without buttons", () => expect(() => bindThemeButtons(document)).not.toThrow());
});
