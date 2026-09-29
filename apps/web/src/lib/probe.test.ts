import { describe, expect, it, vi } from "vitest";
import { describeProbe, probe, PROBE_TIMEOUT_MS } from "./probe";

const ok = (status = 200) => vi.fn(async () => ({ ok: status < 400, status, body: null }) as unknown as Response);

describe("probe", () => {
  it("asks with CORS, no credentials, no cache, and times the answer", async () => {
    const f = ok();
    let t = 100;
    const r = await probe("https://x.example/health", { fetchImpl: f, now: () => (t += 42) });
    expect(r).toEqual({ state: "up", ms: 42 });
    expect(f).toHaveBeenCalledWith("https://x.example/health", expect.objectContaining({
      method: "GET", mode: "cors", credentials: "omit", cache: "no-store", signal: expect.any(AbortSignal),
    }));
  });
  it("an error answer is down, with its status", async () =>
    expect(await probe("u", { fetchImpl: ok(503), method: "HEAD" })).toEqual({ state: "down", status: 503 }));
  it("no answer in time is unknown (timeout), not down", async () => {
    const hang = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    expect(await probe("u", { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 10 })).toEqual({ state: "unknown", reason: "timeout" });
  });
  it("a network or CORS failure is unknown (network)", async () =>
    expect(await probe("u", { fetchImpl: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) }))
      .toEqual({ state: "unknown", reason: "network" }));
  it("describes every outcome in plain words (B9)", () => {
    expect(PROBE_TIMEOUT_MS).toBe(5000);
    expect(describeProbe("auth", "pending")).toEqual({ state: "wait", text: "auth — checking…" });
    expect(describeProbe("auth", { state: "up", ms: 0.4 })).toEqual({ state: "ok", text: "auth — up · 1 ms" });
    expect(describeProbe("auth", { state: "down", status: 502 })).toEqual({ state: "fail", text: "auth — down · answered 502" });
    expect(describeProbe("auth", { state: "unknown", reason: "timeout" })).toEqual({ state: "info", text: "auth — unknown · no answer in 5 s" });
    expect(describeProbe("auth", { state: "unknown", reason: "network" })).toEqual({ state: "info", text: "auth — unknown · couldn't reach it from here" });
  });
});
