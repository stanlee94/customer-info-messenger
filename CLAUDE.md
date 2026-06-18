# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension that injects a customer-info panel into Meta
Business Suite's Messenger inbox
(`https://business.facebook.com/latest/inbox/*`). By default the panel sits
above the "Contact details" section in the right sidebar; users can drag it
anywhere on screen via the handle at the top.

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
  - `aiApiUrl` / `aiApiToken` — AI Reply backend base URL (trailing slash
    stripped on save) and optional Bearer token. The backend must expose
    `GET /ai/health` and `POST /ai/reply`. Also add the backend host to
    `host_permissions` in `manifest.json` once the URL is known.
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

`sessionState` now carries `{ uid, name, resolved, view, cartHasItems,
expiredAvailable, myrSum, sgdSum, manychatInfo }`. `manychatInfo` is `null`
until `GET_MANYCHAT_INFO` resolves and is reset on every conversation switch.

`sessionState.resolved` marks a terminal view so re-renders from the
`MutationObserver` skip network calls; `rehydrate()` rebuilds the panel from
`sessionState` if Facebook removes it mid-flow. `rehydrate()` also retries
`probeCartAndShowButtons()` if `cartHasItems` is still `null` (handles panel
removal during an in-flight probe or a silently failed probe), and re-renders
ManyChat info (lang tags + contact fields) from `sessionState.manychatInfo`
if already cached.

`proceedWithLookup()` re-fetches the live panel via `document.getElementById`
after the async `getUidPsidMap()` resolves, so `renderPsidRow` always writes
to the current panel even if Facebook swapped it out during the await.

### Mock/placeholder integrations

- **UID → PSID database**: `chrome.storage.local.uidPsidMap`, per-browser
  only. Replace `getUidPsidMap`/`setUidPsidLink`/`removeUidPsidLink` in
  `content.js` with a real backend when one exists.

### UI theme

The panel uses a **light theme** designed to blend with Meta Business Suite's
white/grey interface:

- **Background**: `#ffffff`; borders `#e4e6eb`; surfaces `#f0f2f5`
- **Accent colour**: `#0a7cff` (primary) / `#0060d6` (hover/gradient end) /
  `#0052b8` (deep gradient). Use these values — do **not** reintroduce the old
  indigo/purple (`#6366f1`).
- **Text**: primary `#050505`, secondary `#65676b`, muted `#8a8d91`
- **Sidebar margins**: `6px 8px` (intentionally tight so the panel spans the
  full sidebar width)
- **Floating width**: `300px`
- **Cart prefix textarea**: white (`#ffffff`) background to signal editability
- **MYR/SGD sub-labels** (`.cim-cart-btn-sublabel`): `font-weight: 800`

### Draggable panel

`ensurePanel()` checks the module-level `panelPosition` variable (`null` on
page load):

- **`null`** — inserts the panel before the "Contact details" anchor in the
  sidebar (original behaviour).
- **Set** — appends to `document.body` with `position: fixed` and `.cim-floating`
  class, restoring the saved `{ x, y }` coordinates.

`initDrag(panel)` wires the `<div class="cim-drag-handle">` at the top of the
panel. On the first drag the panel is moved to `document.body` and
`.cim-floating` is added (transition from sidebar → floating). Subsequent drags
update `panelPosition` on `mouseup`. The variable is module-level, so it
persists across conversation switches but resets to `null` on page reload
(returning the panel to the sidebar).

The drag handle is an **empty `<div>`** — its 4×2 dot-grid grip is rendered
entirely by the CSS `::before` pseudo-element (`radial-gradient` background
pattern). Do not put text content inside it.

### Close / restore button

A `<button class="cim-close-btn">` sits in the top-right corner of the panel.
It is only visible when **both** conditions are true:

1. The panel is floating (`.cim-floating` is present).
2. The Facebook sidebar is expanded (`.cim-sidebar-visible` is present).

CSS selector that shows it: `#cim-purchase-panel.cim-floating.cim-sidebar-visible .cim-close-btn`.

**`.cim-sidebar-visible` is managed by `syncCloseBtnVisibility()`** — called at
the top of every `scheduleCheck()` invocation (i.e. on every DOM mutation). It
toggles the class based on whether `findContactDetailsAnchor()` returns a
non-null element. This means the × disappears automatically when the user
collapses the Facebook sidebar.

Clicking × calls the handler in `initDrag()`: looks up the anchor first; if not
found, aborts silently (safety net). Otherwise sets `panelPosition = null`,
removes `.cim-floating` and `.cim-sidebar-visible`, clears inline `left`/`top`,
and calls `anchor.parentElement.insertBefore(panel, anchor)` to dock the panel
back.

### AI Quick / AI Details buttons

`#cim-ai-buttons` is a `<div>` injected directly into Facebook's chat composer
area — **not** inside `#cim-purchase-panel`. It appears between the text-input
row and the emoji/attachment toolbar row.

**Lifecycle** — `ensureAiButtons()` is called from the debounced `scheduleCheck()`
callback. It exits immediately if `document.contains(existing)` is true, so the
buttons survive DOM mutations without flickering. They are only re-created when
Facebook's SPA fully removes the composer (e.g. on conversation switch).
`updateAiButtonState()` is also called every debounce cycle to dim/enable the
buttons based on whether the reply box is empty.

**Health check** — on the first `ensureAiButtons()` call, `GET_AI_HEALTH` is sent
to `background.js` which calls `GET <aiApiUrl>/ai/health`. The result is cached in
the module-level `aiHealthy` flag (`null` = unchecked, `true`/`false` = result).
Buttons are only created if `{ ok: true }` is returned. A second module-level flag
`aiHealthPending` prevents duplicate in-flight checks.

**Button layout** (left → right): `↩` back button | `⚡ AI Quick` | `🔍 AI Details`

**Finding the reply box** — `findMessengerReplyBox()`:
1. `[data-lexical-editor="true"]` whose `aria-placeholder` contains `"Messenger"` or `"Reply"` (primary — confirmed against live DOM).
2. `[contenteditable="true"]` with matching `aria-placeholder` (fallback).

**Finding the insertion point** — `findComposerInsertionPoint()` walks up from
the reply box until it finds an ancestor with `width > 200 px`, `60 px < height
< 150 px`, and a `nextElementSibling` (the toolbar row). That element is the
input row; inserting after it places our div between input and toolbar.

**Empty vs filled detection** (Lexical-specific DOM):
- **Empty**: `<br data-lexical-managed-linebreak="true">` present in the editor.
- **Filled**: `<span data-lexical-text="true">user text</span>` present.

`isReplyBoxEmpty()` queries `br[data-lexical-managed-linebreak]`. Buttons are
`disabled` (opacity 0.45) when the box is empty.

**Reading reply box text** — `getReplyBoxText()` collects all `[data-lexical-text="true"]`
spans and joins their `textContent`.

**Clearing the reply box** — `clearReplyBox()` targets `[contenteditable="true"][role="textbox"]`
directly. It deletes character-by-character: for each character (`textContent.length + 2`
iterations to catch invisible zero-width chars), it collapses the selection to the end then
fires `keydown Backspace` → `beforeinput deleteContentBackward` → `execCommand('delete')` →
`input deleteContentBackward` → `keyup Backspace`. Returns `false` if the editor is not found.

Do **not** attempt select-all + single delete for Lexical — it ignores browser-level
non-collapsed selections for delete operations.

**Inserting text** — `insertTextIntoMessenger(text)` handles multiline AI responses:
1. Normalises `\\n` escape sequences and `\r\n` to `\n`.
2. Builds a `DataTransfer` with `text/plain` set to the cleaned text.
3. Dispatches a synthetic `ClipboardEvent('paste')` on the editor — Lexical intercepts
   this natively and converts `\n` into its internal line breaks without triggering Enter
   (which would send the message). Do **not** use Shift+Enter simulation or
   `insertLineBreak` execCommand — the paste approach is the only reliable method.

**Prepend text** — `injectTextIntoReplyBox(text)` (used by other features, not AI buttons):
- *Empty*: `box.focus()` then `execCommand('insertText', false, text)`.
- *Filled*: moves the cursor to offset 0 of the first `[data-lexical-text="true"]`
  span via the Selection/Range API, then `execCommand('insertText', false, text + ' ')`.

**Click behaviour**:
1. Read current reply box text via `getReplyBoxText()`. If empty, do nothing.
2. Send `{ messages: [text], mode }` as `AI_REPLY` to `background.js` →
   `POST <aiApiUrl>/ai/reply`.
3. All buttons dim immediately; the clicked button shows a CSS spinner
   (`.cim-ai-btn--loading` — `::after` pseudo-element, white border-top animation).
   No status text is shown.
4. On `{ ok: true, text }`: call `clearReplyBox()` then `insertTextIntoMessenger(text)`.
5. On complete (success or error): remove `.cim-ai-btn--loading`, re-enable buttons.

**Back button (↩)**:
- Starts disabled. Enabled when `aiPreviousText` is non-empty (i.e. after an AI
  call is made).
- Clicking it calls `replaceReplyBoxText(aiPreviousText)`, clears `aiPreviousText`,
  and disables itself.
- `aiPreviousText` is reset to `''` on every conversation switch.

**Backend contract**:
```
GET <aiApiUrl>/ai/health
Authorization: Bearer <aiApiToken>   (omitted if token not set)
→ { "ok": true }

POST <aiApiUrl>/ai/reply
Authorization: Bearer <aiApiToken>   (omitted if token not set)
Content-Type: application/json
{ "messages": ["the text from the reply box"], "mode": "quick" | "details" }
→ { "ok": true, "text": "AI reply text" }
→ { "ok": false, "error": "reason" }
```
`"quick"` instructs the backend to return a brief reply; `"details"` a thorough one.
`messages` is always a single-element array containing whatever the agent typed.
The model choice and system prompt live entirely on the backend.

### Fragile/heuristic areas (DOM-dependent)

- `findContactDetailsAnchor()`: finds a leaf with text exactly "Contact
  details", climbs to an ancestor with siblings.
- `getCustomerNameFromDom()`: two strategies tried in order:
  1. **Sidebar** — finds a "View profile" leaf, returns the first non-empty text
     leaf nearby (original approach).
  2. **Chat header fallback** — when the sidebar is hidden (narrow window),
     finds a `div`/`span` with `-webkit-line-clamp` in its inline style and
     verifies it sits inside a container that also contains "Assigned to " or
     "Assign this conversation" text. Returns that element's text as the name.
- `findMessengerReplyBox()` / `findComposerInsertionPoint()`: rely on
  `data-lexical-editor`, `aria-placeholder`, `data-lexical-managed-linebreak`,
  and `data-lexical-text` attributes specific to Meta's Lexical editor build.

All rely on Business Suite's obfuscated DOM and may need retuning after
a Facebook layout change.

### ManyChat integration assumptions

All ManyChat requests use `Authorization: Bearer <manychatToken>`.

**`searchManyChatByName()`** — `GET /fb/subscriber/findByName?name=...`,
expecting `{ data: [{ id, name|first_name/last_name, profile_pic,
last_input_text, last_interaction }] }` (`id` = PSID), sorted by
`last_interaction` descending. `content.js` renders candidates as cards
(`.cim-candidates-list`, ~3 visible rows). If `lastMessage` is a URL,
`getAttachmentLabel()` maps the extension to "Photo"/"Video"/"PDF"/"Audio"/
"Attachment" and links to it.

**`getManyChatInfo(psid)`** — `GET /fb/subscriber/getInfo?subscriber_id=<psid>`.
Called automatically after the `orders` view renders (`fetchAndRenderManyChatInfo()`).
Returns `{ ok, phone, email, whatsappPhone, tags: [{ id, name }] }`. Result
cached in `sessionState.manychatInfo`; re-used on rehydration without a
second network call. Phone/email/WhatsApp are appended to the summary panel
(with copy buttons) if non-null.

**`manyChatTagAction(action, psid, tagId)`** — `POST /fb/subscriber/addTag`
or `/fb/subscriber/removeTag` with body `{ subscriber_id, tag_id }`. Used by
the language tag toggle (see below).

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

The `(unlink)` link retains its own `.cim-unlink` class (`#0a7cff`) — keep
these classes separate so their colours don't bleed into each other.

### Language tag toggle

A `.cim-lang-tags` segmented control sits between the PSID row and the body.
It is populated by `renderLangTags(panel, tags, psid)` once `getManyChatInfo`
resolves (via `renderManyChatInfoRows`). Two recognised tag IDs:

| Tag ID | Label |
|---|---|
| `35385444` | Chinese |
| `35385464` | English |

**Visual states** (defined in `LANG_TAGS` constant in `content.js`):
- **Neither set** — container track is light red (`#fff5f5`); both chips are
  muted rose text (`#cd5c5c`), no border.
- **One set** — active chip is light green (`#f0fdf4`, `#15803d` text);
  inactive chip is transparent/grey. Container track is neutral (`#f0f2f5`).

**Click behaviour**:
1. Clicking the already-active chip is a no-op.
2. Clicking an inactive chip sets it to `.cim-lang-tag--loading` (`cursor: wait`).
3. If another tag is currently active: `MANYCHAT_TAG_ACTION remove` fires
   first; only on success does `MANYCHAT_TAG_ACTION add` fire.
4. If no tag is active: only `MANYCHAT_TAG_ACTION add` fires.
5. On full success: updates `sessionState.manychatInfo.tags` and re-renders.

**Error handling**:
- *Remove fails*: chip flashes `.cim-lang-tag--error` (red, 1.5 s) then
  re-renders from unchanged `sessionState` — UI stays as-is.
- *Remove succeeds, Add fails*: `sessionState.manychatInfo.tags` is updated
  to strip the removed tag **before** the error flash, so after 1.5 s the
  control re-renders with both chips grey — correctly reflecting ManyChat's
  real state (neither tag).

`renderPsidRow()` clears `.cim-lang-tags` on every customer switch so stale
tags from the previous conversation are never shown.

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
{ "expiredAvailable": boolean, "myrSum": number|null, "sgdSum": number|null, "version": "v2", "content": { "messages": [{ "type": "text", "text": "..." }] } }
```

`background.js` `getCartSummary()` forwards `expiredAvailable`, `myrSum`, and
`sgdSum` from the raw API JSON alongside `text`.

- **Non-empty**: sets `sessionState.cartHasItems = true`, saves `myrSum`/`sgdSum`
  to `sessionState`, and injects `buildCartSection(psid, { myrSum, sgdSum })`
  (buttons + prefix textarea) above "Recent Orders".
- **Empty**: sets `sessionState.cartHasItems = false` and injects a
  `.cim-cart-empty` pill ("🛒 Empty Cart") in the same position.
- **`expiredAvailable: true`**: sets `sessionState.expiredAvailable = true` and
  injects a `.cim-expired-notice` amber pill ("⚠️ Expired items available") at
  the top of the body. Nothing is shown when `false`.
- **Error / no response**: silently ignored; no UI change.

`cartHasItems`, `expiredAvailable`, `myrSum`, and `sgdSum` are all reset to
`null` on each conversation switch so the probe runs once per customer.
`renderState` reads them for rehydration (when Facebook removes and re-adds
the panel).

| Button | CSS modifier | `option` param | Sub-label |
|---|---|---|---|
| ALL | `cim-cart-btn--both` (`#0a7cff` → `#0052b8` gradient) | `1` | — |
| 🇲🇾 MYR | `cim-cart-btn--myr` (green gradient) | `2` | `RM {myrSum}` (`.cim-cart-btn-sublabel`) |
| 🇸🇬 SGD | `cim-cart-btn--sgd` (amber gradient) | `3` | `S$ {sgdSum}` (`.cim-cart-btn-sublabel`) |

`buildCartSection(psid, prices)` passes a `subLabel` to `buildCartOptionButton`
for the MYR and SGD buttons. The sub-label is omitted if `prices.myrSum` /
`prices.sgdSum` is `null`. Buttons use `display: flex; flex-direction: column`
so the price sits below the flag+currency label.

Clicking a button sends `GET_CART_SUMMARY { psid, option }` → `background.js`
calls `GET /users/:id?option=N` and returns `{ ok: true, text, expiredAvailable, myrSum, sgdSum }` (full
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
