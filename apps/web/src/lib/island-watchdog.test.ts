// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchIsland } from "./island-watchdog";

afterEach(() => vi.useRealTimers());

function root() {
  const r = document.createElement("div");
  const p = document.createElement("p");
  p.className = "mw-status mw-status--wait";
  for (const c of ["mw-status__tag", "sr-only", "mw-status__text"]) { const s = document.createElement("span"); s.className = c; p.append(s); }
  r.append(p);
  return r;
}

describe("watchIsland (B9: a lazy chunk that never arrives)", () => {
  it("turns the wait into a plain error with a way out", () => {
    vi.useFakeTimers();
    const r = root();
    watchIsland(r, 100);
    vi.advanceTimersByTime(100);
    expect(r.querySelector(".mw-status")).toHaveProperty("className", "mw-status mw-status--fail");
    expect(r.querySelector(".mw-status__text")!.textContent).toBe("the playground didn't load. reload the page to try again.");
  });
  it("stays quiet once the island says it's ready, or when cancelled", () => {
    vi.useFakeTimers();
    const r = root();
    watchIsland(r, 100);
    r.setAttribute("data-ready", "");
    vi.advanceTimersByTime(100);
    expect(r.querySelector(".mw-status")!.className).toContain("mw-status--wait");
    const r2 = root();
    watchIsland(r2, 100)();
    vi.advanceTimersByTime(100);
    expect(r2.querySelector(".mw-status")!.className).toContain("mw-status--wait");
  });
});
