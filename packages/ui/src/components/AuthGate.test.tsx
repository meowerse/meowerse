import { render, screen, waitFor } from "@testing-library/react";
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
});
