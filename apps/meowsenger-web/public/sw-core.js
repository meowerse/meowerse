// meowsenger service worker — push decision logic (pure, dependency-injected so it is
// unit-tested in Node; loaded into the worker with importScripts("/sw-core.js")).
//
// A push is payloadless, so it says nothing about WHICH account it was meant for. The
// browser's current session may belong to someone else (logout / account switch), so
// before showing ANY preview we verify that the signed-in account is the account that
// opted in on this browser (the page stores just that account id here at enable time).
// If identity can't be established → no preview, and (when it's definitively wrong)
// the push subscription is dropped so the stale registration stops waking us.
(function (root) {
  var OPT_IN_KEY = "optedInUser";

  /** Tiny IndexedDB-backed store for the opted-in account id (no tokens). */
  function makeIdbStore(idb) {
    function open() {
      return new Promise(function (resolve, reject) {
        var r = idb.open("mw-push", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction("kv", mode);
          var out = fn(t.objectStore("kv"));
          t.oncomplete = function () { db.close(); resolve(out && out.result); };
          t.onerror = t.onabort = function () { db.close(); reject(t.error); };
        });
      });
    }
    return {
      get: function () { return tx("readonly", function (s) { return s.get(OPT_IN_KEY); }).then(function (v) { return typeof v === "string" && v ? v : null; }); },
      set: function (id) { return tx("readwrite", function (s) { return s.put(String(id), OPT_IN_KEY); }); },
      clear: function () { return tx("readwrite", function (s) { return s.delete(OPT_IN_KEY); }); },
    };
  }

  /** Drop the push subscription and the stored opt-in (stale/foreign registration). */
  async function purge(store, registration) {
    try { await store.clear(); } catch (e) { /* best effort */ }
    try {
      var sub = await registration.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) { /* best effort */ }
  }

  /**
   * Decide what to show for one push. Returns { show:false } or { show:true, title, body, chatId }.
   *  - no stored opt-in                      → purge, show nothing
   *  - /api/session 401/403, authenticated:false, no user id, or another account → purge, show nothing
   *  - /api/session 5xx / 429 / other non-OK / unreadable body / network error → show nothing,
   *    KEEP the subscription and the opt-in (transient)
   *  - identity verified → /api/chats; its `viewerId` must equal the opted-in id (re-read from the
   *    store before showing) else purge + show nothing; failure or nothing unread → show nothing
   */
  async function decidePush(deps) {
    var store = deps.store, fetchFn = deps.fetchFn, registration = deps.registration;
    var stored = null;
    try { stored = await store.get(); } catch (e) { stored = null; }
    if (!stored) { await purge(store, registration); return { show: false, reason: "no_opt_in" }; }

    var who;
    try {
      who = await fetchFn("/api/session", { credentials: "include", cache: "no-store" });
    } catch (e) {
      return { show: false, reason: "offline" };
    }
    // /api/session answers "signed out" with 200 {authenticated:false}, never a non-200 — so
    // only 401/403 are a definitive "not you"; every other failure (5xx, 429, a proxy page…)
    // is transient: show nothing but KEEP the subscription and the opt-in.
    if (who && (who.status === 401 || who.status === 403)) { await purge(store, registration); return { show: false, reason: "session_denied" }; }
    if (!who || !who.ok) return { show: false, reason: "session_unavailable" };
    var id = null;
    try {
      var s = await who.json();
      id = s && s.authenticated && s.user && s.user.id ? String(s.user.id) : null;
    } catch (e) { return { show: false, reason: "session_unreadable" }; }
    if (!id || id !== stored) { await purge(store, registration); return { show: false, reason: id ? "account_mismatch" : "signed_out" }; }

    try {
      var res = await fetchFn("/api/chats", { credentials: "include", cache: "no-store" });
      if (!res || !res.ok) return { show: false, reason: "chats_failed" };
      var data = await res.json();
      // /api/session and /api/chats are separate requests: the browser may have switched
      // accounts between them. Bind the list to the opted-in account via its viewerId, and
      // re-read the opt-in (a logout/disable may have cleared it meanwhile) right before showing.
      var viewer = data && typeof data.viewerId === "string" && data.viewerId ? data.viewerId : null;
      var current = null;
      try { current = await store.get(); } catch (e) { current = null; }
      if (!viewer || !current || viewer !== current) {
        await purge(store, registration);
        return { show: false, reason: !current ? "no_opt_in" : "account_mismatch" };
      }
      var unread = (data.chats || [])
        .filter(function (c) { return (c.unreadCount || 0) > 0; })
        .sort(function (a, b) { return (b.lastActivity || 0) - (a.lastActivity || 0); });
      if (unread.length === 0) return { show: false, reason: "nothing_unread" };
      var top = unread[0];
      var body = top.lastMessage || "new message";
      var total = unread.reduce(function (n, c) { return n + (c.unreadCount || 0); }, 0);
      if (unread.length > 1) body = body + " · " + total + " unread in " + unread.length + " chats";
      return {
        show: true,
        title: top.name || top.peerDisplayName || top.peerUsername || "meowsenger",
        body: body,
        chatId: top.id || "",
      };
    } catch (e) {
      return { show: false, reason: "chats_failed" };
    }
  }

  /** Handle the page → worker opt-in message: {type:"mw-optin", userId: string|null}. */
  async function handleMessage(data, store) {
    if (!data || data.type !== "mw-optin") return false;
    if (typeof data.userId === "string" && data.userId) await store.set(data.userId);
    else await store.clear();
    return true;
  }

  var core = { decidePush: decidePush, handleMessage: handleMessage, makeIdbStore: makeIdbStore, purge: purge };
  root.mwPushCore = core;
})(typeof self !== "undefined" ? self : globalThis);
