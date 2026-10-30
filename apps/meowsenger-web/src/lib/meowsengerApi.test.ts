import { describe, it, expect, vi } from "vitest";
import { getSession, loginUrl, logoutUrl } from "./meowsengerApi";

const BASE = "https://meowsenger-api.alxnko.eu.org";

describe("meowsengerApi", () => {
  it("loginUrl / logoutUrl build the BFF endpoints", () => {
    expect(loginUrl(BASE)).toBe(`${BASE}/auth/login`);
    expect(logoutUrl(BASE)).toBe(`${BASE}/auth/logout`);
  });
  it("getSession returns the typed ok result (credentialed)", async () => {
    const body = { authenticated: true, user: { id: "u1", username: "alex", displayName: null, avatarUrl: null, verified: true } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getSession(BASE)).toEqual({ ok: true, status: 200, data: body });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/session`, expect.objectContaining({ credentials: "include" }));
    vi.unstubAllGlobals();
  });
  it("a 200 {authenticated:false} is the only definitive signed-out answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })));
    expect(await getSession(BASE)).toEqual({ ok: true, status: 200, data: { authenticated: false } });
    vi.unstubAllGlobals();
  });
  it.each([
    ["network error", () => { throw new Error("offline"); }, { kind: "network" }],
    ["500 HTML", () => new Response("<html>oops</html>", { status: 500 }), { kind: "http", status: 500, body: null }],
    ["503 JSON", () => new Response("{}", { status: 503 }), { kind: "http", status: 503, body: {} }],
    ["401", () => new Response("{}", { status: 401 }), { kind: "unauthorized", status: 401 }],
  ])("getSession %s is a typed error, never {authenticated:false}", async (_n, impl, error) => {
    vi.stubGlobal("fetch", vi.fn(async () => impl()));
    expect(await getSession(BASE)).toEqual({ ok: false, error });
    vi.unstubAllGlobals();
  });
});
