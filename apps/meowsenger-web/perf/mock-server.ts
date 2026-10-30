// Tier-A mock backend (PR-0): serves the built dist/ with the real _headers (CSP included, gzip) and fakes the
// meowsenger API + WebSockets from fixtures. Real sockets (Bun.serve), so WS timing is genuine.
// Control plane (harness only, never reachable from the app's CSP-allowed origins in prod): /__mock/*.
//   POST /__mock/config {apiMs?, wsOpenMs?, jitterMs? (uniform +-, seeded), routeMs?: {"/messages": 400}, failChatsPoll?: boolean, dropAck?: boolean (persist sends but never ack)}
//   POST /__mock/reset  rebuild fixtures + zero counters + default config
//   POST /__mock/drop   closes every conversation socket with code 1006-ish (1011) -> client reconnects
//   POST /__mock/push {chat, body, sender?}   a peer message into a chat (conversation sockets + inbox delta)
//   POST /__mock/frame {chat, frame}   broadcast an arbitrary server frame (typing, reaction, ...) to a chat's sockets
//   GET  /__mock/stats  request counts by route, ws opens/closes by kind; POST /__mock/reset zeroes them
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";
import { headersFor, parseHeaders } from "@meowerse/ui/seo";
import { buildFixtures, ME, rng, summary, selfCheck, type ChatFx, type Msg } from "./fixtures";

type WsData = { kind: "chat" | "inbox"; chatId?: string };
export type MockServer = { port: number; url: string; stop: () => void };
declare const Bun: { serve: (o: unknown) => { port: number; stop: (force?: boolean) => void; upgrade: (r: Request, o: unknown) => boolean } };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
};
const COMPRESS = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".txt", ".xml"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startMock(distDir: string, port = 0, defaults = { apiMs: 150, wsOpenMs: 120 }): MockServer {
  let fx: ChatFx[] = [];
  let byId = new Map<string, ChatFx>();
  const load = () => { fx = buildFixtures(); selfCheck(fx); byId = new Map(fx.map((c) => [c.id, c])); };
  load();
  const rules = parseHeaders(readFileSync(join(distDir, "_headers"), "utf8"));
  const cfg = { ...defaults, routeMs: {} as Record<string, number>, failChatsPoll: false, dropAck: false, jitterMs: 0 };
  const jit = rng(4242); // seeded: the same jitter sequence every run
  const delay = (base: number) => sleep(Math.max(0, base + (jit() * 2 - 1) * cfg.jitterMs));
  const stats = { http: {} as Record<string, number>, wsOpen: { chat: 0, inbox: 0 }, wsClose: { chat: 0, inbox: 0 } };
  const socks = new Set<{ send: (s: string) => void; close: (c?: number) => void; data: WsData }>();
  let seq = 0;

  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const order = (c: ChatFx) => fx.indexOf(c);

  function staticFile(pathname: string, acceptGzip: boolean): Response {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    let f = join(distDir, rel);
    if (!f.startsWith(distDir)) return new Response("nope", { status: 404 });
    let status = 200;
    if (existsSync(f) && statSync(f).isDirectory()) {
      if (!pathname.endsWith("/")) return new Response(null, { status: 308, headers: { location: pathname + "/" } });
      f = join(f, "index.html");
    }
    if (!existsSync(f)) { f = join(distDir, "404.html"); status = 404; }
    const headers: Record<string, string> = Object.fromEntries(headersFor(rules, pathname));
    const ext = extname(f);
    headers["content-type"] = TYPES[ext] ?? "application/octet-stream";
    let body: Uint8Array = readFileSync(f);
    if (COMPRESS.has(ext) && acceptGzip) { body = gzipSync(body); headers["content-encoding"] = "gzip"; headers.vary = "Accept-Encoding"; }
    return new Response(body as unknown as BodyInit, { status, headers });
  }

  function page(c: ChatFx, before: string | null): Msg[] {
    const end = before ? c.messages.findIndex((m) => m.id === before) : c.messages.length;
    return c.messages.slice(Math.max(0, end - 50), Math.max(0, end));
  }

  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    async fetch(req: Request, srv: { upgrade: (r: Request, o: unknown) => boolean }) {
      const url = new URL(req.url);
      const p = url.pathname;
      // -------- control plane
      if (p.startsWith("/__mock/")) {
        if (p === "/__mock/config") { const b = (await req.json()) as Partial<typeof cfg>; Object.assign(cfg, b); return json({ ok: true, cfg }); }
        if (p === "/__mock/reset") { load(); cfg.routeMs = {}; cfg.failChatsPoll = false; cfg.dropAck = false; cfg.jitterMs = 0; cfg.apiMs = defaults.apiMs; cfg.wsOpenMs = defaults.wsOpenMs; stats.http = {}; stats.wsOpen = { chat: 0, inbox: 0 }; stats.wsClose = { chat: 0, inbox: 0 }; return json({ ok: true }); }
        if (p === "/__mock/stats") return json({ ...stats, openSockets: socks.size });
        if (p === "/__mock/drop") { let n = 0; for (const s of socks) if (s.data.kind === "chat") { s.close(1011); n++; } return json({ dropped: n }); }
        if (p === "/__mock/frame") {
          const b = (await req.json()) as { chat: string; frame: unknown };
          const c = fx.find((x) => x.key === b.chat || x.id === b.chat);
          if (!c) return json({ error: "no chat" }, 404);
          // keep server state consistent with the frame so a history refetch agrees with the live event
          const f = b.frame as { type: string; id?: string; body?: string; editedAt?: number; emoji?: string; on?: boolean };
          const t = f.id ? c.messages.find((x) => x.id === f.id) : undefined;
          if (t && f.type === "edited") { t.body = f.body ?? t.body; t.editedAt = f.editedAt ?? Date.now(); }
          if (t && f.type === "deleted") { t.isDeleted = true; t.body = ""; }
          if (t && f.type === "reaction" && f.emoji && f.on) { const r = (t.reactions ??= []).find((x) => x.emoji === f.emoji); if (r) r.count++; else t.reactions.push({ emoji: f.emoji, count: 1, mine: false }); }
          for (const s of socks) if (s.data.kind === "chat" && s.data.chatId === c.id) s.send(JSON.stringify(b.frame));
          return json({ ok: true });
        }
        if (p === "/__mock/push") {
          const b = (await req.json()) as { chat: string; body: string; sender?: string };
          const c = fx.find((x) => x.key === b.chat || x.id === b.chat);
          if (!c) return json({ error: "no chat" }, 404);
          const m: Msg = { id: `m_${c.key}_p${String(++seq).padStart(5, "0")}`, chatId: c.id, senderId: b.sender ?? c.peerId ?? "u_001", body: b.body, createdAt: Date.now() };
          c.messages.push(m);
          for (const s of socks) {
            if (s.data.kind === "chat" && s.data.chatId === c.id) s.send(JSON.stringify({ type: "message", message: m }));
            if (s.data.kind === "inbox") s.send(JSON.stringify({ type: "chat_update", chatId: c.id, preview: m.body, at: m.createdAt, senderId: m.senderId }));
          }
          return json({ ok: true, id: m.id });
        }
        return json({ error: "unknown" }, 404);
      }
      // -------- websockets
      if (p === "/ws" || p === "/inbox/ws") {
        const kind = p === "/ws" ? "chat" : "inbox";
        const chatId = url.searchParams.get("chat") ?? undefined;
        await delay(cfg.wsOpenMs);
        if (srv.upgrade(req, { data: { kind, chatId } satisfies WsData })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      // -------- API
      if (p === "/api/session" || p.startsWith("/api/")) {
        const route = p === "/api/session" ? "/api/session"
          : p === "/api/chats" ? "/api/chats"
          : p.endsWith("/messages") ? "/messages" : p.endsWith("/members") ? "/members" : "/api/other";
        stats.http[route] = (stats.http[route] ?? 0) + 1;
        await delay(cfg.routeMs[route] ?? cfg.apiMs);
        if (p === "/api/session") return json({ authenticated: true, user: ME });
        if (p === "/api/chats" && req.method === "GET") {
          if (cfg.failChatsPoll) return new Response("<html>502</html>", { status: 502 });
          return json({ chats: fx.map((c) => summary(c, order(c))) });
        }
        const m = p.match(/^\/api\/chats\/([^/]+)\/(messages|members)$/);
        if (m) {
          const c = byId.get(decodeURIComponent(m[1]!));
          if (!c) return json({ error: "not_found" }, 404);
          if (m[2] === "members") return json({ members: c.members });
          return json({ messages: page(c, url.searchParams.get("before")) });
        }
        return json({ error: "not_found" }, 404);
      }
      return staticFile(p, /\bgzip\b/.test(req.headers.get("accept-encoding") ?? ""));
    },
    websocket: {
      open(ws: { data: WsData; send: (s: string) => void; close: (c?: number) => void }) {
        stats.wsOpen[ws.data.kind]++;
        socks.add(ws);
        if (ws.data.kind === "chat") {
          const c = byId.get(ws.data.chatId ?? "");
          ws.send(JSON.stringify({ type: "ready", chatId: ws.data.chatId, you: ME.id }));
          if (c) ws.send(JSON.stringify({ type: "presence_snapshot", online: c.peerId ? [c.peerId] : [] }));
        }
      },
      message(ws: { data: WsData; send: (s: string) => void }, raw: string) {
        if (ws.data.kind !== "chat") return;
        try {
          const f = JSON.parse(raw) as { type: string; tempId?: string; body?: string };
          const c = byId.get(ws.data.chatId ?? "");
          if (f.type === "send" && c && f.body) {
            const msg: Msg = { id: `m_${c.key}_s${String(++seq).padStart(5, "0")}`, chatId: c.id, senderId: ME.id, body: f.body, createdAt: Date.now() };
            c.messages.push(msg);
            if (!cfg.dropAck) ws.send(JSON.stringify({ type: "sent", tempId: f.tempId, message: msg }));
          }
        } catch { /* ignore junk */ }
      },
      close(ws: { data: WsData }) { stats.wsClose[ws.data.kind]++; socks.delete(ws as never); },
    },
  });
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const dist = join(process.cwd(), "dist");
  const m = startMock(dist, Number(process.argv[2] ?? 4391));
  console.log(`mock backend + dist on ${m.url}`);
}
