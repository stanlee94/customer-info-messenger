# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension that injects a customer-info panel into Meta
Business Suite's Messenger inbox
(`https://business.facebook.com/latest/inbox/*`), above the "Contact details"
section in the right sidebar.

Plain JS/HTML/CSS, no build step, package manager, or test suite — loaded
directly as an unpacked extension.

## Development workflow

- Reload via `chrome://extensions` after editing (full reload needed if
  `manifest.json` changes).
- Config lives in `chrome.storage.local`, set via the options page
  (`chrome://extensions` → this extension → "Details" → "Extension
  options"):
  - `manychatToken` — ManyChat API token.
  - `baserowBaseUrl` / `baserowToken` / `baserowUsersTableId` (`749`) /
    `baserowOrdersTableId` (`750`). If the base URL's host changes, also
    update `host_permissions` in `manifest.json`.
- Debugging: `content.js` logs to the Business Suite tab's DevTools console;
  `background.js` via the "service worker" link on `chrome://extensions`.
- No live Facebook/ManyChat/Baserow sandbox for CLI testing — verify
  DOM-scraping and API changes manually in a real Business Suite tab.

## Architecture

Three pieces, connected by `chrome.runtime.sendMessage` (`{type: '...',
...}` → `sendResponse({ok, ...})`):

- **`content.js`** — content script on the inbox page. Owns all DOM
  interaction and UI state. A debounced `MutationObserver` (Business Suite
  is an SPA) calls `check()` on every DOM change.
- **`background.js`** — service worker. The only place that makes
  cross-origin `fetch()` calls (ManyChat, Baserow), since content scripts
  run inside the page's CSP.
- **`options.html` / `options.js`** — persists the config above to
  `chrome.storage.local`.

### Customer lookup flow

`check()` drives a state machine in `sessionState` (`{ uid, name, resolved,
view, cartHasItems, expiredAvailable }`) on every change to `selected_item_id` in the URL:

1. Read `UID` from URL, scrape name via `getCustomerNameFromDom()` (retries
   until found). On a UID change, `check()` returns immediately after
   resetting state — this prevents reading a stale name from the previous
   customer's DOM before the SPA has updated.
2. Look up `UID → PSID` in `uidPsidMap`:
   - **Found**: `GET_ORDERS_BY_PSID` → `orders` view. If the Baserow row was
     deleted, self-heals via `LINK_BASEROW_UID` + one retry before falling
     back to `new-customer`.
   - **Not found**: `SEARCH_MANYCHAT_BY_NAME` → `candidates` (with "Link"
     buttons) or `no-match`.
3. "Link" sends `LINK_BASEROW_UID` (`{uid, psid, name}`): PATCHes an existing
   Users row's `UID`, or creates one via `createBaserowUserRow()`, persists
   `uidPsidMap`, loads orders.
4. "(unlink)" sends `UNLINK_BASEROW_UID` (clears `UID`), removes the
   `uidPsidMap` entry, and re-runs the ManyChat search.

`sessionState.resolved` marks a terminal view so re-renders from the
`MutationObserver` skip network calls; `rehydrate()` rebuilds the panel from
`sessionState` if Facebook removes it mid-flow. `rehydrate()` also retries
`probeCartAndShowButtons()` if `cartHasItems` is still `null` (handles panel
removal during an in-flight probe or a silently failed probe).

`proceedWithLookup()` re-fetches the live panel via `document.getElementById`
after the async `getUidPsidMap()` resolves, so `renderPsidRow` always writes
to the current panel even if Facebook swapped it out during the await.

### Mock/placeholder integrations

- **UID → PSID database**: `chrome.storage.local.uidPsidMap`, per-browser
  only. Replace `getUidPsidMap`/`setUidPsidLink`/`removeUidPsidLink` in
  `content.js` with a real backend when one exists.

### Fragile/heuristic areas (DOM-dependent)

- `findContactDetailsAnchor()`: finds a leaf with text exactly "Contact
  details", climbs to an ancestor with siblings.
- `getCustomerNameFromDom()`: finds a "View profile" leaf, then the first
  non-empty text leaf nearby.

Both rely on Business Suite's obfuscated, class-name-free DOM and may need
retuning after a Facebook layout change.

### ManyChat integration assumptions

`searchManyChatByName()` calls `GET
https://api.manychat.com/fb/subscriber/findByName?name=...` (`Bearer
<manychatToken>`), expecting `{ data: [{ id, name|first_name/last_name,
profile_pic, last_input_text, last_interaction }] }` (`id` = PSID), sorted
by `last_interaction` descending.

`content.js` renders candidates as cards (`.cim-candidates-list`, ~3 visible
rows). If `lastMessage` is a URL, `getAttachmentLabel()` maps the extension
to "Photo"/"Video"/"PDF"/"Audio"/"Attachment" and links to it.

### Baserow integration assumptions

All requests use `Authorization: Token <baserowToken>` and
`user_field_names=true`.

- **Users table** (`baserowUsersTableId`, `749`): `findBaserowUserRowByPsid()`
  filters by `PSID` (case-sensitive, assumed unique) and resolves to `null`
  (not a thrown error) when no row matches. `updateBaserowRowUid()` PATCHes
  `UID` (a mirror — `uidPsidMap` is the source of truth).
  `createBaserowUserRow()` POSTs `PSID`/`UID`/`Name` for new "Link" clicks.
- **Order summary** (`getCustomerSummaryByPsid()`, handles
  `GET_ORDERS_BY_PSID`): from the matched Users row — `Sum of Order` →
  "Total Spending" (RM), `Order Count` → "Total Purchase", `Last Order Date`
  → date string (shown on hover via `data-tooltip`), `Raw_Recency` → "Last
  Order" display (integer days → `formatRecency()`), `Years_Active`,
  `RFM_Score` → "Rank", `Address` (with inline copy button when non-empty).
- **Orders table** (`baserowOrdersTableId`, `750`): `fetchRecentOrders()`
  filters its own `PSID` field (a `link_row` to Users, so uses
  `filters`/`link_row_contains` rather than `filter__PSID__equal`),
  `order_by=-Order_ID&size=5`, mapping `Order_ID`/`Total_Amount`/`Date` →
  `{ orderId, totalAmount, orderDate }`.

If field names change, adjust `getCustomerSummaryByPsid()` /
`fetchRecentOrders()` only — `content.js` just needs `{ ok, data: {...} }`
or `{ ok: true, notFound: true }`.

### Orders view — summary panel

The `orders` case in `renderState` uses a local `addSummaryRow(label, value,
extraClass)` helper that returns `{ row, valueEl }` for per-row customisation.
Fields displayed:

| Label | Source field | Notes |
|---|---|---|
| Total Spending | `Sum of Order` | Formatted as RM currency |
| Total Purchase | `Order Count` | |
| Last Order | `Raw_Recency` (days) | `formatRecency()` output; `data-tooltip` shows raw `Last Order Date` on hover |
| Years Active | `Years_Active` | |
| Rank | `RFM_Score` | |
| Address | `Address` | Inline copy button appended inside value span when non-empty |

`formatRecency(days)` (in `content.js`) converts an integer day count to a
human-readable string with no external library:
- `< 30 d` → `"Xd ago"`
- `< 365 d` → `"Xm Yd ago"`
- `≥ 365 d` → `"Xy Xm Yd ago"`

Custom tooltip pattern: any element with a `data-tooltip` attribute gets a
CSS `::after` dark floating tooltip on hover (defined in `styles.css`). Used
for the Last Order date. Does not rely on the native `title` attribute, which
is unreliable inside injected content scripts.

### Name row and PSID row

When a PSID is linked, `renderPsidRow()` also updates the name row: the
customer name becomes an `<a class="cim-name-link">` (dark text, underline on
hover) that opens the customer's live cart page in a new tab:

```
https://ec2.full2house.com/Ent/index.php?win_name=&fb_user_id=<PSID>&a=EntLive&m=mallCartUserLists&live_id=
```

The PSID number is rendered as a `<span class="cim-psid-link">` (dark text,
pointer cursor). Clicking it copies the PSID to the clipboard and shows a
"Copied!" tooltip (`.cim-copy-tooltip`) for 1.5 s — it does **not** navigate.

The `(unlink)` link retains its own `.cim-unlink` class (blue) — keep these
classes separate so their colours don't bleed into each other.

### Manual candidate search (candidates view)

Below `.cim-candidates-list`, a search bar (`handleCandidateSearch()`) lets
staff find a customer by Order ID or PSID:

- Empty input → re-runs `SEARCH_MANYCHAT_BY_NAME` for the customer's scraped
  name (`sessionState.name`), refreshing `view.manychatCandidates` on
  success.
- Input starting with "F"/"f" → `SEARCH_BASEROW_BY_ORDER_ID`: Orders table by
  `Order_ID` → linked Users row; falls back to a PSID search if no match.
- Otherwise → `SEARCH_BASEROW_BY_PSID`: exact `PSID` match in Users table.

Both map a Users row via `mapUserRowToCandidate()` to `{ psid, name,
lastOrderDate, rfmScore }` (`Last Order Date`/`RFM_Score` field names).
Results render via `buildBaserowCandidateCard()` (Name/Last Order/Rank, no
avatar) instead of the ManyChat card. Empty/failed results leave the list
unchanged and show a message in `.cim-search-status`.

### Cart-summary copy buttons (orders view)

`background.js` exposes `CART_API_BASE =
https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest` (no auth
header required).

On content-script load, `initCartSessionCheck()` sends `CHECK_SESSION` →
`background.js` calls `GET /checkSession` and resolves `{ ok: true, valid:
boolean }`. If `valid` is `true`, the module-level `cartSessionValid` flag
is set to `true`.

When `cartSessionValid` is `true` and the `orders` view first renders,
`probeCartAndShowButtons()` silently calls `GET_CART_SUMMARY` with `option: '1'`
to check whether the cart is empty. The response shape is:

```json
{ "expiredAvailable": boolean, "version": "v2", "content": { "messages": [{ "type": "text", "text": "..." }] } }
```

- **Non-empty**: sets `sessionState.cartHasItems = true` and injects
  `buildCartSection(psid)` (buttons + prefix textarea) above "Recent Orders".
- **Empty**: sets `sessionState.cartHasItems = false` and injects a
  `.cim-cart-empty` pill ("🛒 Empty Cart") in the same position.
- **`expiredAvailable: true`**: sets `sessionState.expiredAvailable = true` and
  injects a `.cim-expired-notice` amber pill ("⚠️ Expired items available") at
  the top of the body. Nothing is shown when `false`.
- **Error / no response**: silently ignored; no UI change.

`cartHasItems` and `expiredAvailable` are both reset to `null` on each
conversation switch so the probe runs once per customer. `renderState` reads
both for rehydration (when Facebook removes and re-adds the panel).

| Button | CSS modifier | `option` param |
|---|---|---|
| ALL | `cim-cart-btn--both` (blue gradient) | `1` |
| 🇲🇾 MYR | `cim-cart-btn--myr` (green gradient) | `2` |
| 🇸🇬 SGD | `cim-cart-btn--sgd` (amber gradient) | `3` |

Clicking a button sends `GET_CART_SUMMARY { psid, option }` → `background.js`
calls `GET /users/:id?option=N` and returns `{ ok: true, text, expiredAvailable }` (full
bilingual order-summary string) or `{ ok: false, error }`.

- Empty-cart detection: `text.includes('您的购物车里暂无商品哦~')` → shows
  "Empty Cart!" tooltip, does **not** copy.
- Non-empty: reads `.cim-cart-prefix` textarea value at click time. If
  non-empty, replaces `DEFAULT_CART_PREFIX` in the response text before
  copying; otherwise copies as-is. Calls `copyToClipboard(text)` → shows
  "Copied!" tooltip for 1.5 s.
- Errors: shows the error message in the tooltip instead.

**Cart prefix textarea** — `buildCartSection()` renders a `<textarea
class="cim-cart-prefix">` below the three buttons (only shown when cart has
items, never with the empty-cart pill). The module-level `cartPrefixText`
variable persists the typed value across conversation switches within the same
page session; it resets on page reload or extension reload. `DEFAULT_CART_PREFIX`
is the bilingual livestream-reminder text constant in `content.js`.

Tooltip reuses the existing `.cim-copy-tooltip` / `.cim-copy-tooltip--visible`
CSS. `buildCartOptionButton()` in `content.js` handles the click logic.

### External order-management links

In the `orders` view:

- "Recent Orders" heading links to full2house:
  `https://ec2.full2house.com/Ent/index.php?...&fb_user_id=<PSID>&...`.
- Each order's `Order_ID` links to `https://ddherbs.com.my/track/<Order_ID>`
  for tracking.
- Each order shows the `Date` field (from Orders table) formatted as
  `D/M/YYYY` (no leading zeros, no time) in a `.cim-order-date` span between
  the order ID link and the copy button: e.g. `F9558... (8/6/2026) [copy]`.
- Each order ID link is coloured yellow (`el.style.color = 'yellow'`) if its
  status from the order-status API is `"WAIT_AUDIT"` (see below).

### Order status colouring

After the orders list is rendered, `content.js` sends `GET_ORDER_STATUSES` with
all `orderId` values from `recentOrders`. `background.js` calls:

```
GET https://7n881aguj8.execute-api.ap-southeast-1.amazonaws.com/orders/<id1>,<id2>,...
```

No auth header required. Expected response: an array of objects with
`onlineOrderNumber` (the order ID) and `status` fields:

```json
[{ "onlineOrderNumber": "F955820...", "status": "WAIT_AUDIT" }, ...]
```

`fetchOrderStatuses()` in `background.js` builds a `{ [onlineOrderNumber]: status }`
map and returns `{ ok: true, statuses }`. `content.js` then queries
`.cim-order-id` elements by text content and sets `color: yellow` on any whose
status is `"WAIT_AUDIT"`. Other statuses are left unstyled.
