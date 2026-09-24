import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./AuthGate";
import { clearSessionCache } from "../lib/useSession";

beforeEach(() => {
  sessionStorage.clear();
  clearSessionCache();
});
afterEach(() => vi.restoreAllMocks());

describe("AuthGate", () => {
  it("renders children when authenticated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, username: "a", verified: false }), { status: 200 }));
    render(<AuthGate base="https://api"><p>secret</p></AuthGate>);
    expect(await screen.findByText("secret")).toBeInTheDocument();
  });
  it("redirects a guest to login with next", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }), { status: 200 }));
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      value: { pathname: "/account", replace }, writable: true,
    });
    render(<AuthGate base="https://api"><p>secret</p></AuthGate>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?next=%2Faccount"));
    expect(screen.queryByText("secret")).toBeNull();
  });
  it("on a network error shows a reason and retry — never redirects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("down"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, username: "a", verified: false }), { status: 200 }));
    const replace = vi.fn();
    Object.defineProperty(window, "location", { value: { pathname: "/account", replace }, writable: true });
    render(<AuthGate base="https://api"><p>secret</p></AuthGate>);
    expect(await screen.findByRole("alert")).toHaveTextContent("can't reach the account service");
    expect(replace).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "try again" }));
    expect(await screen.findByText("secret")).toBeInTheDocument();
  });
  it("on a 5xx it shows the service-had-a-problem copy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 502 }));
    render(<AuthGate base="https://api"><p>secret</p></AuthGate>);
    expect(await screen.findByRole("alert")).toHaveTextContent("the account service had a problem");
  });
  it("on a timeout it shows the too-slow copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
      new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(new DOMException("a", "AbortError")))));
    render(<AuthGate base="https://api"><p>secret</p></AuthGate>);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await screen.findByRole("alert")).toHaveTextContent("the account service is taking too long");
    vi.useRealTimers();
  });
});
