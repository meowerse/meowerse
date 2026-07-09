import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handle } from "./index";
import worker from "./index";
import { ensureSchema, prodDeps, SCHEMA } from "./db";
import type { Env, DbClient, Meow } from "./types";

const env: Env = {
  CORS_ORIGINS: "http://localhost:4321",
  API_TOKEN: "s3cret",
  DATABASE_URL: "libsql://x",
  DATABASE_AUTH_TOKEN: "tok",
};

function fakeDb(rows: Meow[] = []): DbClient & { count: number } {
  const state = {
    count: 0,
    async execute() {
      state.count++;
      return { rows: rows as unknown as Record<string, unknown>[] };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      state.count++;
      return stmts.map(() => ({ rows: rows as unknown as Record<string, unknown>[] }));
    },
  };
  return state;
}

describe("edge cache (Cache API)", () => {
  let store: Map<string, Response>;
  beforeEach(() => {
    store = new Map();
    (globalThis as { caches?: unknown }).caches = {
      default: {
        async match(key: Request) {
          return store.get(key.url)?.clone();
        },
        async put(key: Request, res: Response) {
          store.set(key.url, res.clone());
        },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  it("misses then stores on first GET, hits on the second (no extra db read)", async () => {
    const db = fakeDb([{ id: 1, text: "hi", slug: "hi", created_at: "t" }]);
    const deps = { getDb: () => db, schemaReady: undefined as Promise<void> | undefined };
    const r = () => new Request("https://api/api/meows", { headers: { Origin: "http://localhost:4321" } });

    const first = await handle(r(), env, deps);
    expect(first.status).toBe(200);
    expect(await first.json()).toHaveLength(1);
    const dbCallsAfterFirst = db.count;

    const second = await handle(r(), env, deps);
    expect(second.status).toBe(200);
    expect(await second.json()).toHaveLength(1);
    // Cache hit: no further db.execute calls.
    expect(db.count).toBe(dbCallsAfterFirst);
  });
});

describe("write-through cache purge", () => {
  let store: Map<string, Response>;
  let deletes: string[];
  beforeEach(() => {
    store = new Map();
    deletes = [];
    (globalThis as { caches?: unknown }).caches = {
      default: {
        async match(key: Request) {
          return store.get(key.url)?.clone();
        },
        async put(key: Request, res: Response) {
          store.set(key.url, res.clone());
        },
        async delete(key: Request) {
          deletes.push(key.url);
          return store.delete(key.url);
        },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  const listKey = "https://api/api/meows";

  it("purges the list cache entry after a successful POST /api/meows", async () => {
    const db = fakeDb();
    const deps = { getDb: () => db, schemaReady: undefined as Promise<void> | undefined };
    // Prime the cache so there is something to purge.
    store.set(listKey, new Response("[]"));

    const res = await handle(
      new Request(listKey, {
        method: "POST",
        headers: {
          Origin: "http://localhost:4321",
          Authorization: "Bearer s3cret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "fresh" }),
      }),
      env,
      deps,
    );
    expect(res.status).toBe(201);
    expect(deletes).toContain(listKey);
    expect(store.has(listKey)).toBe(false);
  });

  it("purges the list cache entry after a successful POST /api/batch", async () => {
    const db = fakeDb();
    const deps = { getDb: () => db, schemaReady: undefined as Promise<void> | undefined };
    store.set(listKey, new Response("[]"));

    const res = await handle(
      new Request("https://api/api/batch", {
        method: "POST",
        headers: {
          Origin: "http://localhost:4321",
          Authorization: "Bearer s3cret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ops: [{ op: "create", text: "a" }] }),
      }),
      env,
      deps,
    );
    expect(res.status).toBe(200);
    expect(deletes).toContain(listKey);
    expect(store.has(listKey)).toBe(false);
  });
});

describe("ensureSchema memoization", () => {
  it("runs the migration only once across many calls", async () => {
    const db = fakeDb();
    const deps = { getDb: () => db, schemaReady: undefined as Promise<void> | undefined };
    await ensureSchema(deps);
    await ensureSchema(deps);
    await ensureSchema(deps);
    expect(db.count).toBe(1);
    expect(SCHEMA).toContain("CREATE TABLE IF NOT EXISTS meows");
  });
});

describe("prodDeps", () => {
  it("memoizes a single client and builds it from env", () => {
    const deps = prodDeps(env);
    const a = deps.getDb();
    const b = deps.getDb();
    expect(a).toBe(b);
  });
});

describe("default export fetch", () => {
  it("returns 500 with CORS when a handler throws, without leaking details", async () => {
    const spy = vi.spyOn(URL.prototype, "pathname", "get").mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await worker.fetch(
      new Request("https://api/api/meows", { headers: { Origin: "http://localhost:4321" } }),
      env,
    );
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4321");
    expect(await res.json()).toEqual({ error: "internal error" });
  });

  it("routes a normal request through fetch (smoke)", async () => {
    // prodDeps will create a real client lazily, but a 404 route never calls db.
    const res = await worker.fetch(
      new Request("https://api/api/nope", { headers: { Origin: "http://localhost:4321" } }),
      env,
    );
    expect(res.status).toBe(404);
  });
});
