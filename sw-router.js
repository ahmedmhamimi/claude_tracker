/**
 * Service-worker message router for TokenLens 6.0. Loaded by background.js via
 * importScripts inside try/catch, so a failure here can never break the
 * existing install/uninstall/what's-new logic. Only accepts messages that
 * come from this extension: content scripts on https://claude.ai/ or the
 * extension's own pages (popup, print page).
 *
 * - (no exports) registers chrome.runtime.onMessage for {cts:1, op, data}
 *
 * @requires shared.js, conversation.js, history.js, search-index.js, folders.js, store-core.js, store-idb.js
 */

(function () {
  'use strict';

  let storePromise = null;
  function getStore() {
    if (!storePromise) {
      storePromise = CTS_StoreIDB.open('tokenlens').then(async adapter => {
        const store = CTS_StoreCore.createStore(adapter, { History: CTS_History, Search: CTS_Search, Folders: CTS_Folders, Conv: CTS_Conversation });
        await store.init();
        return store;
      });
      storePromise.catch(() => { storePromise = null; }); // allow a retry on the next message
    }
    return storePromise;
  }

  const fromUs = sender => {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (sender.tab) return /^https:\/\/claude\.ai\//.test(sender.url || sender.tab.url || '');
    return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.cts !== 1 || typeof msg.op !== 'string') return false;
    if (!fromUs(sender)) { sendResponse({ ok: false, error: 'forbidden' }); return false; }
    getStore().then(s => s.handle(msg.op, msg.data), e => ({ ok: false, error: 'store-unavailable' }))
      .then(r => { try { sendResponse(r); } catch (_) {} });
    return true; // async response
  });
})();
