// @vitest-environment jsdom
// Same harness as AccountSettings.test.tsx (jsdom by pragma, explicit cleanup, plain existence checks).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("Dashboard ordering and restore (PR-21 review)", () => {
  it("a late 200 from an older request never undoes a newer 401", async () => {
    let n = 0;
    let late!: (r: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => {
      if (init?.method === "POST") return Promise.resolve(json({ ok: true, clientId: "mw_new" }));
      const i = n++;
      return i === 0 ? Promise.resolve(json({ clients: [CLIENT], csrf: "c" })) : i === 1 ? new Promise<Response>((r) => { late = r; }) : Promise.resolve(json({}, 401));
    });
    render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
    await screen.findByText("My App");
    await createApp(); // reload #1 (stays pending)
    await waitFor(() => expect(n).toBe(2));
    await createApp(); // reload #2 -> 401
    expect(await screen.findByText(/to manage your apps/)).not.toBeNull();
    late(json({ clients: [CLIENT], csrf: "c" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("My App")).toBeNull();
    expect(screen.getByText(/to manage your apps/)).not.toBeNull();
  });

  it("'try again' is disabled while a refresh is running", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => {
      if (init?.method === "POST") return Promise.resolve(json({ ok: true, clientId: "mw_new" }));
      return n++ === 0 ? Promise.resolve(json({ clients: [CLIENT], csrf: "c" })) : n === 2 ? Promise.resolve(json({ error: "x" }, 500)) : new Promise<Response>(() => {});
    });
    render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
    await screen.findByText("My App");
    await createApp();
    const retry = await screen.findByRole("button", { name: "try again" });
    fireEvent.click(retry);
    await waitFor(() => expect((screen.getByRole("button", { name: "try again" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("a bfcache restore drops the shown apps at once and re-checks the session", async () => {
    let signedOut = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => signedOut ? json({}, 401) : json({ clients: [CLIENT], csrf: "c" }));
    render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
    await screen.findByText("My App");
    signedOut = true;
    act(() => { window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })); });
    expect(screen.queryByText("My App")).toBeNull();
    expect(await screen.findByText(/to manage your apps/)).not.toBeNull();
  });
});

describe("Dashboard one-time secrets, mutations and timeouts (PR-21 review 2)", () => {
  /** Load account A (csrf "c"), create an app (POST answers with a secret), whose reload GET answers with `after`. */
  async function createThenReload(after: () => Response) {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      if (init?.method === "POST") return json({ ok: true, clientId: "mw_new", clientSecret: "sec-of-A" });
      return n++ === 0 ? json({ clients: [CLIENT], csrf: "c" }) : after();
    });
    render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
    await screen.findByText("My App");
    await createApp();
  }

  it("a reload that answers for a different account (new CSRF) hides the previous account's one-time secret", async () => {
    await createThenReload(() => json({ clients: [{ ...CLIENT, clientId: "mw_b", displayName: "B App" }], csrf: "c2" }));
    expect(await screen.findByText("B App")).not.toBeNull();
    expect(screen.queryByText("sec-of-A")).toBeNull();
  });

  it("a reload with the same CSRF keeps the one-time secret visible", async () => {
    await createThenReload(() => json({ clients: [CLIENT], csrf: "c" }));
    await waitFor(() => expect(screen.getByText("sec-of-A")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("sec-of-A")).not.toBeNull();
  });

  it("a successful mutation wins over an older in-flight reload", async () => {
    let n = 0;
    let late!: (r: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => {
      if (init?.method === "POST") return Promise.resolve(json({ ok: true, clientId: "mw_new" }));
      return n++ === 0 ? Promise.resolve(json({ clients: [CLIENT], csrf: "c" })) : new Promise<Response>((r) => { late = r; });
    });
    render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "refresh tokens: off" }));
    expect(await screen.findByRole("button", { name: "refresh tokens: on" })).not.toBeNull();
    await createApp(); // reload pending
    await waitFor(() => expect(n).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "refresh tokens: on" }));
    expect(await screen.findByRole("button", { name: "refresh tokens: off" })).not.toBeNull();
    late(json({ clients: [{ ...CLIENT, allowOfflineAccess: true }], csrf: "c" })); // older answer: stale
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("button", { name: "refresh tokens: off" })).not.toBeNull();
  });

  it("a hung request ends in an honest error with 'try again' enabled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => new Promise<Response>((_, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      }));
      render(<ToastProvider><Dashboard base="https://api" /></ToastProvider>);
      await act(async () => { vi.advanceTimersByTime(16_000); });
      expect(screen.getByText("couldn't load your apps.")).not.toBeNull();
      expect((screen.getByRole("button", { name: "try again" }) as HTMLButtonElement).disabled).toBe(false);
    } finally { vi.useRealTimers(); }
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
