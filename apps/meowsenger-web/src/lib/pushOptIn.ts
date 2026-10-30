// The service worker's opted-in account id lives in IndexedDB (public/sw-core.js,
// makeIdbStore). The page writes the SAME database directly (same origin) so the
// opt-in never depends on a fire-and-forget postMessage reaching a live worker.
// These constants MUST match sw-core.js — swCore.test.ts proves the two interoperate.
export const OPT_IN_DB = "mw-push";
export const OPT_IN_DB_VERSION = 1;
export const OPT_IN_STORE = "kv";
export const OPT_IN_KEY = "optedInUser";

/** Write (string) or clear (null) the opted-in account id. Resolves true only once the
 *  transaction committed; false when IndexedDB is unavailable or the write failed. */
export function writeOptInIdb(userId: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const idb = globalThis.indexedDB;
      if (!idb) return resolve(false);
      const req = idb.open(OPT_IN_DB, OPT_IN_DB_VERSION);
      req.onupgradeneeded = () => { req.result.createObjectStore(OPT_IN_STORE); };
      req.onerror = () => resolve(false);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(OPT_IN_STORE, "readwrite");
          const store = tx.objectStore(OPT_IN_STORE);
          if (userId) store.put(userId, OPT_IN_KEY);
          else store.delete(OPT_IN_KEY);
          tx.oncomplete = () => { db.close(); resolve(true); };
          tx.onerror = tx.onabort = () => { db.close(); resolve(false); };
        } catch {
          db.close();
          resolve(false);
        }
      };
    } catch {
      resolve(false);
    }
  });
}
