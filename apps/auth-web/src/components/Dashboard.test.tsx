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
