/**
 * IndexedDB adapter for store-core.js (service worker; the extension's own
 * origin, never the claude.ai page origin). Same async API as MemoryAdapter.
 * Schema changes go through STORES + store-core MIGRATIONS and a version bump.
 *
 * - CTS_StoreIDB.open(name) -> Promise<adapter>
 */

(function (root) {
  'use strict';

  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  function open(name) {
    const Core = root.CTS_StoreCore;
    return new Promise((resolve, reject) => {
      const o = indexedDB.open(name || 'tokenlens', Core.SCHEMA_VERSION);
      o.onupgradeneeded = () => {
        const db = o.result;
        Object.keys(Core.STORES).forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, Core.STORES[s]); });
      };
      o.onerror = () => reject(o.error);
      o.onsuccess = () => {
        const db = o.result;
        db.onversionchange = () => db.close();
        const tx = (s, mode) => db.transaction(s, mode).objectStore(s);
        resolve({
          get: (s, k) => req(tx(s, 'readonly').get(k)),
          put: (s, v) => req(tx(s, 'readwrite').put(v)),
          delete: (s, k) => req(tx(s, 'readwrite').delete(k)),
          getAll: s => req(tx(s, 'readonly').getAll()),
          clear: s => req(tx(s, 'readwrite').clear()),
          count: s => req(tx(s, 'readonly').count()),
        });
      };
    });
  }

  root.CTS_StoreIDB = { open };
})(typeof self !== 'undefined' ? self : globalThis);
