import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { UserInbox } from "./inbox";

// The workers-pool env exposes the real bindings from wrangler.jsonc.
const bindings = env as unknown as { USER_INBOX: DurableObjectNamespace<UserInbox> };
const INBOX = bindings.USER_INBOX;

function stub(userId: string) {
  return INBOX.get(INBOX.idFromName("inbox:" + userId));
}

/** Resolve with the first WS frame matching `pred` (skips the inbox_ready handshake). */
function nextFrame(ws: WebSocket, pred: (text: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), 2000);
    ws.addEventListener("message", (e: MessageEvent) => {
      const text = String(e.data);
      if (pred(text)) { clearTimeout(timer); resolve(text); }
    });
  });
}

describe("UserInbox DO", () => {
  it("upgrades a websocket → 101 and sends inbox_ready", async () => {
    const res = await stub("u1").fetch("https://do/ws?user=u1", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no webSocket on upgrade");
    ws.accept();
    const ready = await nextFrame(ws, (t) => t.includes("inbox_ready"));
    expect(JSON.parse(ready).type).toBe("inbox_ready");
  });

  it("relays a /notify delta to the user's connected socket as a chat_update", async () => {
    const s = stub("u2");
    const res = await s.fetch("https://do/ws?user=u2", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const got = nextFrame(ws, (t) => t.includes("chat_update"));
    await s.fetch("https://do/notify", {
      method: "POST",
      body: JSON.stringify({ chatId: "c9", preview: "hi there", at: 5, senderId: "u3" }),
    });
    const frame = JSON.parse(await got);
    expect(frame).toMatchObject({ type: "chat_update", chatId: "c9", preview: "hi there", senderId: "u3" });
  });

  it("notify is a 204 no-op when the user has no live socket", async () => {
    const res = await stub("offline-user").fetch("https://do/notify", {
      method: "POST",
      body: JSON.stringify({ chatId: "c1", preview: "x", at: 1, senderId: "u9" }),
    });
    expect(res.status).toBe(204);
  });

  it("rejects a non-websocket, non-notify request", async () => {
    const res = await stub("u4").fetch("https://do/ws?user=u4");
    expect(res.status).toBe(426);
  });
});
