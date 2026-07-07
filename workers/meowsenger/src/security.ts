import type { Env } from "./types";
export const DEFAULT_ORIGINS = "https://meowsenger.alxnko.eu.org,http://localhost:4321";
function allowlist(env: Env): string[] {
  return ((env.CORS_ORIGINS ?? "").trim() || DEFAULT_ORIGINS).split(",").map((o) => o.trim()).filter(Boolean);
}
export function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && allowlist(env).includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
export function json(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors, ...extra } });
}
