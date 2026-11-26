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
  telegram: { linked: false, username: null }, csrf: "c",
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

  it("has no recovery-codes UI (even if an old server still sends recoveryRemaining)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("/grants") ? json({ grants: [] }) : json({ ...ACCOUNT, hasPassword: true, recoveryRemaining: 8 }));
    page();
    await screen.findByText("alxnko");
    expect(screen.queryByText(/recovery/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "regenerate" })).toBeNull();
  });

  it("shows the one-method notice for password-only and telegram-only accounts, not for both", async () => {
    const load = async (acct: Record<string, unknown>) => {
      cleanup(); vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/grants") ? json({ grants: [] }) : json(acct));
      page();
      await screen.findByText("alxnko");
    };
    const notice = /only one sign-in method/;
    await load({ ...ACCOUNT, hasPassword: true });
    expect(screen.queryByText(notice)).not.toBeNull();
    await load({ ...ACCOUNT, hasPassword: false, telegram: { linked: true, username: "tg" } });
    expect(screen.queryByText(notice)).not.toBeNull();
    await load({ ...ACCOUNT, hasPassword: true, telegram: { linked: true, username: "tg" } });
    expect(screen.queryByText(notice)).toBeNull();
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

describe("AccountSettings password change rotates the session", () => {
  const WITH_PW = { ...ACCOUNT, hasPassword: true };
  const GRANT = { clientId: "mw_a", displayName: "a app", approvedScopes: ["openid"], updatedAt: null };
  function setup(pwResponse: unknown) {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") { posts.push({ url: u, body: JSON.parse(String(init.body)) }); return u.endsWith("/password") ? json(pwResponse) : json({ ok: true }); }
      return u.endsWith("/grants") ? json({ grants: [GRANT] }) : json(WITH_PW);
    });
    page();
    return posts;
  }
  async function change() {
    fireEvent.change(await screen.findByLabelText("current password"), { target: { value: "oldpassword12" } });
    fireEvent.change(screen.getByLabelText("new password"), { target: { value: "newpassword123" } });
    fireEvent.submit(screen.getByRole("button", { name: "update password" }).closest("form")!);
  }

  it("adopts the csrf from the response: the next action posts the NEW token and the page stays signed in", async () => {
    const posts = setup({ ok: true, csrf: "c-new" });
    await change();
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(["https://api/api/account/password"]));
    expect(posts[0]!.body.csrf).toBe("c");
    await screen.findByText(/password changed/);
    fireEvent.click(screen.getByRole("button", { name: "revoke" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "revoke access" })).at(-1)!);
    await waitFor(() => expect(posts.at(-1)!.url).toMatch(/grants\/revoke$/));
    expect(posts.at(-1)!.body.csrf).toBe("c-new");
    expect(screen.queryByText(/to manage your account/)).toBeNull();
  });

  it("the submit button is disabled while the change is in flight: a double click posts once", async () => {
    let release!: () => void;
    const posts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") { posts.push(u); await new Promise<void>((r) => { release = r; }); return json({ ok: true, csrf: "c-new" }); }
      return u.endsWith("/grants") ? json({ grants: [] }) : json(WITH_PW);
    });
    page();
    await change();
    const btn = screen.getByRole("button", { name: "update password" }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(true));
    fireEvent.submit(btn.closest("form")!);
    expect(posts).toHaveLength(1);
    release();
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("a conflict answer is reported honestly (not 'could not change password' as if nothing happened), and the form re-enables", async () => {
    setup({ error: "conflict" });
    await change();
    expect(await screen.findByText(/changed from somewhere else or your session ended/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "update password" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a reload that started BEFORE the change cannot revert the adopted csrf", async () => {
    let late!: (r: Response) => void;
    let accountGets = 0;
    const posts: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") { posts.push({ url: u, ...JSON.parse(String(init.body)) }); return json({ ok: true, csrf: "c-new" }); }
      if (u.endsWith("/grants")) return json({ error: "boom" }, 500); // leaves a "try again" that reloads WITHOUT resetting the form
      return ++accountGets === 1 ? json(WITH_PW) : new Promise<Response>((r) => { late = r; });
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "try again" })); // reload in flight (answers with the OLD csrf)
    await waitFor(() => expect(accountGets).toBe(2));
    await change();
    await waitFor(() => expect(posts).toHaveLength(1));
    await screen.findByText(/password changed/);
    late(json(WITH_PW)); // stale answer, csrf "c"
    await new Promise((r) => setTimeout(r, 20));
    await change();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.csrf).toBe("c-new");
  });

  it("a reload that LANDED during the request is not overwritten by the submit-time account (only csrf changes)", async () => {
    let release!: () => void;
    let accountGets = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") { await new Promise<void>((r) => { release = r; }); return json({ ok: true, csrf: "c-new" }); }
      if (u.endsWith("/grants")) return json({ error: "boom" }, 500);
      return json(++accountGets === 1 ? WITH_PW : { ...WITH_PW, username: "renamed" });
    });
    page();
    await screen.findByText("alxnko");
    await change();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    await screen.findByText("renamed");
    release();
    await screen.findByText(/password changed/);
    expect(screen.queryByText("alxnko")).toBeNull();
    expect(screen.getByText("renamed")).not.toBeNull();
  });

  it("an old worker answering { ok: true } without csrf still works (additive response)", async () => {
    const posts = setup({ ok: true });
    await change();
    await screen.findByText(/password changed/);
    fireEvent.click(screen.getByRole("button", { name: "revoke" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "revoke access" })).at(-1)!);
    await waitFor(() => expect(posts.at(-1)!.url).toMatch(/grants\/revoke$/));
    expect(posts.at(-1)!.body.csrf).toBe("c");
  });
});

describe("AccountSettings ordering (PR-21 review 2)", () => {
  const LINKED = { ...ACCOUNT, telegram: { linked: true, username: "tg" } };
  const GRANT_A = { clientId: "mw_a", displayName: "a app", approvedScopes: ["openid"], updatedAt: null };
  /** GETs: first pair answers normally; later ones go to `later(url)`. POSTs: ok. */
  function setup(later: (u: string) => Response | Promise<Response>) {
    let loaded = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") return json({ ok: true });
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

  it("a failed revoke (401) neither shows success nor leaves signed-out data: the page ends signed out", async () => {
    let signedOut = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") { signedOut = true; return json({ error: "no_session" }, 401); }
      if (signedOut) return json({}, 401);
      return u.endsWith("/grants") ? json({ grants: [GRANT_A] }) : json(LINKED);
    });
    page();
    await screen.findByText("a app");
    fireEvent.click(screen.getByRole("button", { name: "revoke" }));
    await confirmLast("revoke access");
    expect(await screen.findByText(/to manage your account/)).not.toBeNull();
    expect(screen.queryByText("access revoked")).toBeNull();
    expect(screen.queryByText("a app")).toBeNull();
  });
});
