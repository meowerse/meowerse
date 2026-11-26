/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "../test/rtl";
import { useConnectionIndicator, LINK_WAIT_MS, ROOM_WAIT_MS, type LinkState } from "./useConnectionIndicator";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

type P = { link: LinkState; room: boolean; net: boolean };
const setup = (p: P) => renderHook((q: P) => useConnectionIndicator(q.link, q.room, q.net), { initialProps: p });

describe("useConnectionIndicator", () => {
  it("never connected yet: neutral dot, not yellow", () => {
    const { result } = setup({ link: "connecting", room: false, net: true });
    expect(result.current.dot).toBe("idle");
  });

  it("a chat switch (room closes, link stays open) never shows wait or the room line under 800 ms", async () => {
    const { result, rerender } = setup({ link: "open", room: true, net: true });
    rerender({ link: "open", room: false, net: true });
    await tick(ROOM_WAIT_MS - 1);
    expect(result.current.dot).toBe("on");
    expect(result.current.roomJoining).toBe(false);
    rerender({ link: "open", room: true, net: true });
    await tick(LINK_WAIT_MS * 2);
    expect(result.current.roomJoining).toBe(false);
    expect(result.current.dot).toBe("on");
  });

  it("a slow room join shows the text line after 800 ms but the dot stays on", async () => {
    const { result } = setup({ link: "open", room: false, net: true });
    await tick(ROOM_WAIT_MS);
    expect(result.current.roomJoining).toBe(true);
    expect(result.current.dot).toBe("on");
    expect(result.current.label).toBe("connecting…");
  });

  it("a link blip under 1.5 s stays green; an outage over 1.5 s turns wait, recovery returns to on", async () => {
    const { result, rerender } = setup({ link: "open", room: true, net: true });
    rerender({ link: "down", room: true, net: true });
    await tick(LINK_WAIT_MS - 1);
    expect(result.current.dot).toBe("on");
    rerender({ link: "open", room: true, net: true });
    await tick(LINK_WAIT_MS * 2);
    expect(result.current.dot).toBe("on");
    rerender({ link: "down", room: true, net: true });
    await tick(LINK_WAIT_MS);
    expect(result.current.dot).toBe("wait");
    expect(result.current.label).toBe("reconnecting…");
    rerender({ link: "open", room: true, net: true });
    expect(result.current.dot).toBe("on");
  });

  it("offline renders off immediately", () => {
    const { result } = setup({ link: "open", room: true, net: false });
    expect(result.current.dot).toBe("off");
    expect(result.current.label).toBe("offline");
  });
});
