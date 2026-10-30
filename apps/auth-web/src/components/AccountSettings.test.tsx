// @vitest-environment jsdom
//
// Same harness as DevelopersPage.test.tsx: jsdom by pragma, explicit cleanup, plain existence checks.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@meowerse/ui";
import AccountSettings from "./AccountSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ACCOUNT = {
  username: "alxnko", displayName: null, avatarUrl: null, verified: true, hasPassword: false,
  telegram: { linked: false, username: null }, recoveryRemaining: 8, csrf: "c",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = () => render(<ToastProvider><AccountSettings base="https://api" /></ToastProvider>);

describe("AccountSettings", () => {
  it("a failed account load (404/5xx) is a retryable error, never a crash (regression: acct.telegram on { error })", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("/grants") ? json({ grants: [] }) : json({ error: "not_found" }, 404));
    page();
    expect(await screen.findByText("couldn't load your account.")).not.toBeNull();
    expect(screen.getByRole("alert")).not.toBeNull();
    fetchSpy.mockImplementation(async (url) => String(url).endsWith("/grants") ? json({ grants: [] }) : json(ACCOUNT));
    screen.getByRole("button", { name: "try again" }).click();
    expect(await screen.findByText("alxnko")).not.toBeNull();
    expect(screen.queryByText("couldn't load your account.")).toBeNull();
  });

  it("a network failure says so with a retry, instead of an endless spinner", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("down"));
    page();
    expect(await screen.findByText("can't reach the account service.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "try again" })).not.toBeNull();
  });

  it("a signed-out answer still asks to sign in", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({}, 401));
    page();
    expect(await screen.findByText(/to manage your account/)).not.toBeNull();
  });

  it("deleteEnabled false hides the delete button and shows the email-request line", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/grants") ? json({ grants: [] }) : json({ ...ACCOUNT, deleteEnabled: false }));
    page();
    await screen.findByText("alxnko");
    expect(screen.queryByRole("button", { name: "delete account" })).toBeNull();
    expect(screen.getByText(/account deletion is handled on request for now/)).not.toBeNull();
    expect(screen.getByRole("link", { name: "privacy@alxnko.dev" }).getAttribute("href")).toBe("mailto:privacy@alxnko.dev");
  });

  it("connected apps show the app name next to its client id; id alone when the name is missing", async () => {
    const grants = [
      { clientId: "mw_named", displayName: "meowsenger", approvedScopes: ["openid", "profile"], updatedAt: null },
      { clientId: "mw_unnamed", displayName: null, approvedScopes: ["openid"], updatedAt: null },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/grants") ? json({ grants }) : json(ACCOUNT));
    page();
    expect(await screen.findByText("meowsenger")).not.toBeNull();
    expect(screen.getByText("mw_named")).not.toBeNull();
    expect(screen.getByText("mw_unnamed")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "revoke" })).toHaveLength(2);
  });

  it("deleteEnabled absent hides the delete control", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/grants") ? json({ grants: [] }) : json(ACCOUNT));
    page();
    await screen.findByText("alxnko");
    expect(screen.queryByRole("button", { name: "delete account" })).toBeNull();
    expect(screen.getByText(/handled on request for now/)).not.toBeNull();
  });

  it("deleteEnabled true keeps the delete button", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/grants") ? json({ grants: [] }) : json({ ...ACCOUNT, deleteEnabled: true }));
    page();
    await screen.findByText("alxnko");
    expect(screen.getByRole("button", { name: "delete account" })).not.toBeNull();
    expect(screen.queryByText(/handled on request for now/)).toBeNull();
  });

  it("maps a 409 owns_active_clients delete answer to the developer-dashboard message", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/grants")) return json({ grants: [] });
      if (u.endsWith("/api/account/delete")) return json({ error: "owns_active_clients" }, 409);
      return json({ ...ACCOUNT, deleteEnabled: true });
    });
    page();
    await screen.findByText("alxnko");
    fireEvent.click(screen.getByRole("button", { name: "delete account" }));
    fireEvent.change(await screen.findByLabelText("type alxnko to confirm"), { target: { value: "alxnko" } });
    const buttons = screen.getAllByRole("button", { name: "delete account" });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(screen.getByText("delete your apps in the developer dashboard first")).not.toBeNull());
    expect(screen.queryByText("could not delete account")).toBeNull();
  });
});
