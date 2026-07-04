import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession, clearSessionCache } from "./useSession";

function View({ base }: { base: string }) {
  const s = useSession(base);
  return <div>{s.loading ? "loading" : s.authenticated ? `hi ${s.username}` : "guest"}</div>;
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

  it("reports guest on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    render(<View base="https://api" />);
    await waitFor(() => expect(screen.getByText("guest")).toBeInTheDocument());
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
