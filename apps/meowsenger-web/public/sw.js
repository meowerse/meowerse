// meowsenger service worker — Web Push notifications.
//
// Payloadless design: the push carries no data; it just wakes this worker. We then
// (a) skip entirely if an app tab is focused/visible (the live WebSocket already
// delivered the message), else (b) fetch the chat list ourselves — same-origin, so
// the session cookie rides along — and show ONE coalesced notification for what's
// unread. Clicking it focuses the app and deep-links to the chat.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush());
});

async function handlePush() {
  // A focused/visible app tab already got this over the socket → don't double-notify.
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (wins.some((c) => c.focused || c.visibilityState === "visible")) return;

  let title = "meowsenger";
  let body = "new message";
  let chatId = "";
  try {
    const res = await fetch("/api/chats", { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      const unread = (data.chats || [])
        .filter((c) => (c.unreadCount || 0) > 0)
        .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
      if (unread.length === 0) return; // nothing unread (already read elsewhere) → stay quiet
      const top = unread[0];
      chatId = top.id || "";
      title = top.name || top.peerDisplayName || top.peerUsername || "meowsenger";
      body = top.lastMessage || "new message";
      const total = unread.reduce((n, c) => n + (c.unreadCount || 0), 0);
      if (unread.length > 1) body = `${body} · ${total} unread in ${unread.length} chats`;
    }
  } catch {
    /* SW offline → fall through to the generic notification */
  }

  await self.registration.showNotification(title, {
    body,
    tag: "meowsenger-msg", // coalesce a burst into a single notification
    renotify: true,
    data: { chatId },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const chatId = event.notification.data && event.notification.data.chatId;
  const url = chatId ? `/app?chat=${encodeURIComponent(chatId)}` : "/app";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      if (c.url.includes("/app")) {
        await c.focus();
        if (chatId && "navigate" in c) await c.navigate(url).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
