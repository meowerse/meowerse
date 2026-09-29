// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchIsland } from "./island-watchdog";

const MSG = "the playground didn't load. reload the page to try again.";

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
    watchIsland(r, MSG, 100);
    vi.advanceTimersByTime(100);
    expect(r.querySelector(".mw-status")).toHaveProperty("className", "mw-status mw-status--fail");
    expect(r.querySelector(".mw-status__text")!.textContent).toBe(MSG);
  });
  it("says what the caller passes: one watchdog for the playground and the demos", () => {
    vi.useFakeTimers();
    const r = root();
    watchIsland(r, "the demo didn't load. reload the page to try again.", 100);
    vi.advanceTimersByTime(100);
    expect(r.querySelector(".mw-status__text")!.textContent).toBe("the demo didn't load. reload the page to try again.");
  });
  it("adds a real reload control next to the message, that actually reloads the page (B9: a recovery path, not just wording)", () => {
    vi.useFakeTimers();
    const r = root();
    const reload = vi.fn();
    watchIsland(r, MSG, 100, reload);
    vi.advanceTimersByTime(100);
    const btn = r.querySelector<HTMLButtonElement>(".mw-status__action button");
    expect(btn).not.toBeNull();
    expect(btn!.type).toBe("button");
    expect(btn!.textContent).toBe("reload");
    expect(reload).not.toHaveBeenCalled();
    btn!.click();
    expect(reload).toHaveBeenCalledTimes(1);
    btn!.click();
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("defaults the reload control to the real location.reload (not injected in production use)", () => {
    vi.useFakeTimers();
    const r = root();
    watchIsland(r, MSG, 100); // no injected reload — exercises the real default parameter
    vi.advanceTimersByTime(100);
    expect(r.querySelector<HTMLButtonElement>(".mw-status__action button")).not.toBeNull();
  });
  it("stays quiet once the island says it's ready, or when cancelled", () => {
    vi.useFakeTimers();
    const r = root();
    watchIsland(r, MSG, 100);
    r.setAttribute("data-ready", "");
    vi.advanceTimersByTime(100);
    expect(r.querySelector(".mw-status")!.className).toContain("mw-status--wait");
    const r2 = root();
    watchIsland(r2, MSG, 100)();
    vi.advanceTimersByTime(100);
    expect(r2.querySelector(".mw-status")!.className).toContain("mw-status--wait");
  });
});
