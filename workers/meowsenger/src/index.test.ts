import { describe, it, expect } from "vitest";
import { handle } from "./index";
import type { Env } from "./types";

const env = { CORS_ORIGINS: "http://localhost:4321" } as Env;
const ORIGIN = "http://localhost:4321";
const deps = { getDb: () => ({}) } as never;
const req = (m: string, p: string) => new Request(`https://meowsenger-api.alxnko.eu.org${p}`, { method: m, headers: { Origin: ORIGIN } });

describe("router", () => {
  it("answers OPTIONS with 204 + CORS", async () => {
    const res = await handle(req("OPTIONS", "/health"), env, deps);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
  it("GET /health returns 200 {ok:true}", async () => {
    const res = await handle(req("GET", "/health"), env, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it("unknown route → 404 JSON", async () => {
    const res = await handle(req("GET", "/nope"), env, deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
