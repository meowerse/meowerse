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

// Exposes retry() unconditionally (unlike View2, which only offers it from the
// error state) so a test can call retry() while the first load is still pending.
function View3({ base }: { base: string }) {
  const s = useSession(base);
  const label = s.loading ? "loading" : s.authenticated ? `hi ${s.username}` : s.error ? `error ${s.error}` : "guest";
  return (
    <div>
      <div>{label}</div>
      <button onClick={s.retry}>retry</button>
    </div>
  );
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

  it("a stale load resolving after a retry's newer load never broadcasts (race)", async () => {
    // Control resolution order explicitly: the first (stale) request resolves
    // with "guest" only after the second (fresh, retry-triggered) request has
    // resolved with an authenticated user. If the identity check in `runLoad`
    // is missing, the stale "guest" result broadcasts last and wins.
    const resolvers: Array<(r: Response) => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve as (r: Response) => void)));
    render(
      <>
        <View3 base="https://api" />
        <View3 base="https://api" />
      </>,
    );
    await waitFor(() => expect(resolvers).toHaveLength(1));

    // Both islands share one in-flight load; retry from one clears it and starts
    // a second, newer load before the first has resolved.
    const retryButtons = screen.getAllByRole("button", { name: "retry" });
    retryButtons[0]!.click();
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // Resolve the stale (first) request, then the fresh (second) one.
    resolvers[0]!(new Response(JSON.stringify({ authenticated: false }), { status: 401 }));
    resolvers[1]!(new Response(JSON.stringify({ authenticated: true, username: "alex", verified: true }), { status: 200 }));

    const messages = await screen.findAllByText("hi alex");
    expect(messages).toHaveLength(2);
    // The stale "guest" result must never have been shown, even transiently.
    expect(screen.queryAllByText("guest")).toHaveLength(0);
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
