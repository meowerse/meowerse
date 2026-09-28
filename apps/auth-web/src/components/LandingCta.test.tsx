// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionCache } from "@meowerse/ui";
import LandingCta from "./LandingCta";

beforeEach(() => {
  sessionStorage.clear();
  clearSessionCache();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LandingCta", () => {
  it("renders a zero-CLS placeholder while session is loading", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const { container } = render(<LandingCta base="https://api" />);
    const busyDiv = container.querySelector('[aria-busy="true"]');
    expect(busyDiv).not.toBeNull();
  });

  it("shows guest buttons when unauthenticated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<LandingCta base="https://api" />);
    expect(await screen.findByText("create account")).not.toBeNull();
    expect(screen.getByText("sign in")).not.toBeNull();
  });

  it("shows account button when authenticated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, username: "cat" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<LandingCta base="https://api" />);
    expect(await screen.findByText("go to your account")).not.toBeNull();
  });
});
