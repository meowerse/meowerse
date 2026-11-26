// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createListGate, watchResume } from "./chatList";

const deferred = <T,>() => { let res!: (v: T) => void; const p = new Promise<T>((r) => { res = r; }); return { p, res }; };
afterEach(() => vi.useRealTimers());

import { setScope, clearAll } from "./scope";

describe("createListGate", () => {
  it("soft requests inside the 10 s gap make 0 requests; after it, 1", async () => {
    let t = 0; const run = vi.fn(async () => [1]);
    const { request: req } = createListGate(run, { now: () => t });
    t = 9_999; expect(await req("soft")).toBeNull();
    t = 10_000; expect(await req("soft")).toEqual([1]);
    expect(run).toHaveBeenCalledTimes(1);
    t = 12_000; await req("soft");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("soft callers share the in-flight fetch (single-flight)", async () => {
    let t = 0; const d = deferred<number[]>(); const run = vi.fn(() => d.p);
    const { request: req } = createListGate(run, { now: () => t }); t = 20_000;
    const a = req("soft"), b = req("soft"); d.res([1]);
    expect(await a).toEqual([1]); expect(await b).toEqual([1]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("force ignores the gap: exactly one fetch; a burst while in flight adds ONE trailing fetch", async () => {
    const ds = [deferred<number[]>(), deferred<number[]>()]; let i = 0;
    const run = vi.fn(() => ds[i++].p);
    const { request: req } = createListGate(run, { now: () => 0 });
    const a = req("force"); const b = req("force"); const c = req("force");
    expect(run).toHaveBeenCalledTimes(1);
    ds[0].res([1]); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    ds[1].res([2]);
    expect(await a).toEqual([1]); expect(await b).toEqual([2]); expect(await c).toEqual([2]);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("a failure resolves null and does not wedge the gate", async () => {
    let t = 0; const run = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue([3]);
    const { request: req } = createListGate(run, { now: () => t });
    expect(await req("force")).toBeNull();
    t = 30_000; expect(await req("soft")).toEqual([3]);
  });
  it("I1: a force landing at ANY microtask depth after the fetch settles is never lost and adds exactly one fetch", async () => {
    for (let depth = 0; depth < 10; depth++) {
      let n = 0; const d = deferred<number[]>();
      const run = vi.fn(() => (n++ === 0 ? d.p : Promise.resolve([2])));
      const { request: req } = createListGate(run, { now: () => 0 });
      void req("force");
      let late!: Promise<number[] | null>;
      let chain: Promise<unknown> = d.p;
      for (let i = 0; i < depth; i++) chain = chain.then(() => undefined);
      chain = chain.then(() => { late = req("force"); });
      d.res([1]);
      await chain;
      expect(await late, `depth ${depth}`).toEqual([2]);
      await new Promise((r) => setTimeout(r, 0));
      expect(run, `depth ${depth}`).toHaveBeenCalledTimes(2); // no lost fetch, no stray extra one
    }
  });
  it("M1: a trailing fetch is quiet only if EVERY requester asked for quiet", async () => {
    const seen: boolean[] = []; const ds = [deferred<number[]>(), deferred<number[]>(), deferred<number[]>()]; let i = 0;
    const g = createListGate((q) => { seen.push(q); return ds[i++].p; }, { now: () => 0 });
    void g.request("force", true);
    void g.request("force", false); void g.request("force", true); // a quiet requester must not mute a loud one
    ds[0].res([1]); await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([true, false]);
    ds[1].res([2]);
    void g.request("force", true); void g.request("force", true);
    await new Promise((r) => setTimeout(r, 0)); ds[2].res([3]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([true, false, true]); // all-quiet burst stays quiet; the loud flag did not leak
  });
  it("M2: a trailing fetch queued before clearAll neither runs nor applies; dispose cancels it too", async () => {
    setScope("A");
    const d = deferred<number[]>(); const run = vi.fn(() => d.p);
    const g = createListGate(run, { now: () => 0 });
    void g.request("force");
    const queued = g.request("force");
    clearAll();
    d.res([1]);
    expect(await queued).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(1);
    setScope("B");
    const d2 = deferred<number[]>(); const run2 = vi.fn(() => d2.p);
    const g2 = createListGate(run2, { now: () => 0 });
    void g2.request("force"); const q2 = g2.request("force");
    g2.dispose(); d2.res([1]);
    expect(await q2).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(run2).toHaveBeenCalledTimes(1);
    clearAll();
  });
});

describe("watchResume", () => {
  it("focus + visibilitychange (+ rapid toggles) merge into ONE call after 250 ms; cleanup removes listeners", () => {
    vi.useFakeTimers();
    const cb = vi.fn(); const stop = watchResume(cb);
    window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(249); expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2); expect(cb).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus")); stop(); vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event("focus")); vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it("M3: hiding the tab during the debounce cancels the pending resume", async () => {
    const { setVisibility } = await import("../../test/rtl");
    vi.useFakeTimers();
    const cb = vi.fn(); const stop = watchResume(cb);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(100);
    setVisibility("hidden"); document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1000);
    setVisibility("visible");
    expect(cb).not.toHaveBeenCalled();
    stop();
  });
});
