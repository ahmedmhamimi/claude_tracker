# Dev notes

## iso-*.js files are generated copies
Chrome injects a given file only once per page, even when it appears in both a MAIN-world
and an ISOLATED-world content script entry. safe.js, features.js, endpoints.js, messages.js
and shared.js are needed in BOTH worlds, so the ISOLATED entries load byte-identical copies
named iso-<name>.js. After editing one of those five files, refresh the copies:

    for f in safe features endpoints messages shared; do cp $f.js iso-$f.js; done

## Load order (manifest.json)
1. bridge.js                       ISOLATED, document_start
2. iso-safe, iso-features, bridge2 ISOLATED, document_start
3. safe ... content.js             MAIN, document_start (hooks.js after state.js; rpc-main.js after network.js)
4. messages ... boot.js            ISOLATED, document_idle (boot.js must stay last)

The service worker imports shared, conversation, history, search-index, folders,
store-core, store-idb and sw-router inside try/catch (see background.js).

## Account switching (network.js)
resetAccountState() wipes numbers, headers, timers and backoff when the org changes or the
user signs out. Usage requests started under an older "epoch" are discarded when they finish.

## Where features live (placement.js)
- Save this chat (PDF / Markdown / Text / JSON): top bar, left of Share, chat pages only.
- Continue in a new chat: composer stats row (#ct-row-right), plus the long-chat toast.
- Search chats / Save all / History / Settings + "at this pace" line: strip under the usage bars in the sidebar.
- The toolbar popup is unchanged from the original build.

## TokenLens Pro (6.1): licensing and paywall

One-time $29 license sold on Gumroad. No server: the service worker talks to Gumroad directly.

**Plan model**
- Every install gets a full-feature trial: 7 *active* days (days claude.ai is open and visible), ending after 14 calendar days at the latest. Trial state lives in `chrome.storage.local` and `chrome.storage.sync` (merged), so a reinstall does not restart it.
- After the trial the free plan keeps: usage bars and the rest of 5.x, single-chat save as Markdown, indexing + the top 3 search results, 2 days of history (all days are still recorded), one alert (5h at 95%), the settings panel.
- Locked on the free plan (all open the unlock dialog on click): PDF/Text/JSON save, Save all (shows the chat count only), full search results, 7/30-day history and limit hits, the 7d alert and the 80% alerts, the "at this pace" estimate, Continue in a new chat, color themes.

**Files**
- `license-core.js`: constants (product id, checkout URL, price, trial/recheck/grace/activation limits) and pure trial/license logic. Loaded in every context. Change the price label or checkout URL here.
- `license.js`: content-script state + `CTS_License.allows/gate`. Feature ids: `export.md` (free), `export.pdf|txt|json`, `bulk`, `search.full`, `history.range`, `alerts.full`, `pace`, `handoff`, `themes`.
- `paywall.js`: unlock dialog, inline lock cards, plan status line, the three one-time toasts (trial started / ending / ended).
- `license-sw.js`: Gumroad verify (`POST /v2/licenses/verify`), activate (cap 5, checked before incrementing), restore from sync (no increment), weekly re-check (revokes only on refund / chargeback / unknown key; offline keeps Pro for a 30-day grace), deactivate.
- `unlock.html/js/css`: the page where the key is pasted. It must be an extension page because `api.gumroad.com` is an **optional** host permission requested from a click (a required one would disable the extension for every existing user on update).
- Gates: `panel.js`, `placement.js`, `recorder.js`, `handoff-ui.js`, `ui-kit.js`, plus a backstop in `exporter.js`. All fail open if `license.js` is missing.

**Also fixed in 6.1**: `recorder.js` and `handoff-ui.js` read `chrome.storage.local.get` through a helper that resolved `{}` before the callback ran. Effects: alerts re-fired on every page load, and "Continue in a new chat" never offered the carried text in the new chat. Both helpers now wait for the callback.

**Testing a purchase**: make a $0 purchase with a 100%-off Gumroad code, activate the key on the unlock page, then refund it in Gumroad and confirm Pro turns off after the next re-check (force it by setting `cts_license.lastOk` to 8+ days ago in `chrome.storage.local`).
**Resetting the trial while testing**: remove `cts_trial` from both `chrome.storage.local` and `chrome.storage.sync` and `cts_pw` from local.
