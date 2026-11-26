/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, MockWebSocket } from "../test/rtl";
import { hasSessionEnded, notifySessionEnded, resetSessionEnded } from "../lib/sessionEnded";

const S = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../lib/meowsengerApi", async (importActual) => {
  const actual = await importActual<typeof import("../lib/meowsengerApi")>();
  return { ...actual, getSession: vi.fn(async () => { S.calls++; return { ok: false, error: { kind: "unauthorized" } }; }) };
});

import { useInbox } from "./useInbox";

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const inbox = () => MockWebSocket.inbox!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  S.calls = 0;
  resetSessionEnded();
});
afterEach(() => { vi.useRealTimers(); resetSessionEnded(); });

describe("useInbox link state", () => {
  it("connecting -> open -> down -> open", async () => {
    const { result } = renderHook(() => useInbox("", true, vi.fn()));
    expect(result.current).toBe("connecting");
    act(() => inbox().mockOpen());
    expect(result.current).toBe("open");
    act(() => inbox().mockDrop());
    expect(result.current).toBe("down");
    await tick(20000);
    act(() => inbox().mockOpen());
    expect(result.current).toBe("open");
  });
});

describe("useInbox link reset", () => {
  it("session end: open -> ended, down -> ended (never stays green / reconnecting)", () => {
    const a = renderHook(() => useInbox("", true, vi.fn()));
    act(() => inbox().mockOpen());
    act(() => notifySessionEnded());
    expect(a.result.current).toBe("ended");
    a.unmount();
    resetSessionEnded();
    const b = renderHook(() => useInbox("", true, vi.fn()));
    act(() => inbox().mockOpen());
    act(() => inbox().mockDrop());
    expect(b.result.current).toBe("down");
    act(() => notifySessionEnded());
    expect(b.result.current).toBe("ended");
  });

  it("disabled and base change reset the link to connecting", () => {
    const { result, rerender } = renderHook((p: { base: string; on: boolean }) => useInbox(p.base, p.on, vi.fn()), { initialProps: { base: "", on: true } });
    act(() => inbox().mockOpen());
    expect(result.current).toBe("open");
    rerender({ base: "", on: false });
    expect(result.current).toBe("connecting");
    rerender({ base: "", on: true });
    act(() => inbox().mockOpen());
    expect(result.current).toBe("open");
    rerender({ base: "https://other.test", on: true });
    expect(result.current).toBe("connecting");
  });
});

describe("useInbox reconnect", () => {
  it("one list refresh per reopen after a drop, never on the first open", async () => {
    const onReconnect = vi.fn();
    renderHook(() => useInbox("", true, vi.fn(), onReconnect));
    act(() => inbox().mockOpen());
    expect(onReconnect).not.toHaveBeenCalled();
    act(() => inbox().mockDrop());
    await tick(1000);
    act(() => inbox().mockOpen());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("a missing pong closes and reconnects", async () => {
    renderHook(() => useInbox("", true, vi.fn()));
    act(() => inbox().mockOpen());
    await tick(25_000);
    expect(inbox().pings()).toBe(1);
    await tick(10_000);
    await tick(1_000);
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it("stops after the session probe says unauthorized", async () => {
    renderHook(() => useInbox("", true, vi.fn()));
    act(() => inbox().mockDrop());
    await tick(1000);
    act(() => inbox().mockDrop());
    await tick();
    expect(S.calls).toBe(1);
    expect(hasSessionEnded()).toBe(true);
    const n = MockWebSocket.instances.length;
    await tick(120_000);
    expect(MockWebSocket.instances.length).toBe(n);
  });

  it("sessionEnded while connected stops it for good; a pong is consumed, not parsed", async () => {
    renderHook(() => useInbox("", true, vi.fn()));
    act(() => inbox().mockOpen());
    await tick(25_000);
    act(() => inbox().onmessage?.({ data: "pong" }));
    act(() => notifySessionEnded());
    await tick(60_000);
    act(() => window.dispatchEvent(new Event("online")));
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it("unmount cancels the pending reconnect", async () => {
    const h = renderHook(() => useInbox("", true, vi.fn()));
    act(() => inbox().mockDrop());
    h.unmount();
    await tick(10_000);
    expect(MockWebSocket.instances.length).toBe(1);
  });
});
