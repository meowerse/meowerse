// @vitest-environment jsdom
//
// Same harness as DevelopersPage.test.tsx: jsdom by pragma, explicit cleanup, plain existence checks.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@meowerse/ui";
import AccountSettings, { CONNECTED_SERVICES_NOTICE } from "./AccountSettings";

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

  it("the delete UI says explicitly that Meowsenger messages and data are NOT deleted, and to delete them first", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/grants") ? json({ grants: [] }) : json({ ...ACCOUNT, deleteEnabled: true }));
    page();
    await screen.findByText("alxnko");
    const notice = screen.getByTestId("delete-services-notice").textContent ?? "";
    expect(notice).toBe(CONNECTED_SERVICES_NOTICE);
    expect(CONNECTED_SERVICES_NOTICE).toMatch(/does not delete anything in the services you signed in to with meowerse/);
    expect(CONNECTED_SERVICES_NOTICE).toMatch(/like messages you sent, stays/);
    expect(CONNECTED_SERVICES_NOTICE).toMatch(/do that first/);
    expect(CONNECTED_SERVICES_NOTICE).toMatch(/content you already shared, like messages you sent, is not deleted/);
    expect(CONNECTED_SERVICES_NOTICE).not.toMatch(/meowverse/i);
    // The confirm dialog repeats it (the last thing read before confirming).
    fireEvent.click(screen.getByRole("button", { name: "delete account" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(CONNECTED_SERVICES_NOTICE);
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
      if (u.endsWith("/api/account/delete/start")) return json({ confirm_token: "tok" });
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

  const openDelete = async () => {
    await screen.findByText("alxnko");
    fireEvent.click(screen.getByRole("button", { name: "delete account" }));
    fireEvent.change(await screen.findByLabelText("type alxnko to confirm"), { target: { value: "alxnko" } });
  };
  const clickDelete = () => { const b = screen.getAllByRole("button", { name: "delete account" }); fireEvent.click(b[b.length - 1]!); };

  it("fresh auth: start then delete, the delete carries the confirm token", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/grants")) return json({ grants: [] });
      if (init?.method === "POST") calls.push({ url: u, body: JSON.parse(String(init.body)) });
      if (u.endsWith("/delete/start")) return json({ confirm_token: "tok1" });
      if (u.endsWith("/api/account/delete")) return json({ error: "confirm_invalid" }, 403);
      return json({ ...ACCOUNT, deleteEnabled: true });
    });
    page();
    await openDelete();
    clickDelete();
    await waitFor(() => expect(screen.getByText("the confirmation expired — try again")).not.toBeNull());
    expect(calls.map((c) => c.url.split("/api/account")[1])).toEqual(["/delete/start", "/delete"]);
    expect(calls[1]!.body).toEqual({ csrf: "c", confirm: "alxnko", confirm_token: "tok1" });
  });

  it("stale auth with a password: asks for the password, then retries start with it", async () => {
    const starts: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/grants")) return json({ grants: [] });
      if (u.endsWith("/delete/start")) {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        starts.push(b);
        return b.current_password ? json({ confirm_token: "tok2" }) : json({ error: "step_up_required", reauth: "password" }, 401);
      }
      if (u.endsWith("/api/account/delete")) return json({ error: "owns_active_clients" }, 409);
      return json({ ...ACCOUNT, hasPassword: true, deleteEnabled: true });
    });
    page();
    await openDelete();
    clickDelete();
    const pw = await screen.findByLabelText("your password");
    fireEvent.change(pw, { target: { value: "hunter2hunter2" } });
    clickDelete();
    await waitFor(() => expect(screen.getByText("delete your apps in the developer dashboard first")).not.toBeNull());
    expect(starts).toEqual([{ csrf: "c" }, { csrf: "c", current_password: "hunter2hunter2" }]);
  });

  it("stale auth on a Telegram-only account: offers sign in again with telegram (/login?reauth=delete)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/grants")) return json({ grants: [] });
      if (u.endsWith("/delete/start")) return json({ error: "step_up_required", reauth: "telegram" }, 401);
      return json({ ...ACCOUNT, deleteEnabled: true });
    });
    page();
    await openDelete();
    clickDelete();
    const btn = await screen.findByRole("button", { name: "sign in again with telegram" });
    expect(btn.closest("a")?.getAttribute("href")).toBe("/login?reauth=delete");
    expect(screen.getByRole("alert").textContent).toContain("linked to alxnko"); // a different Telegram account must be obvious
  });

  it("returning from re-auth (?reauth=delete) reopens the delete dialog once", async () => {
    window.history.replaceState(null, "", "/account?reauth=delete");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/grants") ? json({ grants: [] }) : json({ ...ACCOUNT, deleteEnabled: true }));
    page();
    expect(await screen.findByLabelText("type alxnko to confirm")).not.toBeNull();
    expect(window.location.search).toBe("");
  });

  it("regenerating recovery codes on a stale login asks for the password and resends it", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/grants")) return json({ grants: [] });
      if (u.endsWith("/api/account/recovery-codes")) {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(b);
        return b.current_password ? json({ recoveryCodes: ["aaaa-bbbb"] }) : json({ error: "step_up_required", reauth: "password" }, 401);
      }
      return json({ ...ACCOUNT, hasPassword: true });
    });
    page();
    await screen.findByText("alxnko");
    fireEvent.click(screen.getByRole("button", { name: "regenerate" })); // opens the confirm dialog
    await waitFor(() => expect(screen.getAllByRole("button", { name: "regenerate" }).length).toBeGreaterThan(1));
    const confirmBtns = screen.getAllByRole("button", { name: "regenerate" });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]!); // the dialog's confirm
    await waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]!.current_password).toBeUndefined();
    const pw = await screen.findByLabelText("your password");
    fireEvent.change(pw, { target: { value: "hunter2hunter2" } });
    const btns = screen.getAllByRole("button", { name: "regenerate" });
    fireEvent.click(btns[btns.length - 1]!);
    await waitFor(() => expect(bodies.length).toBe(2));
    expect(bodies[1]!.current_password).toBe("hunter2hunter2");
  });
});

describe("AccountSettings stale-while-revalidate (PR-21)", () => {
  const LINKED = { ...ACCOUNT, telegram: { linked: true, username: "tg" } };
  /** Loads the page, then triggers a revalidate (a successful unlink calls reload()) whose GETs answer with `after`. */
  async function revalidateWith(after: (url: string) => Response | Promise<Response>) {
    let revalidating = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") { revalidating = true; return json({ ok: true }); }
      if (revalidating) return after(u);
      return u.endsWith("/grants") ? json({ grants: [{ clientId: "mw_x", displayName: "x app", approvedScopes: ["openid"], updatedAt: null }] }) : json(LINKED);
    });
    page();
    await screen.findByText("x app");
    fireEvent.click(screen.getByRole("button", { name: "unlink" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "unlink" })).at(-1)!);
  }

  it("shows a skeleton (not the loaded page, not a spinner) until the account arrives", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const { container } = page();
    expect(screen.getByRole("status", { name: "loading account" })).not.toBeNull();
    expect(container.querySelector(".mw-spinner")).toBeNull();
    expect(container.querySelectorAll(".mw-skeleton").length).toBeGreaterThan(0);
  });

  it("a failed revalidate keeps the account and grants and says so; retry heals it", async () => {
    await revalidateWith(() => json({ error: "boom" }, 500));
    expect(await screen.findByText(/couldn't refresh your account/)).not.toBeNull();
    expect(screen.getByText("alxnko")).not.toBeNull();
    expect(screen.getByText("x app")).not.toBeNull();
    expect(screen.queryByText("couldn't load your account.")).toBeNull();
  });

  it("a signed-out answer on revalidate drops the previous account's data and clears the session cache", async () => {
    sessionStorage.setItem("mw-session", "stale");
    await revalidateWith(() => json({}, 401));
    expect(await screen.findByText(/to manage your account/)).not.toBeNull();
    expect(screen.queryByText("alxnko")).toBeNull();
    expect(screen.queryByText("x app")).toBeNull();
    expect(sessionStorage.getItem("mw-session")).toBeNull();
  });
});

describe("AccountSettings identity, ordering and restore (PR-21 review)", () => {
  const LINKED = { ...ACCOUNT, telegram: { linked: true, username: "tg" } };
  const GRANT_A = { clientId: "mw_a", displayName: "a app", approvedScopes: ["openid"], updatedAt: null };
  /** Loads account A with one grant, then a successful unlink triggers reload() whose GETs answer with `after`. */
  async function revalidateWith(after: (url: string) => Response | Promise<Response>) {
    let revalidating = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") { revalidating = true; return json({ ok: true }); }
      if (revalidating) return after(u);
      return u.endsWith("/grants") ? json({ grants: [GRANT_A] }) : json(LINKED);
    });
    page();
    await screen.findByText("a app");
    fireEvent.click(screen.getByRole("button", { name: "unlink" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "unlink" })).at(-1)!);
  }

  it("a different account whose grants fail to load shows none of the previous account's apps (no revoke for them)", async () => {
    await revalidateWith((u) => u.endsWith("/grants") ? json({ error: "boom" }, 500) : json({ ...LINKED, username: "bob", csrf: "c2" }));
    expect(await screen.findByText("bob")).not.toBeNull();
    expect(screen.queryByText("a app")).toBeNull();
    expect(screen.queryByRole("button", { name: "revoke" })).toBeNull();
    expect(screen.getByText(/couldn't load your connected apps/)).not.toBeNull();
  });

  it("the same account whose grants fail to refresh keeps its apps", async () => {
    await revalidateWith((u) => u.endsWith("/grants") ? json({ error: "boom" }, 500) : json(LINKED));
    expect(await screen.findByText(/couldn't refresh your connected apps/)).not.toBeNull();
    expect(screen.getByText("a app")).not.toBeNull();
    expect(screen.getByRole("button", { name: "revoke" })).not.toBeNull();
  });

  it("a grants-only sign-out is a sign-out: sign-in alert, no endless skeleton, no false 'no apps have access'", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/grants") ? json({}, 401) : json(ACCOUNT));
    page();
    expect(await screen.findByText(/to manage your account/)).not.toBeNull();
    expect(screen.queryByText("no apps have access.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("'try again' on a failed grants load clears the failure while refetching, and is disabled while a refresh runs", async () => {
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => String(url).endsWith("/grants")
      ? (fail ? Promise.resolve(json({ error: "x" }, 500)) : new Promise<Response>(() => {}))
      : Promise.resolve(json(ACCOUNT)));
    page();
    const retry = await screen.findByRole("button", { name: "try again" });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByRole("status", { name: "loading connected apps" })).not.toBeNull();
    expect(screen.queryByText(/couldn't load your connected apps/)).toBeNull();
  });

  it("a bfcache restore drops the shown account at once and re-checks the session", async () => {
    let signedOut = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => signedOut ? json({}, 401) : String(url).endsWith("/grants") ? json({ grants: [GRANT_A] }) : json(ACCOUNT));
    page();
    await screen.findByText("a app");
    signedOut = true;
    act(() => { window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })); });
    expect(screen.queryByText("a app")).toBeNull();
    expect(screen.queryByText("alxnko")).toBeNull();
    expect(await screen.findByText(/to manage your account/)).not.toBeNull();
  });
});

describe("AccountSettings ordering and codes (PR-21 review 2)", () => {
  const LINKED = { ...ACCOUNT, telegram: { linked: true, username: "tg" } };
  const GRANT_A = { clientId: "mw_a", displayName: "a app", approvedScopes: ["openid"], updatedAt: null };
  /** GETs: first pair answers normally; later ones go to `later(url)`. POSTs: recovery codes / ok. */
  function setup(later: (u: string) => Response | Promise<Response>) {
    let loaded = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") return u.endsWith("/recovery-codes") ? json({ recoveryCodes: ["code-aaaa"] }) : json({ ok: true });
      if (!loaded) { if (u.endsWith("/account")) return json(LINKED); loaded = true; return json({ grants: [GRANT_A] }); }
      return later(u);
    });
    page();
  }
  const confirmLast = async (name: string) => fireEvent.click((await screen.findAllByRole("button", { name })).at(-1)!);

  it("a late 200 from an older reload never undoes a newer sign-out", async () => {
    let late!: (r: Response) => void;
    let n = 0;
    setup(() => (n++ < 2 ? new Promise<Response>((r) => { if (n === 1) late = r; }) : json({}, 401)));
    await screen.findByText("a app");
    fireEvent.click(screen.getByRole("button", { name: "unlink" }));
    await confirmLast("unlink"); // reload #1: account pending (late)
    act(() => { window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })); }); // reload #2 -> 401
    expect(await screen.findByText(/to manage your account/)).not.toBeNull();
    late(json(LINKED));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("alxnko")).toBeNull();
    expect(screen.getByText(/to manage your account/)).not.toBeNull();
  });

  it("the same account keeps its shown recovery codes across a refresh; a different one hides them with a notice", async () => {
    setup((u) => u.endsWith("/grants") ? json({ grants: [GRANT_A] }) : json(LINKED));
    await screen.findByText("a app");
    fireEvent.click(screen.getByRole("button", { name: "regenerate" }));
    await confirmLast("regenerate");
    expect(await screen.findByText("code-aaaa")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "unlink" })); // success -> reload() for the same account
    await confirmLast("unlink");
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText("code-aaaa")).not.toBeNull();
  });

  it("an account change hides shown recovery codes and says so", async () => {
    let who = LINKED;
    setup((u) => u.endsWith("/grants") ? json({ grants: [GRANT_A] }) : json(who));
    await screen.findByText("a app");
    fireEvent.click(screen.getByRole("button", { name: "regenerate" }));
    await confirmLast("regenerate");
    await screen.findByText("code-aaaa");
    who = { ...LINKED, username: "bob", csrf: "c2" };
    fireEvent.click(screen.getByRole("button", { name: "unlink" }));
    await confirmLast("unlink");
    expect(await screen.findByText("bob")).not.toBeNull();
    expect(screen.queryByText("code-aaaa")).toBeNull();
    expect(await screen.findByText(/recovery codes were hidden/)).not.toBeNull();
  });

  it("a revoke wins over an older in-flight reload whose grants still list the app", async () => {
    let late!: (r: Response) => void;
    let n = 0;
    setup((u) => u.endsWith("/grants") ? new Promise<Response>((r) => { late = r; n++; }) : json(LINKED));
    await screen.findByText("a app");
    fireEvent.click(screen.getByRole("button", { name: "unlink" }));
    await confirmLast("unlink"); // reload pending on grants
    await waitFor(() => expect(n).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "revoke" }));
    await confirmLast("revoke access");
    await waitFor(() => expect(screen.queryByText("a app")).toBeNull());
    late(json({ grants: [GRANT_A] })); // older answer: stale
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("a app")).toBeNull();
  });
});
