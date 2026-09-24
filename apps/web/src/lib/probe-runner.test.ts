// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  it("shows a wait state, then each result; the retry button appears and is busy while running", async () => {
    const p = page();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async (url: string) => { await gate; return { ok: !url.includes("b."), status: url.includes("b.") ? 500 : 200, body: null } as unknown as Response; });
    const done = runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(p.text(0)).toBe("auth — checking…");
    expect(p.retry.hidden).toBe(false);
    expect(p.retry.disabled).toBe(true);
    expect(p.retry.textContent).toBe("checking…");
    expect(p.retry.getAttribute("aria-busy")).toBe("true");
    release();
    await done;
    expect(p.text(0)).toMatch(/^auth — up · \d+ ms$/);
    expect(p.text(1)).toBe("chat — down · answered 500");
    expect(p.retry.disabled).toBe(false);
    expect(p.retry.textContent).toBe("check again");
    expect(p.retry.hasAttribute("aria-busy")).toBe(false);
  });
  it("check again runs them once more (a second click while running is ignored)", async () => {
    const p = page();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    await runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    p.retry.click();
    p.retry.click();
    await vi.waitFor(() => expect(p.retry.disabled).toBe(false));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
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
});
