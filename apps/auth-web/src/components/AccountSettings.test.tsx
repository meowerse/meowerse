// @vitest-environment jsdom
//
// Same harness as DevelopersPage.test.tsx: jsdom by pragma, explicit cleanup, plain existence checks.
import { cleanup, render, screen } from "@testing-library/react";
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
});
