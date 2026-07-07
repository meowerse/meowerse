import type { Deps } from "./db";
import type { Env } from "./types";

/**
 * Reliable Telegram avatar proxy (always the user's CURRENT photo).
 *
 * The Telegram Login Widget hands us a `t.me/i/userpic/...` snapshot URL whose
 * hash changes when the user swaps their photo — so the stored URL 404s and the
 * avatar goes stale. Instead of caching a URL, this endpoint fetches the CURRENT
 * largest profile photo from the Bot API on demand and streams the bytes.
 *
 * PUBLIC + UNCREDENTIALED BY DESIGN: avatars load via cross-origin `<img>` tags
 * (no cookies), so this returns `Access-Control-Allow-Origin: *` — NOT the
 * credentialed CORS used elsewhere — and needs no session/auth. The bot token is
 * never leaked into any response or error body.
 *
 * Bot-API load is bounded to ~1 fetch / 6h / user: the response carries
 * `Cache-Control: public, max-age=21600` so Cloudflare's edge serves cache hits
 * without ever hitting the worker, and we also try `caches.default` explicitly.
 */
export async function handleAvatar(
  req: Request,
  env: Env,
  deps: Deps,
  accountId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (cache) {
    const hit = await cache.match(req);
    if (hit) return hit;
  }

  // 404 helper — always no-store so a miss is never cached, and CORS-open so the
  // browser can read the (empty) body / status from a cross-origin <img>/fetch.
  const notFound = () =>
    new Response(JSON.stringify({ error: "no_avatar" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", ...cors },
    });

  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return notFound();

  const link = await deps.getDb().execute({
    sql: "SELECT telegram_id FROM telegram_links WHERE account_id = ?",
    args: [accountId],
  });
  const telegramId = link.rows[0]?.telegram_id;
  if (telegramId == null) return notFound();

  const doFetch = deps.fetch ?? fetch;
  const api = `https://api.telegram.org/bot${token}`;

  // 1) Newest set of profile photos; pick the LARGEST size (last element).
  const photosRes = await doFetch(`${api}/getUserProfilePhotos?user_id=${telegramId}&limit=1`);
  const photos = (await photosRes.json()) as {
    ok?: boolean;
    result?: { total_count?: number; photos?: { file_id?: string }[][] };
  };
  if (!photos.ok || !photos.result || (photos.result.total_count ?? 0) === 0) return notFound();
  const sizes = photos.result.photos?.[0];
  if (!sizes || sizes.length === 0) return notFound();
  const fileId = sizes[sizes.length - 1]?.file_id;
  if (!fileId) return notFound();

  // 2) Resolve the file path.
  const fileRes = await doFetch(`${api}/getFile?file_id=${fileId}`);
  const file = (await fileRes.json()) as { ok?: boolean; result?: { file_path?: string } };
  if (!file.ok || !file.result?.file_path) return notFound();

  // 3) Stream the image bytes through (only ever on a cache miss).
  const imgRes = await doFetch(`https://api.telegram.org/file/bot${token}/${file.result.file_path}`);
  if (!imgRes.ok) return notFound();

  const response = new Response(imgRes.body, {
    status: 200,
    headers: {
      "Content-Type": imgRes.headers.get("Content-Type") ?? "image/jpeg",
      "Cache-Control": "public, max-age=21600",
      "Access-Control-Allow-Origin": "*",
    },
  });
  // Explicit edge cache when an ExecutionContext is threaded; otherwise the
  // Cache-Control header alone lets Cloudflare cache it.
  if (cache) deps.ctx?.waitUntil?.(cache.put(req, response.clone()));
  return response;
}
