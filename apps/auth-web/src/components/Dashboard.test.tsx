// @vitest-environment jsdom
// Same harness as AccountSettings.test.tsx (jsdom by pragma, explicit cleanup, plain existence checks).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@meowerse/ui";
import Dashboard from "./Dashboard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CLIENT = { clientId: "mw_1", name: "my-app", displayName: "My App", clientType: "public", allowedScopes: ["openid", "offline_access"], verifiedOnly: false, allowOfflineAccess: false, status: "active" };

const createApp = async () => {
  fireEvent.change(await screen.findByLabelText(/^name/), { target: { value: "my-app" } });
  fireEvent.change(screen.getByLabelText("redirect uri"), { target: { value: "https://x.app/cb" } });
  fireEvent.click(screen.getByRole("button", { name: "create app" }));
};
/** Loads one app, then creates another: the create's reload() GET answers with `after`. */
const revalidateWith = async (after: () => Response) => {
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
    if (init?.method === "POST") return json({ ok: true, clientId: "mw_new" });
    return n++ === 0 ? json({ clients: [CLIENT], csrf: "c" }) : after();
  });
  render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
  await screen.findByText("My App");
  await createApp();
};

describe("Dashboard stale-while-revalidate (PR-21)", () => {
  it("shows a skeleton, no spinner, and a disabled create until the first answer", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const { container } = render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
    expect(screen.getByRole("status", { name: "loading your apps" })).not.toBeNull();
    expect(container.querySelector(".mw-spinner")).toBeNull();
    expect((screen.getByRole("button", { name: "create app" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed first load is an error with retry, not a false 'no apps yet'", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: "x" }, 500));
    render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
    expect(await screen.findByText("couldn't load your apps.")).not.toBeNull();
    expect(screen.queryByText("no apps yet.")).toBeNull();
  });

  it("a failed revalidate keeps the loaded apps and shows the error", async () => {
    await revalidateWith(() => json({ error: "x" }, 500));
    expect(await screen.findByText(/couldn't refresh your apps/)).not.toBeNull();
    expect(screen.getByText("My App")).not.toBeNull();
    expect(screen.queryByText("no apps yet.")).toBeNull();
  });

  it("a signed-out answer on revalidate drops the apps, asks to sign in and clears the session cache", async () => {
    sessionStorage.setItem("mw-session", "stale");
    await revalidateWith(() => json({}, 401));
    expect(await screen.findByText(/to manage your apps/)).not.toBeNull();
    expect(screen.queryByText("My App")).toBeNull();
    expect(sessionStorage.getItem("mw-session")).toBeNull();
  });
});

describe("Dashboard refresh-token toggle (M7)", () => {
  it("create form sends offline=true when 'allow refresh tokens' is ticked", async () => {
    const calls: { url: string; body: Record<string, string> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === "POST") {
        calls.push({ url: u, body: JSON.parse(String(init.body)) });
        return json({ ok: true, clientId: "mw_new" });
      }
      return json({ clients: [], csrf: "c" });
    });
    render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
    fireEvent.change(await screen.findByLabelText(/^name/), { target: { value: "my-app" } });
    fireEvent.change(screen.getByLabelText("redirect uri"), { target: { value: "https://x.app/cb" } });
    fireEvent.click(screen.getByLabelText(/allow refresh tokens/));
    fireEvent.click(screen.getByRole("button", { name: "create app" }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].body.offline).toBe("true");
  });

  it("per-app toggle posts the update with offline and flips the label", async () => {
    const calls: { url: string; body: Record<string, string> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return json({ ok: true });
      }
      return json({ clients: [CLIENT], csrf: "c" });
    });
    render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "refresh tokens: off" }));
    expect(await screen.findByRole("button", { name: "refresh tokens: on" })).not.toBeNull();
    expect(calls[0].url).toBe("https://api/api/dev/clients/update");
    expect(calls[0].body).toMatchObject({ client_id: "mw_1", offline: "true", csrf: "c" });
  });
});
