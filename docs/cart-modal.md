# EC2 Cart Modal

A centered modal (`#cim-cart-modal` inside `#cim-cart-modal-overlay`) that gives operators full EC2 cart management without leaving the Messenger tab. Triggered by clicking the customer name link. Same visual pattern as the parcel photos drawer (480 px wide, 78 vh, shared `.cim-drawer-*` classes for header/body/footer).

**API base** — `CART_API_BASE = https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest`. All cart endpoints are under `/api/`. Every response is `{ok, ...}` or `{ok:false, msg}` — errors are shown as a 3 s red toast (`.cim-cart-error-toast`) at the top of the modal body. After every write, the full cart is re-fetched; never optimistic updates.

No `manifest.json` changes needed — the API gateway host is already in `host_permissions`. No auth headers — the backend manages the EC2 session cookie automatically.

## Module-level state (in `content.js`)

- `CART_MODAL_ID`, `CART_MODAL_OVERLAY_ID` — element IDs.
- `cartModalPsid` — PSID of the customer whose cart is open; set by `openCartModal(psid)`.
- `cartSelectedRecIds` — `Set` of `recId` strings currently checked; reset on every `showCartView()` call.
- `cartUserId` — `userId` returned by `GET /api/cart`, stored on every cart load; passed to checkout and order-create calls.
- `goodsKeyword`, `goodsPage`, `goodsTotalPages` — goods-picker pagination state; reset when `showGoodsPicker()` is called.
- `goodsQtys` — `{ [goodsId]: qty }` map persisting per-product stepper values across searches within one picker session; reset on `openCartModal`.
- `goodsSearchMode` — `'normal'` | `'smart'`; reset to `'normal'` on every `showGoodsPicker()` call.
- `goodsSelectedIds` — `Set<goodsId>` of items checked in the multi-select toolbar; reset on `showGoodsPicker()`, on every new search, and on mode switch.
- `copySourceId` — the last-typed source fbUserId for copy cart; persists within the same page session.

## Header modes

`setCartHeaderMode(mode)` swaps the header between states without recreating the DOM:

| Element | `'cart'` | `'goods'` | `'checkout'` | `'copy'` |
|---|---|---|---|---|
| `.cim-cart-back-btn` | hidden | visible (→ cart) | visible (→ cart) | visible (→ cart) |
| `.cim-cart-add-btn` | visible (→ goods) | hidden | hidden | hidden |
| `.cim-cart-refresh-btn` | visible (→ cart) | hidden | hidden | hidden |
| `.cim-drawer-title` | customer name | "Add Product" | "Create Order" | "Copy Cart" |

## Cart view

`showCartView(psid)` → `renderCartContent(body, modal, data, psid)`:

`GET_CART_ITEMS { psid }` → `background.js` → `GET /api/cart?fbUserId=<psid>` → `{ ok, items:[{recId, goodsId, name, qty, price, origin, expired}], userId, ecUserId }`.

Rendered elements:
- **Modal header subtitle** — starts at `0 items · RM0.00`; updated live by `syncBulkButtons()` on every checkbox change to show the selected count and sum of selected line totals. Uses `itemLineTotals` (`Map<recId, lineTotal>`) built once in `renderCartContent`. The bottom total row always shows the full cart total.
- **Toolbar** (`.cim-cart-toolbar`) — `☐ All` select-all checkbox (indeterminate when partial); `Delete` and `Renew Expiry` bulk buttons (disabled when `cartSelectedRecIds` is empty).
- **Item rows** (`.cim-cart-item-row`, `--expired` variant) — checkbox feeding `cartSelectedRecIds`; name + LIVE/SYS badge + ⚠ Expired badge; `RM X.xx/ea` price; `[−][qty][+]` stepper with editable `<input type="text">` in the middle (digit-only filter on `input` event; Enter/blur commits; Escape restores; input disabled during in-flight API call); line total; per-item `Renew` button (expired items only); `🗑` delete button.
- **Total row** (`.cim-cart-total-row`) — sum of all line totals (static, always shows the full cart total regardless of selection).

`setCartBodyBusy(true/false)` adds `pointer-events:none; opacity:0.55` to the body during bulk operations. `renderCartContent` calls `setCartBodyBusy(false)` at its very start so the busy overlay is always cleared when the cart reloads — this fixes a freeze where `Renew Expiry` (or bulk `Delete`) on a successful API response would leave the modal permanently grayed.

**Delete confirmation** — clicking `🗑` (per-item) or the bulk `Delete` button calls `showDeleteConfirm(triggerEl, onConfirm)` instead of invoking the API directly. The helper creates a fixed-position popover ("Delete? · Yes · No") above the trigger via `getBoundingClientRect`, appended to `document.body` at `z-index:2147483647`. Yes proceeds with the API call; No or click-outside dismisses. Any existing popover is removed before a new one is shown.

**Closing the modal** — `closeCartModal()` additionally strips `.cim-cart-section`, `.cim-cart-empty`, and `.cim-expired-notice` from the panel, resets `sessionState.{cartHasItems,myrSum,sgdSum,expiredAvailable}` to `null`, and calls `probeCartAndShowButtons()` so the MYR/SGD price sub-labels on the panel buttons refresh immediately after the modal is closed.

## Goods picker

`showGoodsPicker(psid)` → `renderGoodsPicker(body, psid)`. The picker has two modes toggled by a `Normal | ✦ Smart` segmented control at the top.

**Normal mode** — `SEARCH_GOODS { keyword, page }` → `background.js` → `GET /api/goods?keyword=&page=` → `{ ok, result:{ total, pages, items:[{goodsId, name, price, stock, warehouseCode, onSale, img}], noResult } }`. 100 rows/page. `result.noResult === true` means no `items` key — guarded. Pagination shown when `pages > 1`.

**Smart mode** — operator types a comma-separated sentence (both `，` and `,` split); `renderGoodsPicker` splits on `/[，,]/`, trims, drops blanks, then fans out **one `SMART_SEARCH_GOODS` per segment** in parallel. Each segment is further split on whitespace into a `words` array. Results render as labeled groups (`.cim-smart-group`) — one per segment — each with a query label, a count badge (`--found` green / `--empty` grey / `--error` red), and the matched cards below. No pagination. The keydown Enter handler checks `!e.isComposing` so Chinese IME character-confirmation Enter does not fire the search.

`SMART_SEARCH_GOODS { words }` → `background.js` `smartSearchGoods(words)` → `POST /api/goods/search` with body `{ words: string[] }` → `{ ok, items, total }`. Same item shape as `GET /api/goods`. No match → `total: 0, items: []` (never `noResult`). Error → `{ ok: false, msg }`.

**Shared card layout** (`buildGoodsCard(goods)` — closure inside `renderGoodsPicker`): checkbox (`.cim-goods-item-cb`, `data-goods-id` attribute) + 48 × 48 px thumbnail + name + `RM X.xx · Stock: N` meta + `OFF` badge + qty stepper + `Add` button. Both modes use the same builder.

**Multi-select toolbar** (`.cim-goods-toolbar`) sits between the search row and the list:
- `☐ All` select-all label+checkbox (`selectAllCb`) — goes indeterminate on partial selection.
- `Add Selected (N)` button (`addSelectedBtn`) — disabled at 0; shows count when > 0.

`goodsSelectedIds` (module-level `Set`) tracks checked goodsIds. `visibleGoodsIds` (closure array, reset on every render) lists all goodsIds currently in the list — used for select-all logic. `syncToolbar()` keeps both the select-all state and the button text/enabled state in sync.

Switching modes or running a new search clears `goodsSelectedIds` and `visibleGoodsIds` and calls `syncToolbar()`. Switching back to Normal from Smart re-runs `doSearch('', 1)` to restore the initial list.

**Add Selected bulk action**: fires parallel `CART_ADD_ITEM` calls for every item in `goodsSelectedIds`. On each success, marks that card's `Add` button as `✓ Added`. Errors show via `showCartError` toast. After all complete: clears selection, updates toolbar, shows `✓ N added` or `N ok · M failed` for 2 s.

## Checkout view (Goal 4)

Triggered by selecting cart items and clicking **"+ Order"** in the bulk-action toolbar.

**Flow (2 steps):**

**Step 1 — Form** (`showCheckoutView` → `renderCheckoutForm`):
1. `GET_CHECKOUT_FORM { fbUserId, userId, recIds, goodsNumbers }` → `background.js` → `GET /api/checkout?fbUserId=&userId=&recIds=a,b&goodsNumbers=1,2`.
2. Form pre-fills from `customer`: consignee, mobile, address (textarea), email (optional), state select (`stateOptions`), area select (`areaOptions`), postcode, shipping radios (`shippingOptions`).
3. State → Area cascade: on state change sends `GET_REGION_AREAS { stateId }` → `GET /api/regions/areas?stateId=`, repopulates area select, sets postcode to `areas[0].code`. On area change sends `GET_REGION_POSTCODE { areaId }` → `GET /api/regions/postcode?areaId=` to update postcode.
4. Client-side validation before submit: consignee, mobile, address, regionCity, regionArea, shippingIdType all required.
5. "Create Order" button → `CREATE_ORDER { fbUserId, userId, items:[{recId,qty,price}], customer, shippingIdType, confirm:false, pay:false }` → `POST /api/orders`.

**Step 2 — Success panel** (`renderCheckoutSuccess`):
- `✓ Order Created` header.
- `F{orderSn}` in large bold. `via` badge: `🔒 exact` (green) / `⚠ multi-newest` or `⚠ fallback — verify` (amber, `cursor:help` with tooltip).
- Current status text; payable fetched via `GET_ORDER_DETAIL` (`Payable: RM X.XX`).
- **Adjustment section** — type radio (Discount type=1 / Add Amount type=2), amount input, note input, "Apply" button → `ORDER_ADJUSTMENT { orderId, price, type, note? }` → `POST /api/orders/:orderId/adjustments`. Re-fetches detail after success.
- **Action buttons**: "Confirm" → `ORDER_OPERATION confirm`; "Confirm+Paid" → confirm then pay (sequential). Both hidden after order is no longer `待确认`. "View Order" → closes cart modal, opens order detail.

**`POST /api/orders` response shape:**
```
{ ok, orderId, orderSn, status:"待确认", via:"exact"|"multi-newest"|"fallback" }
```

## Copy cart view

Triggered by the **"↙ Copy"** button in the cart header. Lets the operator copy all items from another customer's cart into the currently open one. Quantities merge if the same product already exists.

**Flow (preview → confirm):**
1. Operator types the source customer's `fbUserId` and clicks **Preview** (or presses Enter). A dry-run call (`dryRun: true`) is made; nothing is written.
2. Results appear as color-coded sections:
   - **✓ Will be added** (green) — items that would be copied.
   - **⏭ Will be skipped** (amber) — items not even attempted, with reason. The only current reason is `"expired"`: expired lines are skipped by default unless **Include expired items** is checked.
3. **Confirm Copy** button appears only when `added.length > 0`. Clicking it sends the real (non-dry-run) copy request.
4. After copy, results show:
   - Green success banner: `✓ Copy complete — Added X · skipped Y · failed Z`.
   - **⚠ Failed to add** (red) section if any items were rejected by the portal (e.g. out-of-stock). Each row shows name × qty — error reason.
   - **View Cart** button reloads the cart view with the updated items.

*Skipped* — not attempted (expired, filtered pre-flight by the API). *Failed* — attempted but portal rejected (e.g. insufficient stock).

**Functions in `content.js`:**
- `showCopyCartView(psid)` — entry point; resets `copySourceId`, switches header mode, calls `renderCopyCartView`.
- `buildCopySection(title, count, variant)` — reusable colored section builder (`'added'` / `'skipped'` / `'failed'`).
- `renderCopyCartView(body, psid)` — builds the full form + preview/confirm state machine via closures.

## Background.js message handlers

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
| `GET_CHECKOUT_FORM { fbUserId, userId, recIds, goodsNumbers }` | `GET /api/checkout?...` |
| `CREATE_ORDER { fbUserId, userId, items, customer, shippingIdType, confirm, pay }` | `POST /api/orders` |
| `ORDER_ADJUSTMENT { orderId, price, type, note? }` | `POST /api/orders/:orderId/adjustments` |
| `GET_REGION_AREAS { stateId }` | `GET /api/regions/areas?stateId=` |
| `GET_REGION_POSTCODE { areaId }` | `GET /api/regions/postcode?areaId=` |
