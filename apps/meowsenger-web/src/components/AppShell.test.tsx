/** @vitest-environment happy-dom */
/**
 * Auth-gate honesty: only a definitive 200 {authenticated:false} redirects. A
 * network error / 5xx keeps the app on a retrying state; a 401 shows a session-ended
 * banner with a sign-in action and unmounts the chat (clearing its content).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, setVisibility } from "../test/rtl";

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
import { notifySessionEnded, resetSessionEnded, setSnapshotSource } from "../lib/sessionEnded";

const authed = { ok: true, status: 200, data: { authenticated: true, user: { id: "u1" } } };
const replace = vi.fn();

beforeEach(() => {
  H.results = [authed];
  H.calls = 0;
  replace.mockClear();
  resetSessionEnded();
  Object.defineProperty(window, "location", { value: { ...window.location, replace }, configurable: true });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setSnapshotSource(null); setVisibility("visible"); });

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
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(screen.getByTestId("chat")).toBeTruthy();
  });

  it("backs off exponentially (2s, 4s, 8s … capped at 30s) with jitter", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor exactly 1.0
    H.results = [{ ok: false, error: { kind: "network" } }];
    render(<AppShell base="" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(H.calls).toBe(1);
    const waits: number[] = [];
    for (const expected of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(expected - 1); });
      const before = H.calls;
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(H.calls).toBe(before + 1);
      waits.push(expected);
    }
    expect(waits).toHaveLength(6);
  });

  it("applies jitter within +/-20% of the base delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // lowest jitter => 0.8x
    H.results = [{ ok: false, error: { kind: "network" } }];
    render(<AppShell base="" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_599); });
    expect(H.calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(H.calls).toBe(2);
  });

  it("pauses while the tab is hidden and retries once immediately when it becomes visible", async () => {
    vi.useFakeTimers();
    H.results = [{ ok: false, error: { kind: "network" } }, authed];
    setVisibility("hidden");
    render(<AppShell base="" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(H.calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(H.calls).toBe(1); // nothing scheduled while hidden
    await act(async () => { setVisibility("visible"); await vi.advanceTimersByTimeAsync(0); });
    expect(H.calls).toBe(2);
    expect(screen.getByTestId("chat")).toBeTruthy();
  });

  it("retries immediately when the browser comes back online", async () => {
    vi.useFakeTimers();
    H.results = [{ ok: false, error: { kind: "network" } }, authed];
    render(<AppShell base="" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(H.calls).toBe(1);
    await act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(0); });
    expect(H.calls).toBe(2);
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

  it("focuses the sign-in link when the banner mounts; only the text is role=alert", async () => {
    H.results = [{ ok: false, error: { kind: "unauthorized", status: 401 } }];
    render(<AppShell base="" />);
    const link = await screen.findByRole("link", { name: "sign in" });
    expect(document.activeElement).toBe(link);
    expect(screen.getByRole("alert").textContent).toMatch(/your session ended/);
    expect(screen.getByRole("alert").querySelector("a, button")).toBeNull();
  });

  it("hands back the active draft (memory only) and warns about an un-acked send", async () => {
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<AppShell base="" />);
    await screen.findByTestId("chat");
    setSnapshotSource(() => ({ draft: "half a thought", pendingSend: true }));
    act(() => notifySessionEnded());
    await screen.findByText(/a message may not have been sent/);
    expect((screen.getByLabelText(/your unsent message/) as HTMLTextAreaElement).value).toBe("half a thought");
    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    await screen.findByText(/couldn't copy/);
  });

  it("shows no draft box or warning when there was nothing to hand back", async () => {
    render(<AppShell base="" />);
    await screen.findByTestId("chat");
    act(() => notifySessionEnded());
    await screen.findByText(/your session ended/);
    expect(screen.queryByLabelText(/your unsent message/)).toBeNull();
    expect(screen.queryByText(/may not have been sent/)).toBeNull();
  });
});
