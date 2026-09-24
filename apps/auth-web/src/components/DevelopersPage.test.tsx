// @vitest-environment jsdom
//
// auth-web has no existing component-rendering harness (its vitest config scopes
// coverage to src/lib/**, and every other test in this app is a pure fetch-mock
// test), so this file brings its own jsdom environment via the pragma above
// instead of changing the shared config. No @testing-library/jest-dom matchers
// are registered globally, so assertions below stick to plain existence checks
// (getByX throws if absent; queryByX + toBeNull for absence) instead of
// `.toBeInTheDocument()`.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionCache } from "@meowerse/ui";
import DevelopersPage from "./DevelopersPage";

beforeEach(() => {
  sessionStorage.clear();
  clearSessionCache();
});
// auth-web's vitest config doesn't set `test.globals: true`, so
// @testing-library/react's automatic afterEach(cleanup) (which detects the test
// framework via global hooks) never registers here — do it explicitly instead.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DevelopersPage", () => {
  it("shows a loading spinner while the session check is in flight", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    render(<DevelopersPage base="https://api" />);
    expect(screen.getByLabelText("loading")).not.toBeNull();
  });

  it("shows the guest marketing page on a real signed-out (401)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    render(<DevelopersPage base="https://api" />);
    expect(await screen.findByText("build on meowerse")).not.toBeNull();
  });

  it("a network error shows a retryable error state, never the guest marketing page (regression)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("down"))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }));
    render(<DevelopersPage base="https://api" />);

    expect(await screen.findByText("can't reach the account service.")).not.toBeNull();
    expect(screen.queryByText("build on meowerse")).toBeNull();

    screen.getByRole("button", { name: "try again" }).click();

    // retry re-fetches; this response is a real sign-out, so the error clears and
    // the guest page finally shows — proving the two states are distinct.
    expect(await screen.findByText("build on meowerse")).not.toBeNull();
    expect(screen.queryByText("can't reach the account service.")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
