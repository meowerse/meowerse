/** @vitest-environment happy-dom */
/**
 * The notifications toggle must never fail silently: the prod bug was a server 400
 * (Chrome's jmt17.google.com endpoint rejected) swallowed by the client, so the
 * toggle showed "on" while the server stored nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "../test/rtl";

// A plain function, not vi.fn: a vi.fn whose implementation rejects reports the
// rejection as a test failure even though the component catches it.
const H = vi.hoisted(() => ({
  impl: (async () => "granted") as (...a: unknown[]) => Promise<string>,
  calls: [] as unknown[][],
  cleared: 0,
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
    pushSupported: () => true,
    pushPermission: () => "granted",
    pushSubscribed: async () => false,
    enablePush: (...a: unknown[]) => { H.calls.push(a); return H.impl(...a); },
    clearLocalPush: () => { H.cleared++; return Promise.resolve(); },
  };
});

import { PushError } from "../lib/push";
import Settings from "./Settings";

function toggle() {
  return screen.getByText("notify me of new messages").closest(".mw-setting")!.querySelector("button")!;
}

describe("Settings — notifications toggle", () => {
  beforeEach(() => { H.calls = []; });

  it("shows an error and stays off when the server rejects the subscription", async () => {
    H.impl = async () => { throw new PushError("bad_endpoint"); };
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't turn on notifications/);
    expect(toggle().textContent).toBe("off");
    expect(H.calls).toEqual([["https://x", "u1"]]);
  });

  it("tells the user to log in again on an expired session", async () => {
    H.impl = async () => { throw new PushError("unauthorized"); };
    render(<Settings base="https://x" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/session expired/);
  });

  it("flips to on with no error once the server stored it", async () => {
    H.impl = async () => "granted";
    render(<Settings base="https://x" open onClose={() => {}} />);
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByLabelText("turn off notifications").textContent).toBe("on"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a dismissed prompt", async () => {
    H.impl = async () => "default";
    render(<Settings base="https://x" open onClose={() => {}} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole("alert")).textContent).toMatch(/weren't allowed/);
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
