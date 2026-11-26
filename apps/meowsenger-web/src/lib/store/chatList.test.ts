// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createListGate, watchResume } from "./chatList";

const deferred = <T,>() => { let res!: (v: T) => void; const p = new Promise<T>((r) => { res = r; }); return { p, res }; };
afterEach(() => vi.useRealTimers());

describe("createListGate", () => {
  it("soft requests inside the 10 s gap make 0 requests; after it, 1", async () => {
    let t = 0; const run = vi.fn(async () => [1]);
    const req = createListGate(run, { now: () => t });
    t = 9_999; expect(await req("soft")).toBeNull();
    t = 10_000; expect(await req("soft")).toEqual([1]);
    expect(run).toHaveBeenCalledTimes(1);
    t = 12_000; await req("soft");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("soft callers share the in-flight fetch (single-flight)", async () => {
    let t = 0; const d = deferred<number[]>(); const run = vi.fn(() => d.p);
    const req = createListGate(run, { now: () => t }); t = 20_000;
    const a = req("soft"), b = req("soft"); d.res([1]);
    expect(await a).toEqual([1]); expect(await b).toEqual([1]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("force ignores the gap: exactly one fetch; a burst while in flight adds ONE trailing fetch", async () => {
    const t = 0; const ds = [deferred<number[]>(), deferred<number[]>()]; let i = 0;
    const run = vi.fn(() => ds[i++].p);
    const req = createListGate(run, { now: () => t });
    const a = req("force"); req("force"); req("force");
    expect(run).toHaveBeenCalledTimes(1);
    ds[0].res([1]); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    ds[1].res([2]); expect(await a).toEqual([2]);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("a failure resolves null and does not wedge the gate", async () => {
    let t = 0; const run = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue([3]);
    const req = createListGate(run, { now: () => t });
    expect(await req("force")).toBeNull();
    t = 30_000; expect(await req("soft")).toEqual([3]);
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
});
