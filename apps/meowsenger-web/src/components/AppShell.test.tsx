/** @vitest-environment happy-dom */
/**
 * Auth-gate honesty: only a definitive 200 {authenticated:false} redirects. A
 * network error / 5xx keeps the app on a retrying state; a 401 shows a session-ended
 * banner with a sign-in action and unmounts the chat (clearing its content).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "../test/rtl";

const H = vi.hoisted(() => ({
  results: [] as unknown[],
  calls: 0,
}));

vi.mock("../lib/meowsengerApi", () => ({
  getSession: vi.fn(async () => {
    const r = H.results[Math.min(H.calls, H.results.length - 1)];
    H.calls++;
    return r;
  }),
  loginUrl: (b: string) => `${b}/auth/login`,
}));
vi.mock("./Chat", () => ({ default: () => <div data-testid="chat">secret chat content</div> }));

import AppShell from "./AppShell";
import { notifySessionEnded, resetSessionEnded } from "../lib/sessionEnded";

const authed = { ok: true, status: 200, data: { authenticated: true, user: { id: "u1" } } };
const replace = vi.fn();

beforeEach(() => {
  H.results = [authed];
  H.calls = 0;
  replace.mockClear();
  resetSessionEnded();
  Object.defineProperty(window, "location", { value: { ...window.location, replace }, configurable: true });
});
afterEach(() => { vi.useRealTimers(); });

describe("AppShell", () => {
  it("renders the chat for an authenticated session", async () => {
    render(<AppShell base="" />);
    await screen.findByTestId("chat");
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects on a definitive 200 {authenticated:false}", async () => {
    H.results = [{ ok: true, status: 200, data: { authenticated: false } }];
    render(<AppShell base="" />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/login"));
  });

  it.each([
    ["network", { kind: "network" }],
    ["timeout", { kind: "timeout" }],
    ["5xx", { kind: "http", status: 503, body: null }],
  ])("a session %s error shows 'can't reach meowsenger, retrying' and does NOT redirect", async (_n, error) => {
    H.results = [{ ok: false, error }];
    render(<AppShell base="" />);
    await screen.findByText(/can't reach meowsenger/);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat")).toBeNull();
  });

  it("retries after an outage and recovers into the app", async () => {
    H.results = [{ ok: false, error: { kind: "network" } }, authed];
    render(<AppShell base="" />);
    await screen.findByText(/can't reach meowsenger/);
    fireEvent.click(screen.getByRole("button", { name: "retry now" }));
    await screen.findByTestId("chat");
    expect(replace).not.toHaveBeenCalled();
  });

  it("auto-retries on a timer", async () => {
    vi.useFakeTimers();
    H.results = [{ ok: false, error: { kind: "network" } }, authed];
    render(<AppShell base="" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/can't reach meowsenger/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(screen.getByTestId("chat")).toBeTruthy();
  });

  it("a 401 on the session shows the session-ended banner with a sign-in link, no redirect", async () => {
    H.results = [{ ok: false, error: { kind: "unauthorized", status: 401 } }];
    render(<AppShell base="" />);
    await screen.findByText(/your session ended/);
    expect(screen.getByRole("link", { name: "sign in" }).getAttribute("href")).toBe("/auth/login");
    expect(replace).not.toHaveBeenCalled();
  });

  it("a later 401 (sessionEnded signal) swaps the chat for the banner, clearing its content", async () => {
    render(<AppShell base="" />);
    await screen.findByTestId("chat");
    act(() => notifySessionEnded());
    await screen.findByText(/your session ended/);
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(screen.queryByText("secret chat content")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
