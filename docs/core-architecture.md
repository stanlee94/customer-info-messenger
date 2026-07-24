# Core Architecture

Three pieces, connected by `chrome.runtime.sendMessage` (`{type: '...', ...}` → `sendResponse({ok, ...})`):

- **`content.js`** — content script on the inbox page. Owns all DOM interaction and UI state. A debounced `MutationObserver` (Business Suite is an SPA) calls `check()` on every DOM change.
- **`background.js`** — service worker. The only place that makes cross-origin `fetch()` calls (ManyChat, Baserow), since content scripts run inside the page's CSP.
- **`options.html` / `options.js`** — persists config to `chrome.storage.local`.

## Customer lookup flow

`check()` drives a state machine in `sessionState` (`{ uid, name, resolved, view, cartHasItems, expiredAvailable }`) on every change to `selected_item_id` in the URL:

1. Read `UID` from URL, scrape name via `getCustomerNameFromDom()` (retries until found). On a UID change, `check()` returns immediately after resetting state — this prevents reading a stale name from the previous customer's DOM before the SPA has updated.
2. Look up `UID → PSID` in `uidPsidMap`:
   - **Found**: `GET_ORDERS_BY_PSID` → `orders` view. If the Baserow row was deleted, self-heals via `LINK_BASEROW_UID` + one retry before falling back to `new-customer`.
   - **Not found**: `SEARCH_MANYCHAT_BY_NAME` → `candidates` (with "Link" buttons) or `no-match`.
3. "Link" sends `LINK_BASEROW_UID` (`{uid, psid, name}`): PATCHes an existing Users row's `UID`, or creates one via `createBaserowUserRow()`, persists `uidPsidMap`, loads orders.
4. "(unlink)" sends `UNLINK_BASEROW_UID` (clears `UID`), removes the `uidPsidMap` entry, and re-runs the ManyChat search.

`sessionState` carries `{ uid, name, resolved, view, cartHasItems, expiredAvailable, myrSum, sgdSum, manychatInfo }`. `manychatInfo` is `null` until `GET_MANYCHAT_INFO` resolves and is reset on every conversation switch.

`sessionState.resolved` marks a terminal view so re-renders from the `MutationObserver` skip network calls; `rehydrate()` rebuilds the panel from `sessionState` if Facebook removes it mid-flow. `rehydrate()` also retries `probeCartAndShowButtons()` if `cartHasItems` is still `null` (handles panel removal during an in-flight probe or a silently failed probe), and re-renders ManyChat info (lang tags + contact fields) from `sessionState.manychatInfo` if already cached.

`proceedWithLookup()` re-fetches the live panel via `document.getElementById` after the async `getUidPsidMap()` resolves, so `renderPsidRow` always writes to the current panel even if Facebook swapped it out during the await.

## Mock/placeholder integrations

- **UID → PSID database**: `chrome.storage.local.uidPsidMap`, per-browser only. Replace `getUidPsidMap`/`setUidPsidLink`/`removeUidPsidLink` in `content.js` with a real backend when one exists.

## Fragile/heuristic areas (DOM-dependent)

- `findContactDetailsAnchor()`: finds a leaf with text exactly "Contact details", climbs to an ancestor with siblings.
- `getCustomerNameFromDom()`: two strategies tried in order:
  1. **Sidebar** — finds a "View profile" leaf, returns the first non-empty text leaf nearby (original approach).
  2. **Chat header fallback** — when the sidebar is hidden (narrow window), finds a `div`/`span` with `-webkit-line-clamp` in its inline style and verifies it sits inside a container that also contains "Assigned to " or "Assign this conversation" text. Returns that element's text as the name.
- `findMessengerReplyBox()` / `findComposerInsertionPoint()`: rely on `data-lexical-editor`, `aria-placeholder`, `data-lexical-managed-linebreak`, and `data-lexical-text` attributes specific to Meta's Lexical editor build.

All rely on Business Suite's obfuscated DOM and may need retuning after a Facebook layout change.
