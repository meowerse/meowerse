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
  chatCalls: [] as Array<{ quiet?: boolean }>,
  chatsResult: null as unknown,
  chatsGate: null as null | Promise<void>,
  /** Order of network starts/settles, to prove the parallel boot. */
  trace: [] as string[],
  sessionGate: null as null | Promise<void>,
  gateCall: null as null | number,
}));

vi.mock("../lib/meowsengerApi", () => ({
  getSession: vi.fn(async () => {
    H.trace.push("session:start");
    const idx = H.calls;
    const r = H.results[Math.min(idx, H.results.length - 1)];
    H.calls++;
    if (H.sessionGate && (H.gateCall == null || H.gateCall === idx)) await H.sessionGate;
    H.trace.push("session:end");
    return r;
  }),
  loginUrl: (b: string) => `${b}/auth/login`,
}));
vi.mock("../lib/chat", () => ({
  listChats: vi.fn(async (_b: string, opts?: { quiet?: boolean }) => {
    H.trace.push("chats:start");
    H.chatCalls.push(opts ?? {});
    if (H.chatsGate) await H.chatsGate;
    return H.chatsResult;
  }),
}));
vi.mock("./Chat", () => ({
  default: (p: { user: { id: string }; initialChats: { ok: boolean; data?: Array<{ id: string }> } }) => (
    <div data-testid="chat" data-user={p.user.id}>secret chat content{p.initialChats.data?.map((c) => <i key={c.id}>{c.id}</i>)}</div>
  ),
}));

import AppShell from "./AppShell";
import { notifySessionEnded, resetSessionEnded, setSnapshotSource } from "../lib/sessionEnded";

const authed = { ok: true, status: 200, data: { authenticated: true, user: { id: "u1" } } };
const replace = vi.fn();

beforeEach(() => {
  H.results = [authed];
  H.calls = 0;
  H.chatCalls = [];
  H.trace = [];
  H.chatsGate = null;
  H.sessionGate = null;
  H.gateCall = null;
  H.chatsResult = { ok: true, status: 200, data: [{ id: "chat-of-u1" }] };
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

  it("boot makes exactly one session read and one chats read, and Chat gets the user + list from them", async () => {
    render(<AppShell base="" />);
    const chat = await screen.findByTestId("chat");
    expect(H.calls).toBe(1);
    expect(H.chatCalls).toHaveLength(1);
    expect(chat.getAttribute("data-user")).toBe("u1");
    expect(chat.textContent).toContain("chat-of-u1");
  });

  it("starts the chats read before the session read resolves (parallel, no waterfall)", async () => {
    let release!: () => void;
    H.sessionGate = new Promise<void>((r) => { release = r; });
    render(<AppShell base="" />);
    await waitFor(() => expect(H.trace).toContain("session:start"));
    expect(H.trace).toContain("chats:start");
    expect(H.trace).not.toContain("session:end");
    expect(screen.queryByTestId("chat")).toBeNull();
    await act(async () => { release(); });
    await screen.findByTestId("chat");
    expect(H.trace.indexOf("chats:start")).toBeLessThan(H.trace.indexOf("session:end"));
  });

  it("shows the busy skeleton, not 'authenticating', while booting; nothing is announced as loaded", async () => {
    let release!: () => void;
    H.sessionGate = new Promise<void>((r) => { release = r; });
    const { container } = render(<AppShell base="" />);
    const shell = container.querySelector(".mw-chat") as HTMLElement;
    expect(shell.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText(/authenticating/)).toBeNull();
    // all decorative parts are hidden from assistive tech; only one polite "loading" note
    expect(container.querySelector("aside")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".mw-chat__main")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    await act(async () => { release(); });
    await screen.findByTestId("chat");
  });

  it("discards the chats result when the session is unauthenticated (and redirects, no banner)", async () => {
    H.results = [{ ok: true, status: 200, data: { authenticated: false } }];
    H.chatsResult = { ok: false, error: { kind: "unauthorized", status: 401 } };
    render(<AppShell base="" />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/login"));
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(screen.queryByText(/your session ended/)).toBeNull();
    expect(H.chatCalls[0]).toEqual({ quiet: true });
  });

  it("never renders another account's chats: a list that arrived for a rejected session is dropped", async () => {
    H.results = [{ ok: true, status: 200, data: { authenticated: false } }];
    H.chatsResult = { ok: true, status: 200, data: [{ id: "someone-elses-chat" }] };
    render(<AppShell base="" />);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(document.body.textContent).not.toContain("someone-elses-chat");
  });

  it("a 401 on the chats read of an authenticated boot raises sessionEnded (banner)", async () => {
    H.chatsResult = { ok: false, error: { kind: "unauthorized", status: 401 } };
    render(<AppShell base="" />);
    await screen.findByText(/your session ended/);
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a session 5xx shows retry, discards the chats result and never redirects", async () => {
    H.results = [{ ok: false, error: { kind: "http", status: 503, body: null } }];
    render(<AppShell base="" />);
    await screen.findByText(/can't reach meowsenger/);
    expect(screen.getByRole("button", { name: "retry now" })).toBeTruthy();
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a failed chats read does not block the app: Chat gets the error and shows its own retry", async () => {
    H.chatsResult = { ok: false, error: { kind: "network" } };
    render(<AppShell base="" />);
    const chat = await screen.findByTestId("chat");
    expect(chat.getAttribute("data-user")).toBe("u1");
    expect(replace).not.toHaveBeenCalled();
  });

  describe("bfcache restore (pageshow persisted)", () => {
    const u2 = { ok: true, status: 200, data: { authenticated: true, user: { id: "u2" } } };
    async function restore(persisted = true) {
      await act(async () => {
        const e = new Event("pageshow") as Event & { persisted: boolean };
        (e as { persisted: boolean }).persisted = persisted;
        window.dispatchEvent(e);
      });
    }

    it("same user: re-checks quietly and keeps the mounted app (no remount, no refetch of chats)", async () => {
      render(<AppShell base="" />);
      const before = await screen.findByTestId("chat");
      H.results = [authed];
      await restore();
      expect(H.calls).toBe(2);
      expect(screen.getByTestId("chat")).toBe(before); // same DOM node: state kept
      expect(H.chatCalls).toHaveLength(1);
    });

    it("different user: wipes the old app state, clears ?chat, and boots the new user", async () => {
      // happy-dom's location is swapped for a snapshot in beforeEach, so seed it directly.
      Object.defineProperty(window, "location", { value: { ...window.location, href: "http://localhost/app?chat=chat-of-u1&m=m9", search: "?chat=chat-of-u1&m=m9", replace }, configurable: true });
      const replaceState = vi.spyOn(window.history, "replaceState");
      render(<AppShell base="" />);
      await screen.findByTestId("chat");
      H.results = [authed, u2, u2];
      H.chatsResult = { ok: true, status: 200, data: [{ id: "chat-of-u2" }] };
      await restore();
      // old user's content must be gone at some point and the new one shown after boot
      const chat = await screen.findByText(/chat-of-u2/);
      expect(chat.closest("[data-testid=chat]")?.getAttribute("data-user")).toBe("u2");
      expect(document.body.textContent).not.toContain("chat-of-u1");
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(String(replaceState.mock.calls[0][2])).toBe("/app");
      expect(H.chatCalls).toHaveLength(2);
    });

    it("different user: the old user's app is unmounted BEFORE the new boot resolves", async () => {
      render(<AppShell base="" />);
      await screen.findByTestId("chat");
      let release!: () => void;
      H.results = [authed, u2, u2];
      H.chatsResult = { ok: true, status: 200, data: [{ id: "chat-of-u2" }] };
      H.sessionGate = new Promise<void>((r) => { release = r; });
      H.gateCall = 2; // hold the re-boot's session read (call #2); the pageshow re-check is call #1
      await restore();
      expect(screen.queryByTestId("chat")).toBeNull();
      expect(document.body.textContent).not.toContain("secret chat content");
      expect(document.querySelector(".mw-chat")?.getAttribute("aria-busy")).toBe("true");
      await act(async () => { release(); });
      const chat = await screen.findByTestId("chat");
      expect(chat.getAttribute("data-user")).toBe("u2");
    });

    it("signed out meanwhile: wipes and redirects to login", async () => {
      render(<AppShell base="" />);
      await screen.findByTestId("chat");
      H.results = [{ ok: true, status: 200, data: { authenticated: false } }];
      await restore();
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/login"));
      expect(screen.queryByTestId("chat")).toBeNull();
    });

    it("a network error or 5xx on the re-check keeps the current state (no wipe, no redirect)", async () => {
      render(<AppShell base="" />);
      await screen.findByTestId("chat");
      H.results = [{ ok: false, error: { kind: "http", status: 502, body: null } }];
      await restore();
      expect(screen.getByTestId("chat")).toBeTruthy();
      expect(replace).not.toHaveBeenCalled();
    });

    it("a 401 on the re-check raises the session-ended banner", async () => {
      render(<AppShell base="" />);
      await screen.findByTestId("chat");
      H.results = [{ ok: false, error: { kind: "unauthorized", status: 401 } }];
      await restore();
      await screen.findByText(/your session ended/);
    });

    it("ignores a non-persisted pageshow", async () => {
      render(<AppShell base="" />);
      await screen.findByTestId("chat");
      await restore(false);
      expect(H.calls).toBe(1);
    });
  });
});
