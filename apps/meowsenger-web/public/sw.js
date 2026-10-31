// meowsenger service worker — Web Push notifications.
//
// Payloadless design: the push carries no data; it just wakes this worker. We then
// (a) skip entirely if an app tab is focused/visible (the live WebSocket already
// delivered the message), (b) verify the signed-in account is the one that opted in,
// and only then (c) fetch the chat list ourselves — same-origin, so the session cookie
// rides along — and show ONE coalesced notification for what's unread. Clicking it focuses the app and deep-links to the chat.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

importScripts("/sw-core.js");
const store = self.mwPushCore.makeIdbStore(self.indexedDB);

// The page tells us which account opted in (id only, no tokens) at enable time and
// clears it on logout / disable / account deletion.
self.addEventListener("message", (event) => {
  event.waitUntil(self.mwPushCore.handleMessage(event.data, store).catch(() => {}));
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush());
});

async function handlePush() {
  // A focused/visible app tab already got this over the socket → don't double-notify.
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (wins.some((c) => c.focused || c.visibilityState === "visible")) return;

  // Identity gate: show a preview ONLY when the signed-in account is the one that opted
  // in on this browser. Otherwise nothing is shown (see sw-core.js). Note: Chrome, if it
  // receives a push and we show nothing, displays its own generic "site updated in the
  // background" notice — it carries no Meowsenger data, which is the intended failure mode.
  const d = await self.mwPushCore.decidePush({ store, fetchFn: fetch.bind(self), registration: self.registration });
  if (!d.show) return;
  await self.registration.showNotification(d.title, {
    body: d.body,
    icon: d.icon || "/icon-192.png", // sender avatar (single DM) or the Meowsenger icon, not a grey letter
    badge: "/badge-96.png", // monochrome cat for the Android status bar, instead of the Chrome logo
    tag: "meowsenger-msg", // coalesce a burst into a single notification
    renotify: true,
    data: { chatId: d.chatId },
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
