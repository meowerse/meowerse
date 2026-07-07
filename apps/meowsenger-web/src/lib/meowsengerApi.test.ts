import { describe, it, expect, vi } from "vitest";
import { getSession, loginUrl, logoutUrl } from "./meowsengerApi";

const BASE = "https://meowsenger-api.alxnko.eu.org";

describe("meowsengerApi", () => {
  it("loginUrl / logoutUrl build the BFF endpoints", () => {
    expect(loginUrl(BASE)).toBe(`${BASE}/auth/login`);
    expect(logoutUrl(BASE)).toBe(`${BASE}/auth/logout`);
  });
  it("getSession returns the parsed body (credentialed)", async () => {
    const body = { authenticated: true, user: { id: "u1", username: "alex", displayName: null, avatarUrl: null, verified: true } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getSession(BASE)).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/session`, { credentials: "include" });
    vi.unstubAllGlobals();
  });
  it("getSession returns authenticated:false on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await getSession(BASE)).toEqual({ authenticated: false });
    vi.unstubAllGlobals();
  });
});
