// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindDemoIslands, DEMO_FAILED } from "./demo-islands";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

/** The markup DemoIsland.astro renders around one island (StatusLine's live wait line inside). */
function shell(hydrated = false): HTMLElement {
  const s = document.createElement("div");
  s.setAttribute("data-demo", "");
  const stage = document.createElement("div");
  stage.setAttribute("data-demo-stage", "");
  stage.setAttribute("inert", "");
  const island = document.createElement("astro-island");
  if (!hydrated) island.setAttribute("ssr", "");
  const btn = document.createElement("button");
  btn.textContent = "rename chat";
  island.append(btn);
  stage.append(island);
  const wait = document.createElement("div");
  wait.setAttribute("data-demo-wait", "");
  wait.hidden = true;
  const p = document.createElement("p");
  p.className = "mw-status mw-status--wait";
  for (const c of ["mw-status__tag", "sr-only", "mw-status__text"]) { const x = document.createElement("span"); x.className = c; p.append(x); }
  wait.append(p);
  s.append(stage, wait);
  document.body.append(s);
  return s;
}
const stageOf = (s: HTMLElement) => s.querySelector("[data-demo-stage]")!;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("bindDemoIslands (B9: a demo never looks ready while it can't respond)", () => {
  it("while the island is still server-rendered: the stage stays inert and the wait line is revealed", () => {
    const s = shell();
    bindDemoIslands();
    expect(stageOf(s).hasAttribute("inert")).toBe(true);
    expect(s.querySelector<HTMLElement>("[data-demo-wait]")!.hidden).toBe(false);
    expect(s.hasAttribute("data-ready")).toBe(false);
  });
  it("once Astro drops `ssr` (hydrated): the stage turns live and the wait line goes", async () => {
    const s = shell();
    bindDemoIslands();
    s.querySelector("astro-island")!.removeAttribute("ssr");
    await tick();
    expect(stageOf(s).hasAttribute("inert")).toBe(false);
    expect(s.querySelector("[data-demo-wait]")).toBeNull();
    expect(s.hasAttribute("data-ready")).toBe(true);
  });
  it("an island that hydrated before the script ran is made live straight away", () => {
    const s = shell(true);
    bindDemoIslands();
    expect(stageOf(s).hasAttribute("inert")).toBe(false);
    expect(s.querySelector("[data-demo-wait]")).toBeNull();
  });
  it("a chunk that never arrives: the wait turns into a plain error with a reload control, and the stage stays inert", () => {
    vi.useFakeTimers();
    const s = shell();
    const reload = vi.fn();
    bindDemoIslands(document, { timeoutMs: 100, reload });
    vi.advanceTimersByTime(100);
    expect(s.querySelector(".mw-status")!.className).toContain("mw-status--fail");
    expect(s.querySelector(".mw-status__text")!.textContent).toBe(DEMO_FAILED);
    s.querySelector<HTMLButtonElement>(".mw-status__action button")!.click();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(stageOf(s).hasAttribute("inert")).toBe(true);
  });
  it("the clock starts only when the demo is on screen (client:visible loads it then)", () => {
    vi.useFakeTimers();
    let fire: IntersectionObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class { constructor(cb: IntersectionObserverCallback) { fire = cb; } observe() {} disconnect = disconnect; });
    const s = shell();
    bindDemoIslands(document, { timeoutMs: 100 });
    vi.advanceTimersByTime(1_000);
    expect(s.querySelector(".mw-status")!.className).toContain("mw-status--wait");
    fire([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    vi.advanceTimersByTime(1_000);
    expect(s.querySelector(".mw-status")!.className).toContain("mw-status--wait");
    fire([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(disconnect).toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(s.querySelector(".mw-status")!.className).toContain("mw-status--fail");
  });
  it("hydrating after the watchdog started cancels it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = shell();
    bindDemoIslands(document, { timeoutMs: 100 });
    s.querySelector("astro-island")!.removeAttribute("ssr");
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    expect(s.hasAttribute("data-ready")).toBe(true);
    expect(s.querySelector(".mw-status--fail")).toBeNull();
  });
  it("binds each demo once, and skips markup without a stage", () => {
    const s = shell();
    const bare = document.createElement("div");
    bare.setAttribute("data-demo", "");
    document.body.append(bare);
    bindDemoIslands();
    bindDemoIslands();
    expect(s.dataset.bound).toBe("1");
    expect(bare.dataset.bound).toBeUndefined();
  });
});
