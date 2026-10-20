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
