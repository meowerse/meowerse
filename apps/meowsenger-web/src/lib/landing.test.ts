// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { appForward, armWarm, slowConnection, warmUrls } from "./landing";

describe("appForward", () => {
  it("forwards old chat deep links and hashes to /app/ keeping both", () => {
    expect(appForward({ search: "?chat=x&m=1", hash: "" })).toBe("/app/?chat=x&m=1");
    expect(appForward({ search: "?a=1&chat=x", hash: "#h" })).toBe("/app/?a=1&chat=x#h");
  });
  it("leaves a plain landing visit alone", () => {
    expect(appForward({ search: "", hash: "" })).toBeNull();
    expect(appForward({ search: "?utm=1", hash: "#" })).toBeNull();
    expect(appForward({ search: "", hash: "#chat" })).toBeNull();
    expect(appForward({ search: "?mychat=1", hash: "" })).toBeNull();
  });
});

describe("warmUrls / slowConnection", () => {
  it("keeps only same-origin hashed /_astro/*.js", () => {
    expect(warmUrls("/_astro/a.B1.js /api/me //evil.com/_astro/x.js https://x/_astro/a.js /_astro/../x.js /_astro/a.css /app/")).toEqual(["/_astro/a.B1.js"]);
    expect(warmUrls(null)).toEqual([]);
  });
  it("skips Save-Data and 2g", () => {
    expect(slowConnection({ saveData: true })).toBe(true);
    expect(slowConnection({ effectiveType: "2g" })).toBe(true);
    expect(slowConnection({ effectiveType: "slow-2g" })).toBe(true);
    expect(slowConnection({ effectiveType: "4g" })).toBe(false);
    expect(slowConnection(undefined)).toBe(false);
  });
});

describe("armWarm", () => {
  const mk = () => { document.head.innerHTML = ""; const a = document.createElement("a"); a.dataset.warm = "/_astro/a.js /_astro/b.js /api/x"; document.body.append(a); return a; };
  const ev = (a: HTMLElement, type: string, pointerType = "mouse") => a.dispatchEvent(Object.assign(new Event(type), { pointerType }));
  const links = () => [...document.head.querySelectorAll("link[rel=modulepreload]")].map((l) => l.getAttribute("href"));

  it("injects modulepreload once, after the delay, for allowlisted chunks only", () => {
    vi.useFakeTimers(); const a = mk(); armWarm(a);
    ev(a, "pointerenter"); vi.advanceTimersByTime(99); expect(links()).toEqual([]);
    vi.advanceTimersByTime(2); expect(links()).toEqual(["/_astro/a.js", "/_astro/b.js"]);
    ev(a, "pointerdown"); vi.advanceTimersByTime(500); expect(links()).toHaveLength(2);
    vi.useRealTimers();
  });
  it("a quick pass (leave) or a touch scroll (pointercancel) cancels", () => {
    vi.useFakeTimers(); const a = mk(); armWarm(a);
    ev(a, "pointerenter"); vi.advanceTimersByTime(50); ev(a, "pointerleave"); vi.advanceTimersByTime(500);
    ev(a, "pointerdown", "touch"); vi.advanceTimersByTime(50); ev(a, "pointercancel", "touch"); vi.advanceTimersByTime(500);
    ev(a, "pointerenter", "touch"); vi.advanceTimersByTime(500); // emulated hover from touch does not count
    expect(links()).toEqual([]);
    vi.useRealTimers();
  });
  it("does nothing on Save-Data", () => {
    vi.useFakeTimers(); const a = mk(); armWarm(a, { saveData: true }); ev(a, "pointerenter"); vi.advanceTimersByTime(500); expect(links()).toEqual([]); vi.useRealTimers();
  });
});
