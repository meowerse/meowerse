import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, request } from "./request";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("request", () => {
  it("returns data on 2xx and always sends credentials", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ a: 1 }));
    await expect(request<{ a: number }>("https://x/y")).resolves.toEqual({ ok: true, status: 200, data: { a: 1 } });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
  });
  it("204 gives data null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(request("https://x")).resolves.toEqual({ ok: true, status: 204, data: null });
  });
  it("401 is unauthorized, not a generic error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "no" }, 401));
    await expect(request("https://x")).resolves.toEqual({ ok: false, error: { kind: "unauthorized", status: 401 } });
  });
  it("5xx keeps status and body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "boom" }, 503));
    await expect(request("https://x")).resolves.toEqual({ ok: false, error: { kind: "http", status: 503, body: { error: "boom" } } });
  });
  it("a rejected fetch is network", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(request("https://x")).resolves.toEqual({ ok: false, error: { kind: "network" } });
  });
  it("bad JSON on 2xx is parse", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(request("https://x")).resolves.toEqual({ ok: false, error: { kind: "parse" } });
  });
  it("times out and aborts the fetch", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_, rej) => signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    });
    const p = request("https://x", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(51);
    await expect(p).resolves.toEqual({ ok: false, error: { kind: "timeout" } });
    expect(signal?.aborted).toBe(true);
  });
  it("a caller abort is reported as network and not retried", async () => {
    const ac = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new DOMException("aborted", "AbortError")));
    ac.abort();
    await expect(request("https://x", { signal: ac.signal })).resolves.toEqual({ ok: false, error: { kind: "network" } });
  });
  it("describeError is plain language for every kind", () => {
    expect(describeError({ kind: "timeout" })).toBe("the server took too long to answer. try again.");
    expect(describeError({ kind: "network" })).toBe("can't reach the server. check your connection and try again.");
    expect(describeError({ kind: "unauthorized", status: 401 })).toBe("your session has ended. sign in again.");
    expect(describeError({ kind: "http", status: 429, body: null })).toBe("too many tries. wait a minute and try again.");
    expect(describeError({ kind: "http", status: 500, body: null })).toBe("something went wrong on our side. try again.");
    expect(describeError({ kind: "http", status: 400, body: { message: "name taken" } })).toBe("name taken");
    expect(describeError({ kind: "http", status: 404, body: null })).toBe("not found.");
    expect(describeError({ kind: "parse" })).toBe("the server sent an unexpected answer. try again.");
  });
});
