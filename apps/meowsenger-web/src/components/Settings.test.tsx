/** @vitest-environment happy-dom */
/**
 * The notifications toggle must never fail silently: the prod bug was a server 400
 * (Chrome's jmt17.google.com endpoint rejected) swallowed by the client, so the
 * toggle showed "on" while the server stored nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "../test/rtl";

// A plain function, not vi.fn: a vi.fn whose implementation rejects reports the
// rejection as a test failure even though the component catches it.
const H = vi.hoisted(() => ({
  impl: (async () => "granted") as (...a: unknown[]) => Promise<string>,
  calls: [] as unknown[][],
  cleared: 0,
  supported: true,
  perm: "granted",
  subscribed: false,
  confirmed: null as boolean | null,
  lastError: null as string | null,
  ios: false,
  standalone: false,
}));

vi.mock("../lib/chat", async (importActual) => ({
  ...(await importActual<typeof import("../lib/chat")>()),
  getPrivacy: vi.fn(async () => ({ allowAutoGroupAdd: true })),
  deleteAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../lib/push", async (importActual) => {
  const actual = await importActual<typeof import("../lib/push")>();
  return {
    ...actual,
    pushSupported: () => H.supported,
    pushPermission: () => (H.supported ? H.perm : "unsupported"),
    pushSubscribed: async () => H.subscribed,
    pushConfirmedFor: async () => H.confirmed ?? H.subscribed,
    pushDiagnostics: async () => ({ permission: H.supported ? H.perm : "unsupported", serviceWorker: false, subscription: H.subscribed, lastError: H.lastError }),
    recordPushError: (c: string | null) => { H.lastError = c; actual.recordPushError(c); },
    isIos: () => H.ios,
    isStandalone: () => H.standalone,
    disablePush: async () => { H.subscribed = false; },
    enablePush: (...a: unknown[]) => { H.calls.push(a); return H.impl(...a); },
    clearLocalPush: () => { H.cleared++; return Promise.resolve(); },
  };
});

import { PushError } from "../lib/push";
import Settings from "./Settings";

function toggle() {
  return screen.getByRole("switch", { name: /push notifications/ });
}
const state = () => toggle().getAttribute("aria-checked");

describe("Settings — notifications toggle", () => {
  beforeEach(() => { H.calls = []; H.supported = true; H.perm = "granted"; H.subscribed = false; H.confirmed = null; H.lastError = null; H.ios = false; H.standalone = false; });

  it("shows an error and stays off when the server rejects the subscription", async () => {
    H.impl = async () => { throw new PushError("bad_endpoint"); };
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't turn on notifications/);
    expect(state()).toBe("false");
    expect(H.calls).toEqual([["https://x", "u1"]]);
  });

  it("tells the user to log in again on an expired session", async () => {
    H.impl = async () => { throw new PushError("unauthorized"); };
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/session expired/);
  });

  it("flips to on with no error once the server stored it", async () => {
    H.impl = async () => "granted";
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    await waitFor(() => expect(state()).toBe("true"));
    expect(screen.getByText(/^on — you'll get a notification/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a dismissed prompt", async () => {
    H.impl = async () => "default";
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/dismissed or hidden/);
  });
});

describe("Settings — push switch states", () => {
  beforeEach(() => { H.calls = []; H.supported = true; H.perm = "default"; H.subscribed = false; H.confirmed = null; H.lastError = null; H.ios = false; H.standalone = false; });

  it("off: unchecked, enabled, visible state word and status", async () => {
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("off", { selector: ".mw-setting__state" })).toBeTruthy());
    expect(state()).toBe("false");
    expect((toggle() as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector(".mw-setting--push .mw-setting__hint")!.textContent).toBe("off");
  });

  it("on: checked, state word on, a tap turns it off", async () => {
    H.subscribed = true;
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    await waitFor(() => expect(state()).toBe("true"));
    expect(screen.getByText("on", { selector: ".mw-setting__state" })).toBeTruthy();
    fireEvent.click(toggle());
    await waitFor(() => expect(state()).toBe("false"));
    expect(H.calls).toEqual([]);
  });

  it("off when the browser has a subscription but this account is not confirmed", async () => {
    H.subscribed = true; H.confirmed = false;
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/push subscription on this device: yes/)).toBeTruthy());
    expect(state()).toBe("false");
    expect(screen.getByText(/registered for this account: no/)).toBeTruthy();
  });

  it("on when the subscription is confirmed for this account", async () => {
    H.subscribed = true; H.confirmed = true;
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    await waitFor(() => expect(state()).toBe("true"));
    expect(screen.getByText(/registered for this account: yes/)).toBeTruthy();
  });

  it("never on while the user id is unknown", async () => {
    H.subscribed = true; H.confirmed = true;
    render(<Settings base="https://x" open onClose={() => {}} />);
    expect(await screen.findByText("loading…")).toBeTruthy();
    expect(state()).toBe("false");
  });

  it("AbortError from subscribe: specific message (Android part only on Android) and name in details", async () => {
    H.impl = async () => { throw new DOMException("Registration failed - push service error", "AbortError"); };
    const ua = vi.spyOn(navigator, "userAgent", "get");
    ua.mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) Chrome/120");
    const first = render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    const text = (await screen.findByRole("alert")).textContent!;
    expect(text).toMatch(/couldn't register with its push service/);
    expect(text).not.toMatch(/google play/i);
    await waitFor(() => expect(screen.getByText("last error: AbortError — Registration failed - push service error")).toBeTruthy());
    first.unmount();
    ua.mockReturnValue("Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile");
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/google play services/i);
    ua.mockRestore();
  });

  it("an unknown thrown value still records unknown", async () => {
    H.impl = async () => { throw "boom"; };
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't turn on notifications/);
    await waitFor(() => expect(screen.getByText("last error: unknown")).toBeTruthy());
  });

  it("busy: shows turning on… and disables the switch", async () => {
    let release!: (v: string) => void;
    H.impl = () => new Promise<string>((r) => { release = r; });
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    await screen.findByText("turning on…");
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    release("granted");
    await waitFor(() => expect(state()).toBe("true"));
  });

  it("blocked: disabled with site-settings guidance", async () => {
    H.perm = "denied";
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    expect(await screen.findByText(/blocked in this browser — allow notifications for meowsenger\.alxnko\.dev in site settings/)).toBeTruthy();
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  });

  it("unsupported: disabled with a plain message", async () => {
    H.supported = false;
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    expect(await screen.findByText("not supported in this browser")).toBeTruthy();
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  });

  it("iOS regular tab: shows the add-to-home-screen hint", async () => {
    H.supported = false; H.ios = true; H.standalone = false;
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    expect(await screen.findByText(/on iPhone: tap share → add to home screen, open meowsenger from the home screen, then turn notifications on here/)).toBeTruthy();
  });

  it("disabled with loading… until the userId is known, then enabled", async () => {
    const { rerender } = render(<Settings base="https://x" open onClose={() => {}} />);
    expect(await screen.findByText("loading…")).toBeTruthy();
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle());
    expect(H.calls).toEqual([]);
    rerender(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
  });

  it("a hidden/auto-denied prompt gets Chrome guidance and the code in details", async () => {
    H.impl = async () => "denied";
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Chrome may have hidden it/);
    await waitFor(() => expect(screen.getByText(/last error: denied/)).toBeTruthy());
  });

  it("the visible on/off word is hidden from assistive tech (the switch already announces it)", async () => {
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector(".mw-setting__state")!.getAttribute("aria-hidden")).toBe("true"));
  });

  it("denied copy mentions android settings only on Android", async () => {
    H.impl = async () => "denied";
    const ua = vi.spyOn(navigator, "userAgent", "get");
    ua.mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) Chrome/120");
    const first = render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).not.toMatch(/android/i);
    first.unmount();
    ua.mockReturnValue("Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile");
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/android settings/);
    ua.mockRestore();
  });

  it("says it couldn't load the account when the user id never arrives (~10 s)", async () => {
    vi.useFakeTimers();
    try {
      render(<Settings base="https://x" open onClose={() => {}} />);
      expect(screen.getByText("loading…")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_100); });
      expect(screen.getByText(/couldn't load your account — reload/)).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("details show permission/sw/subscription yes-no and no endpoint", async () => {
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/permission: default/)).toBeTruthy());
    expect(screen.getByText(/push subscription on this device: no/)).toBeTruthy();
    expect(document.querySelector(".mw-setting__diag")!.textContent).not.toMatch(/https?:|endpoint/i);
  });
});

describe("Settings — account deletion", () => {
  it("clears the local push subscription + marker once deletion succeeds", async () => {
    H.cleared = 0;
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(screen.getByText("delete", { selector: "button.mw-danger__btn" }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "delete" } });
    fireEvent.click(screen.getByText("delete my data"));
    await waitFor(() => expect(H.cleared).toBe(1));
  });
});

describe("Settings — footer links", () => {
  it("links privacy, terms, about and the meowerse account page from inside the app", () => {
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    const nav = screen.getByRole("navigation", { name: /about meowsenger/ });
    const href = (name: string) => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(href("privacy")).toBe("/privacy");
    expect(href("terms")).toBe("/terms");
    expect(href("about")).toBe("/about");
    expect(href("meowerse account")).toBe("https://auth.alxnko.dev/account");
    expect(within(nav).getAllByRole("link").every((a) => !a.hasAttribute("target"))).toBe(true);
  });
});
