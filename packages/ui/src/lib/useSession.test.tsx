import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSession } from "./useSession";

function View({ base }: { base: string }) {
  const s = useSession(base);
  return <div>{s.loading ? "loading" : s.authenticated ? `hi ${s.username}` : "guest"}</div>;
}

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
});
