import { describe, it, expect, beforeEach } from "vitest";
import { handle } from "./index";
import type { Env, DbClient, Meow } from "./types";

const env: Env = {
  CORS_ORIGINS: "https://meow.alxnko.eu.org,http://localhost:4321",
  API_TOKEN: "s3cret",
  DATABASE_URL: "libsql://x",
  DATABASE_AUTH_TOKEN: "tok",
};

const ORIGIN = "http://localhost:4321";

/** In-memory fake libsql client; records statements and serves canned rows. */
function fakeDb(): DbClient & { rows: Meow[]; calls: string[] } {
  const state = {
    rows: [] as Meow[],
    calls: [] as string[],
    async execute(stmt: string | { sql: string; args: unknown[] }) {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      state.calls.push(sql);
      if (sql.startsWith("CREATE TABLE")) return { rows: [] };
      if (sql.startsWith("SELECT")) {
        return { rows: state.rows as unknown as Record<string, unknown>[] };
      }
      if (sql.startsWith("INSERT")) {
        const args = (stmt as { args: unknown[] }).args;
        const id = state.rows.length + 1;
        const row: Meow = {
          id,
          text: String(args[0]),
          slug: String(args[1]),
          created_at: "2026-01-01 00:00:00",
        };
        state.rows.unshift(row);
        return { rows: [], lastInsertRowid: id };
      }
      return { rows: [] };
    },
  };
  return state;
}

function deps(db: DbClient) {
  // Fresh schema promise per call so isolate caching does not leak across tests.
  return { getDb: () => db, schemaReady: undefined as Promise<void> | undefined };
}

let db: ReturnType<typeof fakeDb>;
let d: ReturnType<typeof deps>;
beforeEach(() => {
  db = fakeDb();
  d = deps(db);
});

const req = (method: string, path: string, body?: unknown, auth = true) =>
  new Request(`https://api.meow.alxnko.eu.org${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      ...(auth ? { Authorization: "Bearer s3cret" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

describe("router basics", () => {
  it("answers OPTIONS preflight with 204 and CORS headers", async () => {
    const res = await handle(req("OPTIONS", "/api/meows"), env, d);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("returns 404 JSON for unknown routes", async () => {
    const res = await handle(req("GET", "/api/nope"), env, d);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("GET /api/meows", () => {
  it("lists meows publicly (no auth) as JSON with cache headers", async () => {
    db.rows.push({ id: 1, text: "hi", slug: "hi", created_at: "t" });
    const res = await handle(req("GET", "/api/meows", undefined, false), env, d);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=10");
    expect(await res.json()).toEqual([{ id: 1, text: "hi", slug: "hi", created_at: "t" }]);
  });
});

describe("POST /api/meows", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await handle(req("POST", "/api/meows", { text: "hi" }, false), env, d);
    expect(res.status).toBe(401);
  });

  it("creates a meow and returns 201 + the row with a slug", async () => {
    const res = await handle(req("POST", "/api/meows", { text: "Hello World" }), env, d);
    expect(res.status).toBe(201);
    const row = (await res.json()) as Meow;
    expect(row.text).toBe("Hello World");
    expect(row.slug).toBe("hello-world");
    expect(row.id).toBe(1);
  });

  it("rejects empty text with 400", async () => {
    const res = await handle(req("POST", "/api/meows", { text: "   " }), env, d);
    expect(res.status).toBe(400);
  });

  it("rejects text over 280 chars with 400", async () => {
    const res = await handle(req("POST", "/api/meows", { text: "x".repeat(281) }), env, d);
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400 (not 500)", async () => {
    const bad = new Request("https://api/api/meows", {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: "Bearer s3cret", "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await handle(bad, env, d);
    expect(res.status).toBe(400);
  });

  it("rejects a non-string text field with 400", async () => {
    const res = await handle(req("POST", "/api/meows", { text: 42 }), env, d);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/batch", () => {
  it("requires auth", async () => {
    const res = await handle(req("POST", "/api/batch", { ops: [] }, false), env, d);
    expect(res.status).toBe(401);
  });

  it("executes create ops sequentially and returns per-op status", async () => {
    const res = await handle(
      req("POST", "/api/batch", { ops: [{ op: "create", text: "one" }, { op: "create", text: "two" }] }),
      env,
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { status: number }[] };
    expect(body.results).toHaveLength(2);
    expect(body.results[0].status).toBe(201);
    expect(body.results[1].status).toBe(201);
  });

  it("reports per-op 400 for an invalid op without failing the batch", async () => {
    const res = await handle(
      req("POST", "/api/batch", { ops: [{ op: "create", text: "" }, { op: "bogus" }] }),
      env,
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { status: number }[] };
    expect(body.results[0].status).toBe(400);
    expect(body.results[1].status).toBe(400);
  });

  it("rejects more than 25 ops with 400", async () => {
    const ops = Array.from({ length: 26 }, () => ({ op: "create", text: "x" }));
    const res = await handle(req("POST", "/api/batch", { ops }), env, d);
    expect(res.status).toBe(400);
  });

  it("rejects a non-array ops field with 400", async () => {
    const res = await handle(req("POST", "/api/batch", { ops: "nope" }), env, d);
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const bad = new Request("https://api/api/batch", {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: "Bearer s3cret", "Content-Type": "application/json" },
      body: "@@@",
    });
    const res = await handle(bad, env, d);
    expect(res.status).toBe(400);
  });
});
