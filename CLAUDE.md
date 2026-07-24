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

### AI Rewrite button bar

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

**Button layout** (left → right): `↩` back button | `✨ AI Rewrite` | `华语 / English` language toggle

**Module-level state**: `aiHealthy` (`null`/`true`/`false`), `aiHealthPending` (bool), `aiLanguage` (`'chinese'`/`'english'`, defaults to `'chinese'`).

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

**Language toggle** — a segmented control (`cim-ai-lang`) with two chips: `华语` (`chinese`) and `English` (`english`). Styled as an iOS-style segmented control: active chip is a **white pill with a subtle drop shadow**; inactive chips are `#65676b` text on transparent background. This keeps it visually distinct from the panel's green ManyChat lang-tag toggle. Chips have `role="button"`, `tabindex="0"`, `aria-pressed`, and a `keydown` handler for Enter/Space keyboard activation. Selection is stored in the module-level `aiLanguage` variable (defaults to `'chinese'`; persists across conversation switches, resets on page reload).

**Click behaviour** (`✨ AI Rewrite`):
1. Read current reply box text via `getReplyBoxText()`. If empty, do nothing.
2. Save text to `chrome.storage.local` as `aiLastInput`.
3. Only after the storage write completes, send `{ messages: [text], mode: 'quick', language: aiLanguage }` as `AI_REPLY` to `background.js` → `POST <aiApiUrl>/ai/reply`.
4. All action buttons dim immediately; the clicked button adds `.cim-ai-btn--loading`:
   `color: transparent` hides the button text; a `::after` spinner is absolutely
   centered (`position:absolute; top/left 50%; translate(-50%,-50%)`). No status text.
5. On `{ ok: true, text }`: call `clearReplyBox()` then `insertTextIntoMessenger(text)`.
6. On complete (success or error): remove `.cim-ai-btn--loading`, re-enable buttons.

**Back button (↩)** — white pill with `1px solid #d8dadf` border (`aria-label="Restore previous text"`):
- Always starts enabled. `updateAiButtonState()` dims it (along with all `.cim-ai-btn`) when the reply box is empty.
- Clicking it reads `aiLastInput` from `chrome.storage.local`. If found, calls `clearReplyBox()` then `insertTextIntoMessenger(aiLastInput)` to restore the text before the last AI rewrite.
- If `aiLastInput` is not set (no AI call made yet in this session), the click is a no-op.

**Backend contract**:
```
GET <aiApiUrl>/ai/health
Authorization: Bearer <aiApiToken>   (omitted if token not set)
→ { "ok": true }

POST <aiApiUrl>/ai/reply
Authorization: Bearer <aiApiToken>   (omitted if token not set)
Content-Type: application/json
{ "messages": ["the text from the reply box"], "mode": "quick", "language": "chinese" | "english" }
→ { "ok": true, "text": "AI reply text" }
→ { "ok": false, "error": "reason" }
```
`mode` is always `"quick"`. `language` reflects the user's selected language toggle (defaults to `"chinese"`).
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
hover) that calls `openCartModal(psid)` on click — opening the EC2 cart
management modal (see "EC2 Cart modal" below). It does **not** navigate to a
new tab.

The PSID number is rendered as a `<span class="cim-psid-link">` (dark text,
pointer cursor). Clicking it copies the PSID to the clipboard and shows a
"Copied!" tooltip (`.cim-copy-tooltip`) for 1.5 s — it does **not** navigate.

The `(unlink)` link retains its own `.cim-unlink` class (`#0a7cff`) — keep
these classes separate so their colours don't bleed into each other.

### EC2 Cart modal (Goals 1–3)

A centered modal (`#cim-cart-modal` inside `#cim-cart-modal-overlay`) that
gives operators full EC2 cart management without leaving the Messenger tab.
Triggered by clicking the customer name link. Same visual pattern as the
parcel photos drawer (480 px wide, 78 vh, shared `.cim-drawer-*` classes for
header/body/footer).

**API base** — same `CART_API_BASE`
(`https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest`).
All cart endpoints are under `/api/`. Every response is `{ok, ...}` or
`{ok:false, msg}` — errors are shown as a 3 s red toast
(`.cim-cart-error-toast`) at the top of the modal body. After every write,
the full cart is re-fetched; never optimistic updates.

**Module-level state** (in `content.js`):
- `CART_MODAL_ID`, `CART_MODAL_OVERLAY_ID` — element IDs.
- `cartModalPsid` — PSID of the customer whose cart is open; set by
  `openCartModal(psid)`, used by refresh/back-button handlers.
- `cartSelectedRecIds` — `Set` of `recId` strings currently checked; reset on
  every `showCartView()` call.
- `goodsKeyword`, `goodsPage`, `goodsTotalPages` — goods-picker pagination
  state; reset when `showGoodsPicker()` is called.
- `goodsQtys` — `{ [goodsId]: qty }` map persisting per-product stepper
  values across searches within one picker session; reset on `openCartModal`.
- `goodsSearchMode` — `'normal'` | `'smart'`; reset to `'normal'` on every
  `showGoodsPicker()` call.
- `goodsSelectedIds` — `Set<goodsId>` of items checked in the multi-select
  toolbar; reset on `showGoodsPicker()`, on every new search, and on mode switch.

**Header modes** — `setCartHeaderMode(mode)` swaps the header between two
states without recreating the DOM:

| Element | `'cart'` mode | `'goods'` mode |
|---|---|---|
| `.cim-cart-back-btn` | hidden | visible (→ `showCartView`) |
| `.cim-cart-add-btn` | visible (→ `showGoodsPicker`) | hidden |
| `.cim-cart-refresh-btn` | visible (→ `showCartView`) | hidden |
| `.cim-drawer-title` | customer name | "Add Product" |

**Cart view** (`showCartView(psid)` → `renderCartContent(body, modal, data, psid)`):

`GET_CART_ITEMS { psid }` → `background.js` → `GET /api/cart?fbUserId=<psid>`
→ `{ ok, items:[{recId, goodsId, name, qty, price, origin, expired}], userId, ecUserId }`.

Rendered elements:
- **Modal header subtitle** — starts at `0 items · RM0.00`; updated live by
  `syncBulkButtons()` on every checkbox change to show the selected count and
  sum of selected line totals. Uses `itemLineTotals` (`Map<recId, lineTotal>`)
  built once in `renderCartContent`. The bottom total row always shows the full
  cart total and is unchanged by selection.
- **Toolbar** (`.cim-cart-toolbar`) — `☐ All` select-all checkbox
  (indeterminate when partial); `Delete` and `Renew Expiry` bulk buttons
  (disabled when `cartSelectedRecIds` is empty).
- **Item rows** (`.cim-cart-item-row`, `--expired` variant) — checkbox
  feeding `cartSelectedRecIds`; name + LIVE/SYS badge + ⚠ Expired badge;
  `RM X.xx/ea` price; `[−][qty][+]` stepper with editable `<input
  type="text">` in the middle (digit-only filter on `input` event; Enter/blur
  commits; Escape restores; input disabled during in-flight API call); line
  total; per-item `Renew` button (expired items only); `🗑` delete button.
- **Total row** (`.cim-cart-total-row`) — sum of all line totals (static,
  always shows the full cart total regardless of selection).

`setCartBodyBusy(true/false)` adds `pointer-events:none; opacity:0.55` to the
body during bulk operations. `renderCartContent` calls `setCartBodyBusy(false)`
at its very start so the busy overlay is always cleared when the cart reloads —
this fixes a freeze where `Renew Expiry` (or bulk `Delete`) on a successful API
response would leave the modal permanently grayed.

**Delete confirmation** — clicking `🗑` (per-item) or the bulk `Delete` button
calls `showDeleteConfirm(triggerEl, onConfirm)` instead of invoking the API
directly. The helper creates a fixed-position popover ("Delete? · Yes · No")
above the trigger via `getBoundingClientRect`, appended to `document.body` at
`z-index:2147483647`. Yes proceeds with the API call; No or click-outside
dismisses. Any existing popover is removed before a new one is shown.

**Closing the modal** — `closeCartModal()` additionally strips `.cim-cart-section`,
`.cim-cart-empty`, and `.cim-expired-notice` from the panel, resets
`sessionState.{cartHasItems,myrSum,sgdSum,expiredAvailable}` to `null`, and
calls `probeCartAndShowButtons()` so the MYR/SGD price sub-labels on the panel
buttons refresh immediately after the modal is closed.

**Goods picker** (`showGoodsPicker(psid)` → `renderGoodsPicker(body, psid)`):

The picker has two modes toggled by a `Normal | ✦ Smart` segmented control at the top.

**Normal mode** — `SEARCH_GOODS { keyword, page }` → `background.js` → `GET /api/goods?keyword=&page=`
→ `{ ok, result:{ total, pages, items:[{goodsId, name, price, stock, warehouseCode, onSale, img}], noResult } }`.
100 rows/page. `result.noResult === true` means no `items` key — guarded. Pagination shown when `pages > 1`.

**Smart mode** — operator types a comma-separated sentence (both `，` and `,` split); `renderGoodsPicker` splits on `/[，,]/`, trims, drops blanks, then fans out **one `SMART_SEARCH_GOODS` per segment** in parallel. Each segment is further split on whitespace into a `words` array. Results render as labeled groups (`.cim-smart-group`) — one per segment — each with a query label, a count badge (`--found` green / `--empty` grey / `--error` red), and the matched cards below. No pagination. The keydown Enter handler checks `!e.isComposing` so Chinese IME character-confirmation Enter does not fire the search.

`SMART_SEARCH_GOODS { words }` → `background.js` `smartSearchGoods(words)` → `POST /api/goods/search`
with body `{ words: string[] }` → `{ ok, items, total }`. Same item shape as `GET /api/goods`.
No match → `total: 0, items: []` (never `noResult`). Error → `{ ok: false, msg }`.

**Shared card layout** (`buildGoodsCard(goods)` — closure inside `renderGoodsPicker`): checkbox
(`.cim-goods-item-cb`, `data-goods-id` attribute) + 48 × 48 px thumbnail + name + `RM X.xx · Stock: N`
meta + `OFF` badge + qty stepper + `Add` button. Both modes use the same builder.

**Multi-select toolbar** (`.cim-goods-toolbar`) sits between the search row and the list:
- `☐ All` select-all label+checkbox (`selectAllCb`) — goes indeterminate on partial selection.
- `Add Selected (N)` button (`addSelectedBtn`) — disabled at 0; shows count when > 0.

`goodsSelectedIds` (module-level `Set`) tracks checked goodsIds. `visibleGoodsIds` (closure array,
reset on every render) lists all goodsIds currently in the list — used for select-all logic.
`syncToolbar()` keeps both the select-all state and the button text/enabled state in sync.

Switching modes or running a new search clears `goodsSelectedIds` and `visibleGoodsIds` and calls
`syncToolbar()`. Switching back to Normal from Smart re-runs `doSearch('', 1)` to restore the initial list.

**Add Selected bulk action**: fires parallel `CART_ADD_ITEM` calls for every item in `goodsSelectedIds`.
On each success, marks that card's `Add` button as `✓ Added`. Errors show via `showCartError` toast.
After all complete: clears selection, updates toolbar, shows `✓ N added` or `N ok · M failed` for 2 s.

**Background.js message handlers added for cart:**

| Message type | API call |
|---|---|
| `GET_CART_ITEMS { psid }` | `GET /api/cart?fbUserId=<psid>` |
| `CART_DELETE_ITEMS { recIds }` | `POST /api/cart/delete` |
| `CART_REFRESH_VALIDITY { recIds }` | `POST /api/cart/refresh-validity` |
| `CART_UPDATE_QTY { recId, qty }` | `POST /api/cart/quantity` |
| `CART_ADD_ITEM { fbUserId, goodsId, qty }` | `POST /api/cart/items` |
| `SEARCH_GOODS { keyword, page }` | `GET /api/goods?keyword=&page=` |
| `SMART_SEARCH_GOODS { words }` | `POST /api/goods/search` |
| `CART_COPY_ITEMS { fbUserId, sourceFbUserId, dryRun?, includeExpired? }` | `POST /api/cart/copy` |

No `manifest.json` changes needed — the API gateway host is already in
`host_permissions`. No auth headers — the backend manages the EC2 session
cookie automatically.

**Goals status:**
- Goal 1 (cart view/edit): ✅ complete
- Goal 2 (goods picker): ✅ complete
- Goal 3 (multi-select → delete/renew): ✅ complete; "create order from
  selection" pending Goal 4
- Goal 4 (order creation): not yet implemented
- Goal 5 (order list): ✅ complete — see "Order list modal" below
- Goal 6 (order detail): ✅ complete — see "Order detail view" below
- Copy cart: ✅ complete — see "Copy cart view" below

### Copy cart view

A sub-view inside the cart modal triggered by the **"↙ Copy"** button in the
cart header. Lets the operator copy all items from another customer's cart into
the currently open one. Quantities merge if the same product already exists.

**Header mode** — `setCartHeaderMode('copy')`: hides Add/Copy/Refresh, shows
← Back (returns to cart view), sets title to "Copy Cart".

**Module-level state** (in `content.js`):
- `copySourceId` — the last-typed source fbUserId; persists if the operator
  goes back and reopens the view within the same page session.

**Flow (preview → confirm):**
1. Operator types the source customer's `fbUserId` and clicks **Preview** (or
   presses Enter). A dry-run call (`dryRun: true`) is made; nothing is written.
2. Results appear as color-coded sections:
   - **✓ Will be added** (green) — items that would be copied.
   - **⏭ Will be skipped** (amber) — items not even attempted, with reason.
     The only current reason is `"expired"`: expired lines are skipped by
     default unless **Include expired items** is checked.
3. **Confirm Copy** button appears only when `added.length > 0`. Clicking it
   sends the real (non-dry-run) copy request.
4. After copy, results show:
   - Green success banner: `✓ Copy complete — Added X · skipped Y · failed Z`.
   - **⚠ Failed to add** (red) section if any items were rejected by the
     portal (e.g. out-of-stock). Each row shows name × qty — error reason.
   - **View Cart** button reloads the cart view with the updated items.

**Skipped vs Failed distinction:**
- *Skipped* — not attempted (expired, filtered pre-flight by the API).
- *Failed* — attempted but portal rejected (e.g. insufficient stock).

**Background.js handler:** `CART_COPY_ITEMS { fbUserId, sourceFbUserId, dryRun?,
includeExpired? }` → `POST /api/cart/copy`. Returns `{ ok, added, skipped,
failed, cart }`. `cart` is the target cart re-fetched after copy — used
directly by `renderCopySuccess` via the "View Cart" button reload rather than
parsed inline.

**Functions in `content.js`:**
- `showCopyCartView(psid)` — entry point; resets `copySourceId`, switches
  header mode, calls `renderCopyCartView`.
- `buildCopySection(title, count, variant)` — reusable colored section builder
  (`'added'` / `'skipped'` / `'failed'`).
- `renderCopyCartView(body, psid)` — builds the full form + preview/confirm
  state machine via closures.

### Order list modal (Goal 5)

A centered modal (`#cim-order-list-modal` inside `#cim-order-list-overlay`) that
shows all non-cancelled orders for a customer. Triggered by clicking the
**"Recent Orders ↗"** heading in the orders view (replaces the old EC2 external
link). Same visual pattern as the cart modal (480 px wide, 78 vh, shared
`.cim-drawer-*` classes).

**Module-level state** (in `content.js`):
- `ORDER_LIST_MODAL_ID`, `ORDER_LIST_OVERLAY_ID` — element IDs.
- `orderListModalPsid` — PSID of the customer whose orders are loaded.

**Functions:**
- `ensureOrderListModal()` — creates the overlay/modal DOM once; returns the
  modal element. Header has a refresh button (↻) and close (✕). Footer has a
  Close button. Escape key closes.
- `openOrderListModal(psid)` — sets `orderListModalPsid`, shows the overlay,
  calls `showOrderList(psid)`.
- `closeOrderListModal()` — removes the visible class.
- `showOrderList(psid)` — sends `GET_ORDER_LIST { psid }` → `background.js` →
  `GET /api/orders?fbUserId=<psid>&newStatus=0&noCancel=on`. On success renders
  order cards; on failure shows `.cim-drawer-error`.
- `mapShippingLabel(method)` — maps raw EC2 shipping method strings to short
  labels: substring `西马` → `"西马"`, `东马` → `"东马"`, `新加坡` → `"新加坡"`,
  `system`/`自取` (case-insensitive) → `"自取"`, otherwise returns the raw string.
- `formatOrderDate(dateStr)` — parses any `Date`-compatible string and returns
  `"D/M/YYYY"` (no leading zeros); falls back to the raw string if unparseable.

**API response** (`GET_ORDER_LIST`):
```
GET /api/orders?fbUserId=<psid>&newStatus=0&noCancel=on
→ { ok, orders: [{ orderId, orderSn, mobile, amount, consignee, statusText,
                   statusParts, orderTime, shippingMethod, paymentMethod }] }
```
`orderTime` and `shippingMethod` are additive fields confirmed present alongside
the base set. `statusParts` is `{ confirm, payment, shipping }`.

**Card layout** (`.cim-ol-card`, flex column, `gap: 5px`):
1. `.cim-ol-top` — `"F" + orderSn` (bold, `.cim-ol-sn`) + `RM X.XX` (green,
   `.cim-ol-amount`) — flex row, space-between.
2. `.cim-ol-mid` — `consignee · mobile` in secondary grey.
3. `.cim-ol-info` — `formatOrderDate(orderTime) · mapShippingLabel(shippingMethod)`
   in small muted text (11 px, `#8a8d91`). Omitted entirely when both values
   are falsy.
4. `.cim-ol-bot` — status badge pills (`.cim-ol-status-badge`), one per
   `statusParts` key (`confirm`, `payment`, `shipping`); color-coded:
   - `已…` → green (`.cim-ol-status--done`)
   - `未…` → amber (`.cim-ol-status--pending`)
   - `待…` → grey (`.cim-ol-status--waiting`)
   Falls back to a single badge from `statusText` if `statusParts` is absent.

**Background.js handler added:**

| Message type | API call |
|---|---|
| `GET_ORDER_LIST { psid }` | `GET /api/orders?fbUserId=<psid>&newStatus=0&noCancel=on` |

### Order detail view (Goal 6)

Order list cards are clickable (`.cim-ol-card--clickable`, `cursor: pointer`). Clicking
one calls `openOrderDetail(orderId)` which shows the detail inside the **same
`#cim-order-list-modal`** — no second modal. The header swaps between two modes via
`setOrderListHeaderMode(mode, modal)`:

| Element | `'list'` mode | `'detail'` mode |
|---|---|---|
| `.cim-ol-back-btn` (← Back) | hidden | visible → `showOrderList(orderListModalPsid)` |
| `.cim-cart-refresh-btn` (↻) | visible | hidden |

**Module-level state added:**
- `orderDetailOrderId` — orderId of the currently-rendered detail; used as a stale-response
  guard (`if (orderDetailOrderId !== orderId) return`).

**Footer in detail/edit mode** — `ensureOrderListModal()` now builds the footer with two
zones: `.cim-ol-footer-actions` (left, flex row) and the standard Close button (right).
`#cim-order-list-modal .cim-drawer-footer` overrides the global `justify-content` to
`space-between`. Action buttons are injected into `.cim-ol-footer-actions` by
`renderOrderDetail` and cleared on every view transition.

**Functions:**
- `openOrderDetail(orderId)` — ensures the overlay is visible, calls `showOrderDetail`.
- `showOrderDetail(orderId)` — sets `orderDetailOrderId`, switches header to `'detail'`
  mode, clears footer actions, fetches `GET_ORDER_DETAIL`, calls `renderOrderDetail`.
- `renderOrderDetail(body, modal, data)` — renders the full detail and populates footer buttons.
- `doOrderOperations(orderId, operations, modal)` — runs an array of EC2 operations in
  sequence (e.g. `['confirm', 'pay']` for Confirm+Paid), then re-fetches the detail.
- `showOrderDetailToast(modal, msg)` — shows a `.cim-od-toast` error banner at the top
  of the body for 4 s; creates the element once and reuses it.
- `showEditConsigneeDialog(modal, orderId, detailData)` — switches title to "Edit
  Recipient", fetches `GET_ORDER_CONSIGNEE`, calls `renderEditConsigneeForm`.
- `renderEditConsigneeForm(body, modal, orderId, form, detailData)` — builds the edit
  form (consignee, mobile, email, address, postcode, order note, CS note); puts
  Cancel + Save in `.cim-ol-footer-actions`. Cancel re-renders from cached `detailData`
  (no refetch). Save calls `UPDATE_ORDER_CONSIGNEE` then re-fetches via `showOrderDetail`.

**`renderOrderDetail` layout** (top → bottom inside `.cim-drawer-body`):
1. `.cim-od-status-row` — three `.cim-ol-status-badge` pills reusing existing colour
   classes (`--done` / `--pending` / `--waiting`).
2. `.cim-drawer-info-card` — order meta: Order Time, Payment, Pay Time (if paid),
   Shipping, Ship Time (if shipped), Buyer name.
3. **Recipient** `.cim-od-section` — section header with title + **Edit** button
   (`.cim-od-edit-btn`); info card with Name / Mobile / Email / Address.
4. **Items** `.cim-od-section` — `.cim-od-items-list`; each `.cim-od-item-row` has:
   44 × 44 px thumbnail (`.cim-od-item-img-wrap`), name + meta line (live code
   `.cim-od-item-code`, origin `.cim-od-item-origin`, ship state badge
   `.cim-od-ship--done` / `--pending`), qty × line total column.
5. **Summary** `.cim-od-section` — `.cim-od-fee-list` rows: Subtotal, Shipping,
   Discount (green, `--discount`), Add Amount (red, `--add`), **Payable** (bold,
   `--payable` with top border).
6. **Notes** `.cim-od-section` — Order Note and CS Note; omitted when both absent.

**Action button logic** (derived entirely from `statusParts` string prefixes):

| `statusParts` state | Buttons shown |
|---|---|
| `confirm` starts with `待` | **Confirm** + **Confirm+Paid** |
| `confirm` not `待` AND `payment` starts with `未` | **Pay** |
| `payment` starts with `已` AND `shipping` starts with `未` | **Ship** |

`doOrderOperations` sequences operations: Confirm+Paid fires `confirm` → on success
fires `pay`, then refetches. Any failure re-enables buttons and shows a toast.
Ship maps to the EC2 operation string `"shiped"` (verbatim, as captured from portal).

**Edit consignee form** — `regionCity` and `regionArea` (EC2 region IDs) are held
from the fetched `form` object and sent back unchanged on save; the operator edits
consignee / mobile / email / address / postcode (regionCode) / order note / CS note.
Required fields (`consignee`, `mobile`, `address`, `regionCode`) are validated
client-side before the POST.

**Background.js handlers added:**

| Message type | API call |
|---|---|
| `GET_ORDER_DETAIL { orderId }` | `GET /api/orders/:orderId` |
| `GET_ORDER_CONSIGNEE { orderId }` | `GET /api/orders/:orderId/consignee` |
| `UPDATE_ORDER_CONSIGNEE { orderId, data }` | `POST /api/orders/:orderId/consignee` |
| `ORDER_OPERATION { orderId, operation }` | `POST /api/orders/:orderId/operations` |

**`GET /api/orders/:orderId` response shape:**
```
{ ok, orderId, orderSn, statusText, statusParts:{confirm, payment, shipping},
  subtotal, shipping, payable,
  buyer:{name, fbUserId}, orderTime, paymentMethod, payTime, shippingMethod, shipTime,
  recipient:{consignee, mobile, address, email},
  customerGroup, note, csNote,
  items:[{recId, img, name, shipState, note, origin, price, qty, lineTotal}],
  itemsCount, itemsTotal,
  discount:{amount, note}|null, addAmount:{amount, note}|null }
```
`payTime`/`shipTime` are datetimes when done, otherwise the literal `未付款`/`未出货`.
HTTP 422 for an unknown orderId.

**`GET /api/orders/:orderId/consignee` response shape:**
```
{ ok, form: { consignee, mobile, email, address, serviceNote, note,
              regionCountry, regionCity, regionArea, regionCode,
              countries:[{id,name}] } }
```

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

### Parcel photos — icon, modal, gallery

After the orders list is rendered, `content.js` fires two parallel async calls:
`GET_ORDER_STATUSES` (see above) and `CHECK_PARCEL_PHOTOS`. Both use the same
captured `uid` guard so stale responses from a previous customer are discarded.

**Batch photo probe** — `CHECK_PARCEL_PHOTOS` sends `background.js` the full
`orderIds` array. `background.js` calls:

```
GET ${CART_API_BASE}/parcelPhotos/check?ids=<id1>,<id2>,...
→ { count, results: { [orderId]: { hasPhotos: boolean, imageCount: number } } }
```

No auth, no image bytes — just booleans. `content.js` iterates the results and,
for every order where `hasPhotos === true`, appends a `.cim-photo-icon` camera
SVG button to that order's `.cim-order-id-wrap`. The icon is skipped if one
already exists (idempotent). `.cim-order-id` elements carry a `data-order-id`
attribute (set at render time) so lookup is `querySelector('[data-order-id="…"]')`
rather than text matching.

**Centered modal** — clicking the camera icon calls `openParcelDrawer(orderId)`,
which:
1. Calls `ensureParcelDrawer()` — creates `#cim-parcel-overlay` (the centering
   backdrop) with `#cim-parcel-drawer` (the modal) nested inside it, both
   appended to `document.body` once; subsequent calls return the existing modal.
2. Shows `.cim-parcel-overlay--visible` (`display: flex`, centers the modal).
3. Sends `GET_PARCEL_PHOTO_ORDER { orderId }` → `background.js` calls
   `GET ${CART_API_BASE}/parcelPhotos/order/<orderId>`.
4. Renders `renderDrawerContent(body, modal, res, orderId)` on success.

Closing: ✕ button in modal header, Close button in modal footer, clicking the
backdrop (`e.target === overlay`), or Escape key all call `closeParcelDrawer()`
which removes `.cim-parcel-overlay--visible`.

**Modal layout** — `#cim-parcel-drawer` is `height: 85vh; display: flex;
flex-direction: column`. The body (`.cim-drawer-body`) is `flex: 1; min-height: 0;
overflow-y: auto; display: block` — block (not flex) so the flex engine doesn't
fight the height constraint, enabling reliable inner scroll when collapsibles
expand.

The modal header shows:
- **Title** — `wmsOrder.customerName` from the first WMS order (falls back to `orderId`).
- **Subtitle** — parcel count: counts only WMS orders that have a `trackingNumber`.
  Orders without tracking are still rendered but not counted.

**Content rendered by `renderDrawerContent` + `buildWmsContent`:**

*Single WMS* — content is rendered flat (no collapsible wrapper):
- Info card (`.cim-drawer-info-card`) — bordered table with rows: Customer /
  WMS ID / ERP ID / EC2 Order (blue link → `https://ddherbs.com.my/track/<id>`) /
  Task ID / Tracking. The Tracking row always renders: shows the number if present,
  or `"No tracking number"` in red italic (`.cim-drawer-info-value--no-tracking`)
  if absent.
- Meta line (`.cim-drawer-meta`) — `⏱ HH:MM am/pm · createdBy`.
- Photo sections — one `.cim-drawer-kind-section` per kind present:
  `[Internal]` lavender pill + `内部存档 · N` / `[Customer]` green pill +
  `客户可见 · N` / `[Other]` grey pill. 3-column `.cim-drawer-photo-grid` of
  `.cim-drawer-thumb` tiles.
- `kind: null` photos fall into "Other" (never silently dropped).

*Multiple WMS* — each order is a collapsible `.cim-parcel-section` row:
- **Header** — WMS ID (bold) + optional `[No tracking]` rose pill
  (`.cim-parcel-no-tracking`) when `trackingNumber` is absent + photo count +
  ▸ chevron. WMS ID text is red (`.cim-parcel-section-title--no-tracking`) when
  no tracking number.
- **Body** — same info card / meta / photo sections as the single-WMS flat layout,
  shown/hidden via `sectionBody.style.display` toggled by the header click.
- First parcel starts expanded; all others start collapsed.

**Detail endpoint contract:**
```
GET ${CART_API_BASE}/parcelPhotos/order/:orderId
→ {
    found: boolean,
    ec2OrderId, orderCount, imageCount,
    orders: [{
      headerId, wmsId, erpId, ec2OrderId, taskId, trackingNumber,
      customerName, lastPhotoAt, createdBy, createdAt, imageCount,
      internal: [photo], customer: [photo], images: [photo]
    }]
  }
```
Each photo: `{ id, name (S3 key), url (public S3 URL), kind ('internal'|'customer'|null), uploadedBy, createdAt }`.
HTTP 500 on Baserow failure; `found: false` for unknown order IDs — branch on
HTTP status first, then `found`.

**Gallery modal** — clicking any `.cim-drawer-thumb` calls
`openGalleryModal(wmsOrder.images, startIndex)` where `images` is the flat
per-WMS combined array and `startIndex` is the clicked photo's position within
it. The modal (`#cim-gallery-modal`, `display:none` → `display:flex`):
- Full-screen dark overlay (`rgba(0,0,0,0.92)`), `z-index: 2147483647`.
- Centre image (`.cim-gallery-img`, `object-fit: contain`).
- `‹` / `›` navigation buttons (hidden when `images.length <= 1`).
- `N / total` counter at the top centre.
- Scrollable thumbnail strip (`.cim-gallery-thumbs`) at the bottom;
  active thumb gets a white border + full opacity.
- Keyboard: `←`/`→` to navigate, `Escape` to close. The `keydown` listener
  is attached on open and removed on close (`modal._onKeyDown`).
- Clicking anywhere that is not a button, image, or thumb strip closes the modal
  (`!e.target.closest('button, img, .cim-gallery-thumbs')`).

**Module-level state** (in `content.js`):
- `PARCEL_DRAWER_ID`, `PARCEL_OVERLAY_ID`, `GALLERY_MODAL_ID` — element IDs.
- `galleryImages` — current image array for the open gallery session.
- `galleryIndex` — current image index.

No `manifest.json` changes needed — `yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com`
is already in `host_permissions` for the cart endpoints.

**Smoke-test curl:**
```bash
BASE=https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest
# Batch probe (all order IDs at once):
curl "$BASE/parcelPhotos/check?ids=F955820260720007336,F955820260722007192"
# Detail (on icon click):
curl "$BASE/parcelPhotos/order/F955820260722007192"
```
