import { test, expect } from "vitest";
import { handleAvatar } from "../src/avatar";
import { routedDb, type Route } from "./helpers";
import type { Deps } from "../src/db";
import type { Env } from "../src/types";

const CORS = { "Access-Control-Allow-Credentials": "true" };
const ACCT = "acct_1";

// telegram_links lookup → returns the linked telegram_id (or empty for "no link").
const linkRoute = (telegramId: number | null): Route => [
  /SELECT telegram_id FROM telegram_links WHERE account_id/,
  () => ({ rows: telegramId == null ? [] : [{ telegram_id: telegramId }] }),
];

/**
 * A fetch stub that dispatches on the Telegram Bot API URL. `photos` is the
 * `getUserProfilePhotos` result; each subsequent call resolves getFile then the
 * image bytes. Every request URL is recorded so tests can assert what ran.
 */
function fakeFetch(opts: {
  photos: { ok: boolean; result?: { total_count: number; photos: { file_id: string; width: number; height: number }[][] } };
  file?: { ok: boolean; result?: { file_path: string } };
  imgOk?: boolean;
  imgContentType?: string | null;
  urls: string[];
}): typeof fetch {
  return (async (url: string) => {
    opts.urls.push(url);
    if (url.includes("/getUserProfilePhotos")) {
      return { json: async () => opts.photos } as unknown as Response;
    }
    if (url.includes("/getFile")) {
      return { json: async () => opts.file } as unknown as Response;
    }
    // image bytes. `imgContentType` defaults to "image/png"; pass `null`
    // explicitly to exercise the worker's own `?? "image/jpeg"` fallback.
    const ct = "imgContentType" in opts ? opts.imgContentType : "image/png";
    return {
      ok: opts.imgOk ?? true,
      body: "IMG_BYTES" as unknown as ReadableStream,
      headers: { get: (h: string) => (h === "Content-Type" ? ct : null) },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const req = () => new Request(`https://iss/avatar/${ACCT}`);

test("no TELEGRAM_BOT_TOKEN → 404 no_avatar, no-store, never touches the DB or network", async () => {
  const urls: string[] = [];
  let dbCalled = false;
  const deps = {
    getDb: () => {
      dbCalled = true;
      return routedDb([]);
    },
    fetch: fakeFetch({ photos: { ok: true }, urls }),
  } as unknown as Deps;
  const res = await handleAvatar(req(), {} as Env, deps, ACCT, CORS);
  expect(res.status).toBe(404);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({ error: "no_avatar" });
  expect(dbCalled).toBe(false);
  expect(urls).toEqual([]);
});

test("no telegram link → 404", async () => {
  const urls: string[] = [];
  const deps = { getDb: () => routedDb([linkRoute(null)]), fetch: fakeFetch({ photos: { ok: true }, urls }) } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(404);
  expect(urls).toEqual([]); // never calls the Bot API
});

test("total_count 0 → 404", async () => {
  const urls: string[] = [];
  const deps = {
    getDb: () => routedDb([linkRoute(42)]),
    fetch: fakeFetch({ photos: { ok: true, result: { total_count: 0, photos: [] } }, urls }),
  } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(404);
});

test("getUserProfilePhotos ok:false → 404", async () => {
  const urls: string[] = [];
  const deps = { getDb: () => routedDb([linkRoute(42)]), fetch: fakeFetch({ photos: { ok: false }, urls }) } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(404);
});

test("getFile ok:false → 404 (after picking the largest size)", async () => {
  const urls: string[] = [];
  const deps = {
    getDb: () => routedDb([linkRoute(42)]),
    fetch: fakeFetch({
      photos: {
        ok: true,
        result: { total_count: 1, photos: [[{ file_id: "small", width: 40, height: 40 }, { file_id: "big", width: 640, height: 640 }]] },
      },
      file: { ok: false },
      urls,
    }),
  } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(404);
  // picked the LARGEST size (last element) for getFile
  expect(urls.some((u) => u.includes("/getFile?file_id=big"))).toBe(true);
});

test("happy path → 200, image content-type, 6h public cache, largest size, no token leak", async () => {
  const urls: string[] = [];
  const deps = {
    getDb: () => routedDb([linkRoute(42)]),
    fetch: fakeFetch({
      photos: {
        ok: true,
        result: { total_count: 3, photos: [[{ file_id: "small", width: 40, height: 40 }, { file_id: "big", width: 640, height: 640 }]] },
      },
      file: { ok: true, result: { file_path: "photos/file_9.jpg" } },
      imgContentType: "image/png",
      urls,
    }),
  } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "SECRET_TOKEN" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("image/png");
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=21600");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  // used the largest size's file_id for getFile, then streamed that file_path
  expect(urls.some((u) => u.includes("/getFile?file_id=big"))).toBe(true);
  expect(urls.some((u) => u.includes("/file/bot") && u.includes("photos/file_9.jpg"))).toBe(true);
  // the bot token never appears in any header value
  for (const v of [...res.headers.values()]) expect(v).not.toContain("SECRET_TOKEN");
});

test("ok:true but result missing → 404 (defensive middle branch)", async () => {
  const urls: string[] = [];
  const deps = {
    getDb: () => routedDb([linkRoute(42)]),
    fetch: fakeFetch({ photos: { ok: true }, urls }),
  } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(404);
});

test("empty inner size array → 404", async () => {
  const urls: string[] = [];
  const deps = {
    getDb: () => routedDb([linkRoute(42)]),
    fetch: fakeFetch({ photos: { ok: true, result: { total_count: 1, photos: [[]] } }, urls }),
  } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(404);
});

test("largest size lacks a file_id → 404", async () => {
  const urls: string[] = [];
  const deps = {
    getDb: () => routedDb([linkRoute(42)]),
    fetch: fakeFetch({ photos: { ok: true, result: { total_count: 1, photos: [[{ width: 640, height: 640 } as never]] } }, urls }),
  } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(404);
});

test("null upstream Content-Type falls back to image/jpeg", async () => {
  const urls: string[] = [];
  const deps = {
    getDb: () => routedDb([linkRoute(42)]),
    fetch: fakeFetch({
      photos: { ok: true, result: { total_count: 1, photos: [[{ file_id: "big", width: 640, height: 640 }]] } },
      file: { ok: true, result: { file_path: "photos/x.jpg" } },
      imgContentType: null,
      urls,
    }),
  } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("image/jpeg");
});

test("falls back to global fetch when deps.fetch is unset", async () => {
  const g = globalThis as { fetch: typeof fetch };
  const prev = g.fetch;
  const urls: string[] = [];
  g.fetch = fakeFetch({
    photos: { ok: true, result: { total_count: 1, photos: [[{ file_id: "big", width: 640, height: 640 }]] } },
    file: { ok: true, result: { file_path: "photos/x.jpg" } },
    urls,
  });
  try {
    const deps = { getDb: () => routedDb([linkRoute(42)]) } as unknown as Deps; // no fetch injected
    const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
    expect(res.status).toBe(200);
    expect(urls.length).toBe(3); // getUserProfilePhotos, getFile, image — all via global fetch
  } finally {
    g.fetch = prev;
  }
});

test("a traversal/absolute file_path is rejected → 404, image bytes never fetched", async () => {
  // Defense-in-depth: even though Telegram controls file_path, a value that could
  // escape the /file/bot<token>/ prefix must be refused before we build the URL.
  for (const bad of ["../../etc/passwd", "/etc/passwd", "photos/../../x", "http://evil/x", "a//b"]) {
    const urls: string[] = [];
    const deps = {
      getDb: () => routedDb([linkRoute(42)]),
      fetch: fakeFetch({
        photos: { ok: true, result: { total_count: 1, photos: [[{ file_id: "big", width: 640, height: 640 }]] } },
        file: { ok: true, result: { file_path: bad } },
        urls,
      }),
    } as unknown as Deps;
    const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
    expect(res.status).toBe(404);
    // getUserProfilePhotos + getFile ran, but the image byte fetch never did.
    expect(urls.some((u) => u.includes("/file/bot"))).toBe(false);
  }
});

test("image fetch not ok → 404", async () => {
  const urls: string[] = [];
  const deps = {
    getDb: () => routedDb([linkRoute(42)]),
    fetch: fakeFetch({
      photos: { ok: true, result: { total_count: 1, photos: [[{ file_id: "big", width: 640, height: 640 }]] } },
      file: { ok: true, result: { file_path: "photos/x.jpg" } },
      imgOk: false,
      urls,
    }),
  } as unknown as Deps;
  const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
  expect(res.status).toBe(404);
});

test("edge cache hit is returned without touching DB or Bot API", async () => {
  const cached = new Response("CACHED", { status: 200, headers: { "Content-Type": "image/jpeg" } });
  const g = globalThis as { caches?: unknown };
  const prev = g.caches;
  let putCalled = false;
  g.caches = {
    default: {
      match: async () => cached,
      put: async () => {
        putCalled = true;
      },
    },
  };
  try {
    let dbCalled = false;
    const urls: string[] = [];
    const deps = {
      getDb: () => {
        dbCalled = true;
        return routedDb([]);
      },
      fetch: fakeFetch({ photos: { ok: true }, urls }),
    } as unknown as Deps;
    const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
    expect(await res.text()).toBe("CACHED");
    expect(dbCalled).toBe(false);
    expect(urls).toEqual([]);
    expect(putCalled).toBe(false);
  } finally {
    g.caches = prev;
  }
});

test("on cache miss the response is put into the edge cache via ctx.waitUntil", async () => {
  const g = globalThis as { caches?: unknown };
  const prev = g.caches;
  let putArg: Request | undefined;
  g.caches = {
    default: {
      match: async () => undefined,
      put: async (r: Request) => {
        putArg = r;
      },
    },
  };
  try {
    const waited: Promise<unknown>[] = [];
    const urls: string[] = [];
    const deps = {
      getDb: () => routedDb([linkRoute(42)]),
      fetch: fakeFetch({
        photos: { ok: true, result: { total_count: 1, photos: [[{ file_id: "big", width: 640, height: 640 }]] } },
        file: { ok: true, result: { file_path: "photos/x.jpg" } },
        urls,
      }),
      ctx: { waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as ExecutionContext,
    } as unknown as Deps;
    const res = await handleAvatar(req(), { TELEGRAM_BOT_TOKEN: "T" } as Env, deps, ACCT, CORS);
    expect(res.status).toBe(200);
    expect(waited.length).toBe(1); // cache.put deferred off the response path
    await Promise.all(waited);
    expect(putArg).toBeDefined();
  } finally {
    g.caches = prev;
  }
});
