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
- Search chats / Save all / History / Settings: strip under the usage bars in the sidebar. (The "at this pace" line was removed.)
- The toolbar popup is unchanged from the original build.

## TokenLens Pro (6.1): licensing and paywall

One-time $29 license sold on Gumroad. No server: the service worker talks to Gumroad directly.

**Plan model**
- Every install gets a full-feature trial: 7 *active* days (days claude.ai is open and visible), ending after 14 calendar days at the latest. Trial state lives in `chrome.storage.local` and `chrome.storage.sync` (merged), so a reinstall does not restart it.
- After the trial the free plan keeps: usage bars and the rest of 5.x, single-chat save as Markdown, indexing + the top 3 search results, 2 days of history (all days are still recorded), one alert (5h at 95%), the settings panel.
- Locked on the free plan (all open the unlock dialog on click): PDF/Text/JSON save, Save all (shows the chat count only), full search results, 7/30-day history and limit hits, the 7d alert and the 80% alerts, Continue in a new chat, color themes.

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

## Layout guard (ui.js)
The usage widgets carry a flex-shrink/min-width guard so that opening an artifact or code panel (which narrows the claude.ai layout) cannot squeeze the bars or labels.

## 6.3: usage-scale fix, VamimiAI, premium bars

**The "new session shows 100%" bug (fixed).** `/api/organizations/<id>/usage` reports `utilization` as a
percentage (0-100), but every reading was scale-guessed (`>1` = percent, `<=1` = fraction). The first
message of a fresh 5h window reads `1.0` (= 1%), which became 100% and also set `isLimitHit`, so the bar sat
at 100% until usage reached 2-3%. The same misreading was behind the old "7d exactly-1 artifact" filter,
which silently dropped real 1% readings. Now (`quota.js toFraction`):
- `/usage` readings are always percent (`scale: 'pct'`) and are authoritative: they set and clear `isLimitHit`.
- The SSE `message_limit` event is `scale: 'auto'`; an exactly-1 value there is ambiguous and is skipped,
  and every SSE reading schedules a `/usage` reconcile. `isLimitHit` from the stream needs an explicit
  `exceeded*` status.

**VamimiAI (`vamimi.js`, ISOLATED, before boot.js).** Diagram button in assistant action bars (feature id
`vamimi`, on by default), one-time "Meet VamimiAI" announcement (claimed in background.js `vmClaim`:
updates from < 6.3 at the next calm moment, fresh installs after 3 days of use, never within a day of
another prompt), spotlight on the button for up to 3 page loads, a permanent sidebar link and a popup link.
All links carry `utm_source=tokenlens&utm_medium=extension&utm_campaign=<surface>`. Text travels in the URL
fragment as `#prefill=z.<base64url(deflate-raw)>` (or `t.<uri>`), the format VamimiAI's prefill.js reads.
background.js opens only `https://www.vamimi.com` URLs.
QA: `chrome.storage.local.set({ cts_vm_preview: true })` shows the announcement on the next page load;
reset with `chrome.storage.local.remove(['cts_vm_ann', 'cts_vm_spot'])`.

**Premium layer (`ui.js PREMIUM_CSS`).** Bars carry `data-ct-level` (ok / warn >= 75% / crit >= 90%) and
change colour; tabular figures; hairline badges and chips; warmer light-mode text colours.

## 6.4: monitor not watchtower, "not shared" accounts, customization, Pro free via VamimiAI

**Alerts removed.** The 80% / 95% toasts on both windows are gone (recorder.js, history.js `nextAlert`,
the `alerts` feature, its setting and strings). Leftover `cts_alerts_fired` is removed on load. The
history panel still lists limit hits: that is data, not an interruption.

**Accounts Claude sends no numbers for (`CTS.quotaMode`, network.js).** `unknown` until evidence,
`live` once any real number arrives from the stream or `/usage`, `none` when a reply finished cleanly and,
6 s later, a forced `/usage` answer also had no numbers (a failed request is not evidence; 404 counts).
`none` is persisted per org as `cts_quota_none`, restored on load (no 0% flash), shows dashes and a
one-line note (quota.js `applyUnavailable`), skips history snapshots, polls every 5 min, and tells the
person once a week per account (recorder.js). Any number flips it back to `live` at once.

**Customization (`settings.ui.*`, `theme.*`, features.js `F.ui(key)`).** One switch per surface:
sidebar box, floating card, composer row, badges, per-reply chips, chat dates, sidebar tools, Diagram
button (`features.vamimi`), VamimiAI sidebar link, level colours. MAIN world applies them in ui.js
`applyPrefs()` as `<html data-ct-off="...">` + CSS (never by removing nodes, so self-healing injection
does not fight the setting); chat dates also undo their title clamping. Colours are free: six presets or
any colour (`theme.palette = 'custom'`, `theme.accent`), applied to both worlds.

**Pro is free with VamimiAI.** `cts_vm_unlock` (local + sync) makes `summarize()` return tier `vamimi`.
`CTS_License.unlockWithVamimi(campaign)` -> background `vmUnlock`: opens VamimiAI
(`utm_campaign=unlock_<feature>` etc.) and unlocks once that tab reports `complete` (or after 6 s still
open). Every locked control, the trial-ended toast, a one-time "Pro is free now" toast for people whose
trial ended earlier, the popup, the unlock page and the announcement lead there. Gumroad keys keep working.
New VamimiAI entries: "Turn this chat into a diagram" in the menu and a Diagram button in the save row.

**Robustness / performance.**
- `/usage` background poll 5 s -> 30 s (60 s lite, 5 min "not shared"); a reading is shared with every
  other claude.ai tab of the same account over `BroadcastChannel('cts-usage-v1')`.
- ui.js rewrote its ~600-line stylesheet every second (full style recalc of claude.ai); now only when the
  light/dark mode flips.
- Sidebar dates ran a full measure pass on every animation frame with any DOM mutation (constant while a
  reply streams); now only for mutations inside the sidebar, at most every 700 ms.
- Diagram scan re-walks a reply only when its text changed.
- Clock skew: reset countdowns use server time from the `Date` header (`CTS.clockSkewMs`), so a fast or
  slow computer clock no longer zeroes bars or sticks on "refreshing…".
- Reset timestamps in ms or as numeric strings are normalised; implausible ones ignored.
- Sidebar dates no longer wait 60 s on a cold load (chat list fetched once the org id is known).
- Bounded per-tab bookkeeping (recorder cost keys).

QA: `chrome.storage.local.set({ cts_quota_none: { org: '<org id>', at: Date.now() } })` + reload shows the
"not shared" state; `chrome.storage.local.remove('cts_vm_unlock'); chrome.storage.sync.remove('cts_vm_unlock')`
resets the free unlock.
