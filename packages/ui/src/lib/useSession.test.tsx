import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession, clearSessionCache } from "./useSession";

function View({ base }: { base: string }) {
  const s = useSession(base);
  return <div>{s.loading ? "loading" : s.authenticated ? `hi ${s.username}` : "guest"}</div>;
}

function View2({ base }: { base: string }) {
  const s = useSession(base);
  if (s.loading) return <div>loading</div>;
  if (s.authenticated) return <div>hi {s.username}</div>;
  if (s.error) return <button onClick={s.retry}>error {s.error}</button>;
  return <div>guest</div>;
}

beforeEach(() => {
  sessionStorage.clear();
  clearSessionCache();
});
afterEach(() => vi.restoreAllMocks());

describe("useSession", () => {
  it("reports authenticated + username from /api/session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, username: "alex", verified: true }), { status: 200 }));
    render(<View base="https://api" />);
    expect(await screen.findByText("hi alex")).toBeInTheDocument();
  });

  it("a network error is an error, not signed-out, and is not cached", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("down"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, username: "alex", verified: true }), { status: 200 }));
    render(<View2 base="https://api" />);
    const btn = await screen.findByRole("button", { name: "error network" });
    expect(sessionStorage.getItem("mw-session")).toBeNull();
    btn.click();
    expect(await screen.findByText("hi alex")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a 5xx is error server", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 502 }));
    render(<View2 base="https://api" />);
    expect(await screen.findByRole("button", { name: "error server" })).toBeInTheDocument();
  });

  it("a 401 is signed out", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    render(<View2 base="https://api" />);
    expect(await screen.findByText("guest")).toBeInTheDocument();
  });

  it("a hung request becomes error timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
      new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(new DOMException("a", "AbortError")))));
    render(<View2 base="https://api" />);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await screen.findByRole("button", { name: "error timeout" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("retry from one island broadcasts to every mounted useSession instance", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("down"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, username: "alex", verified: true }), { status: 200 }));
    render(
      <>
        <View2 base="https://api" />
        <View2 base="https://api" />
      </>,
    );
    const buttons = await screen.findAllByRole("button", { name: "error network" });
    expect(buttons).toHaveLength(2);
    buttons[0]!.click();
    const messages = await screen.findAllByText("hi alex");
    expect(messages).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a bfcache restore drops the cache", () => {
    sessionStorage.setItem("mw-session", JSON.stringify({ at: Date.now(), data: { loading: false, authenticated: false } }));
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(sessionStorage.getItem("mw-session")).toBeNull();
  });

  it("serves a cached session on the next mount without refetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, username: "cached", verified: false }), { status: 200 }));
    const first = render(<View base="https://api" />);
    await screen.findByText("hi cached");
    first.unmount();
    spy.mockClear();
    render(<View base="https://api" />);
    // second mount applies the cache in its effect — no new fetch
    expect(await screen.findByText("hi cached")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});
