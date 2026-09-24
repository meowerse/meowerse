// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProbes } from "./probe-runner";

function page() {
  const row = (name: string, url: string) => {
    const d = document.createElement("div");
    d.setAttribute("data-probe", "");
    d.dataset.name = name;
    d.dataset.url = url;
    d.dataset.method = "GET";
    const p = document.createElement("p");
    p.className = "mw-status mw-status--wait";
    for (const c of ["mw-status__tag", "sr-only", "mw-status__text"]) { const s = document.createElement("span"); s.className = c; p.append(s); }
    d.append(p);
    return d;
  };
  const retry = document.createElement("button");
  retry.setAttribute("data-probe-retry", "");
  retry.hidden = true;
  document.body.replaceChildren(row("auth", "https://a.example/"), row("chat", "https://b.example/"), retry);
  return { retry, text: (i: number) => document.querySelectorAll(".mw-status__text")[i]!.textContent };
}

describe("runProbes", () => {
  beforeEach(() => document.body.replaceChildren());
  afterEach(() => Object.defineProperty(document, "hidden", { value: false, configurable: true }));
  it("shows a wait state, then each result; the retry button appears and is busy while running", async () => {
    const p = page();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async (url: string) => { await gate; return { ok: !url.includes("b."), status: url.includes("b.") ? 500 : 200, body: null } as unknown as Response; });
    const done = runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(p.text(0)).toBe("auth — checking…");
    expect(p.retry.hidden).toBe(false);
    // aria-disabled, not the disabled attribute: a real `disabled` would drop focus from a button
    // the user just clicked, the moment it goes busy (B9/B26 — the control must stay operable).
    expect(p.retry.disabled).toBe(false);
    expect(p.retry.getAttribute("aria-disabled")).toBe("true");
    expect(p.retry.textContent).toBe("checking…");
    expect(p.retry.getAttribute("aria-busy")).toBe("true");
    release();
    await done;
    expect(p.text(0)).toMatch(/^auth — up · \d+ ms$/);
    expect(p.text(1)).toBe("chat — down · answered 500");
    expect(p.retry.hasAttribute("aria-disabled")).toBe(false);
    expect(p.retry.textContent).toBe("check again");
    expect(p.retry.hasAttribute("aria-busy")).toBe(false);
  });
  it("check again runs them once more (a second click while running is ignored)", async () => {
    const p = page();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    await runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    p.retry.click();
    p.retry.click();
    await vi.waitFor(() => expect(p.retry.hasAttribute("aria-disabled")).toBe(false));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("a click during a run doesn't lose the button's native disabled state or its focusability", async () => {
    const p = page();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => { await gate; return { ok: true, status: 200, body: null } as unknown as Response; });
    p.retry.focus();
    const done = runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(p.retry.disabled).toBe(false); // never the real attribute — focus can't be dropped by it
    expect(document.activeElement).toBe(p.retry);
    release();
    await done;
  });
  it("re-checks on a bfcache restore when watching", async () => {
    page();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    await runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch, watch: true });
    dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  });
  it("is a no-op on a page without probes", async () => {
    await expect(runProbes(document)).resolves.toBeUndefined();
  });
  it("defers the first run on a hidden tab until it becomes visible", async () => {
    const p = page();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    const done = runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled(); // no probe went out while the tab was hidden
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await done;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(p.text(0)).toMatch(/^auth — up · \d+ ms$/);
  });
  it("ignores a visibilitychange fired while the tab is still hidden", async () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    page();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    const done = runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    document.dispatchEvent(new Event("visibilitychange")); // still hidden: a spurious fire, ignored
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await done;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("skips a probe row with no .mw-status element instead of throwing", async () => {
    const d = document.createElement("div");
    d.setAttribute("data-probe", "");
    d.dataset.name = "broken";
    d.dataset.url = "https://c.example/";
    page();
    document.body.append(d);
    const fetchImpl = vi.fn(async (_url: string) => ({ ok: true, status: 200, body: null }) as unknown as Response);
    await runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // only the two rows that have a status line
    expect(fetchImpl.mock.calls.some((c) => c[0] === "https://c.example/")).toBe(false);
  });
  it("falls back to a generic name and an empty URL for a row with no data-name/data-url", async () => {
    const d = document.createElement("div");
    d.setAttribute("data-probe", "");
    const p = document.createElement("p");
    p.className = "mw-status mw-status--wait";
    for (const c of ["mw-status__tag", "sr-only", "mw-status__text"]) { const s = document.createElement("span"); s.className = c; p.append(s); }
    d.append(p);
    document.body.replaceChildren(d);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    await runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith("", expect.objectContaining({ method: "GET" }));
    expect(p.querySelector(".mw-status__text")!.textContent).toMatch(/^service — /);
  });
  it("sends HEAD when a row asks for it", async () => {
    const d = document.createElement("div");
    d.setAttribute("data-probe", "");
    d.dataset.name = "head-probe";
    d.dataset.url = "https://d.example/";
    d.dataset.method = "HEAD";
    const p = document.createElement("p");
    p.className = "mw-status mw-status--wait";
    for (const c of ["mw-status__tag", "sr-only", "mw-status__text"]) { const s = document.createElement("span"); s.className = c; p.append(s); }
    d.append(p);
    document.body.replaceChildren(d);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    await runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith("https://d.example/", expect.objectContaining({ method: "HEAD" }));
  });
  it("a non-persisted pageshow (a normal reload, not a bfcache restore) doesn't re-run", async () => {
    page();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    await runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch, watch: true });
    const before = fetchImpl.mock.calls.length;
    dispatchEvent(new Event("pageshow")); // persisted defaults to false on a plain navigation
    await Promise.resolve();
    expect(fetchImpl.mock.calls.length).toBe(before);
  });
});
