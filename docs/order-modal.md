# Order List & Detail Modal

## Order list modal (Goal 5)

A centered modal (`#cim-order-list-modal` inside `#cim-order-list-overlay`) that shows all non-cancelled orders for a customer. Triggered by clicking the **"Recent Orders ↗"** heading in the orders view. Same visual pattern as the cart modal (480 px wide, 78 vh, shared `.cim-drawer-*` classes).

**Module-level state** (in `content.js`):
- `ORDER_LIST_MODAL_ID`, `ORDER_LIST_OVERLAY_ID` — element IDs.
- `orderListModalPsid` — PSID of the customer whose orders are loaded.

**Functions:**
- `ensureOrderListModal()` — creates the overlay/modal DOM once; returns the modal element. Header has a refresh button (↻) and close (✕). Footer has a Close button. Escape key closes.
- `openOrderListModal(psid, preloadedOrders?)` — sets `orderListModalPsid`, shows the overlay, calls `showOrderList(psid, preloadedOrders)`.
- `closeOrderListModal()` — removes the visible class.
- `renderOrderCards(orders, body)` — renders `.cim-ol-card` elements into `body` for the modal. Used by both the preloaded path and the API refresh path.
- `renderRecentOrdersInPanel(orders)` — finds `div.cim-recent-orders-section` inside the panel, clears it, and rebuilds the top-5 order list. Re-fires `GET_ORDER_STATUSES` and `CHECK_PARCEL_PHOTOS` so the orange highlight and camera icons stay accurate after a refresh. Accepts both field shapes: `totalAmount ?? amount` and `orderDate ?? orderTime`. Called by `renderState` on initial load and by `showOrderList` after a successful API refresh.
- `showOrderList(psid, preloadedOrders?)` — if `preloadedOrders` is provided, calls `renderOrderCards` immediately (zero extra API calls). Otherwise sends `GET_ORDER_LIST { psid }` → `background.js` → `GET /api/orders?fbUserId=<psid>&newStatus=0&noCancel=on`, calls `renderOrderCards` for the modal **and** `renderRecentOrdersInPanel(orders.slice(0, 5))` for the panel — both update from the same fresh data. The refresh button (↻) always calls `showOrderList(psid)` without preloaded orders.
- `mapShippingLabel(method)` — maps raw EC2 shipping method strings to short labels: substring `西马` → `"西马"`, `东马` → `"东马"`, `新加坡` → `"新加坡"`, `system`/`自取` (case-insensitive) → `"自取"`, otherwise returns the raw string.
- `formatOrderDate(dateStr)` — parses any `Date`-compatible string and returns `"D/M/YYYY"` (no leading zeros); falls back to the raw string if unparseable.

**API response** (`GET_ORDER_LIST`):
```
GET /api/orders?fbUserId=<psid>&newStatus=0&noCancel=on
→ { ok, orders: [{ orderId, orderSn, mobile, amount, consignee, statusText,
                   statusParts, orderTime, shippingMethod, paymentMethod }] }
```
`statusParts` is `{ confirm, payment, shipping }`. The EC2 API now returns `orderSn` already F-prefixed (e.g. `"F0955820260113003753"`). `background.js` passes it through verbatim — **never prepend `"F"` on the client.** The leading `0` after `F` is order-dependent and cannot be reconstructed client-side; always use the raw API value.

**Card layout** (`.cim-ol-card`, flex column, `gap: 5px`):
1. `.cim-ol-top` — `orderSn` (already F-prefixed, bold, `.cim-ol-sn`) + `RM X.XX` (green, `.cim-ol-amount`) — flex row, space-between.
2. `.cim-ol-mid` — `consignee · mobile` in secondary grey.
3. `.cim-ol-info` — `formatOrderDate(orderTime) · mapShippingLabel(shippingMethod)` in small muted text (11 px, `#8a8d91`). Omitted entirely when both values are falsy.
4. `.cim-ol-bot` — status badge pills (`.cim-ol-status-badge`), one per `statusParts` key (`confirm`, `payment`, `shipping`); color-coded:
   - `已…` → green (`.cim-ol-status--done`)
   - `未…` → amber (`.cim-ol-status--pending`)
   - `待…` → grey (`.cim-ol-status--waiting`)
   Falls back to a single badge from `statusText` if `statusParts` is absent.

## Order detail view (Goal 6)

Order list cards are clickable (`.cim-ol-card--clickable`, `cursor: pointer`). Clicking one calls `openOrderDetail(orderId)` which shows the detail inside the **same `#cim-order-list-modal`** — no second modal.

The header swaps between two modes via `setOrderListHeaderMode(mode, modal)`:

| Element | `'list'` mode | `'detail'` mode |
|---|---|---|
| `.cim-ol-back-btn` (← Back) | hidden | visible |
| `.cim-cart-refresh-btn` (↻) | visible | hidden |

**Back and refresh buttons use delegating actions** — both buttons delegate to `modal._backAction` / `modal._refreshAction` rather than being hard-wired. Each view sets these before switching header mode:

- `showOrderList(psid)` — sets `_refreshAction = () => showOrderList(psid)`.
- `showOrderDetail(orderId)` — sets `_backAction` → `showOrderList`, `_refreshAction` → `showOrderDetail(orderId)`. Respects `modal._noBack`: when true, `_backAction` is not set and the back button stays hidden.
- `showEditConsigneeDialog(...)` — sets `_backAction` → `showOrderDetail(orderId)` so ← Back returns to the detail view, not the list.

**`modal._noBack` flag** — set by `openOrderDetailNoBack(orderId)` before calling `showOrderDetail`. Causes `showOrderDetail` to skip setting `_backAction` and to force-hide the back button after `setOrderListHeaderMode('detail', ...)`. Cleared by `openOrderListModal` so the full list → detail flow still shows the back button normally. Used when opening order detail directly from the panel's recent-orders list.

**Module-level state added:**
- `orderDetailOrderId` — orderId of the currently-rendered detail; used as a stale-response guard (`if (orderDetailOrderId !== orderId) return`).

**Footer in detail/edit mode** — `ensureOrderListModal()` builds the footer with two zones: `.cim-ol-footer-actions` (left, flex row) and the standard Close button (right). `#cim-order-list-modal .cim-drawer-footer` overrides the global `justify-content` to `space-between`. Action buttons are injected into `.cim-ol-footer-actions` by `renderOrderDetail` and cleared on every view transition.

**Functions:**
- `openOrderDetail(orderId)` — ensures the overlay is visible, calls `showOrderDetail` (back button shown; used from the order list modal).
- `openOrderDetailNoBack(orderId)` — sets `modal._noBack = true`, shows the overlay, calls `showOrderDetail` (back button hidden; used from the panel's recent-orders list).
- `showOrderDetail(orderId)` — sets `orderDetailOrderId`, sets `_backAction`/`_refreshAction` (skips `_backAction` when `modal._noBack`), switches header to `'detail'` mode, clears footer actions, fetches `GET_ORDER_DETAIL`, calls `renderOrderDetail`.
- `renderOrderDetail(body, modal, data)` — renders the full detail and populates footer buttons.
- `doOrderOperations(orderId, operations, modal)` — runs an array of EC2 operations in sequence (e.g. `['confirm', 'pay']` for Confirm+Paid), then re-fetches the detail.
- `showOrderDetailToast(modal, msg)` — shows a `.cim-od-toast` error banner at the top of the body for 4 s; creates the element once and reuses it.
- `showEditConsigneeDialog(modal, orderId, detailData)` — sets `_backAction` → `showOrderDetail`, switches title to "Edit Recipient", fetches `GET_ORDER_CONSIGNEE`, calls `renderEditConsigneeForm`.
- `renderEditConsigneeForm(body, modal, orderId, form, detailData)` — builds the edit form (consignee, mobile, email, address, postcode, order note, CS note); puts Cancel + Save in `.cim-ol-footer-actions`. Cancel re-renders from cached `detailData` (no refetch). Save calls `UPDATE_ORDER_CONSIGNEE` then re-fetches via `showOrderDetail`.

**`renderOrderDetail` layout** (top → bottom inside `.cim-drawer-body`):
1. `.cim-od-status-row` — three `.cim-ol-status-badge` pills reusing existing colour classes (`--done` / `--pending` / `--waiting`).
2. `.cim-drawer-info-card` — order meta: Order Time, Payment, Pay Time (if paid), Shipping, Ship Time (if shipped), Buyer name.
3. **Recipient** `.cim-od-section` — section header with title + **Edit** button (`.cim-od-edit-btn`); info card with Name / Mobile / Email / Address.
4. **Items** `.cim-od-section` — `.cim-od-items-list`; each `.cim-od-item-row` has: 44 × 44 px thumbnail (`.cim-od-item-img-wrap`), name + meta line (live code `.cim-od-item-code`, origin `.cim-od-item-origin`, ship state badge `.cim-od-ship--done` / `--pending`), qty × line total column. When `item.img` is present, the wrap gets `.cim-od-item-img-wrap--clickable` (`cursor: zoom-in`; image scales 12% on hover). Clicking it calls `openGalleryModal(itemImgList, capturedIdx)` where `itemImgList` is all items-with-images in this order (built before the loop as `[{ url, id, label }]`) and `capturedIdx` is the 0-based index into that list. This lets the operator arrow-key through all product images in the order. Escape inside the gallery only closes the gallery.
5. **Summary** `.cim-od-section` — `.cim-od-fee-list` rows: Subtotal, Shipping, Discount (green, `--discount`), Add Amount (red, `--add`), **Payable** (bold, `--payable` with top border).
6. **Adjustment** (`.cim-checkout-adj`) — **hidden when `statusParts.shipping` starts with `已` (order already shipped)**. Otherwise: type radio (Discount type=1 / Add Amount type=2), amount input, note input, "Apply" button → `ORDER_ADJUSTMENT { orderId, price, adjType, note? }`. On success calls `showOrderDetail(orderId)` to re-fetch and re-render. Error via `showOrderDetailToast`.
7. **Notes** `.cim-od-section` — Order Note and CS Note; omitted when both absent.
8. **Parcel Photos** `.cim-od-section` — async, appended after Notes. Sends `GET_PARCEL_PHOTO_ORDER { orderId: data.orderSn }` (F-prefixed). If `photoRes.found && photoRes.orders.length`, renders using `buildWmsContent()` reused from the parcel drawer: single WMS → flat content inside the section; multiple WMS → collapsible `.cim-parcel-section` subsections (first expanded). If no photos, the placeholder is removed silently. Stale-response guard: `orderDetailOrderId !== capturedOdId` aborts the callback.

**Action button logic** (derived entirely from `statusParts` string prefixes):

| `statusParts` state | Buttons shown |
|---|---|
| `confirm` starts with `待` | **Confirm** + **Confirm+Paid** |
| `confirm` not `待` AND `payment` starts with `未` | **Pay** |
| `payment` starts with `已` AND `shipping` starts with `未` | **Ship** |

`doOrderOperations` sequences operations: Confirm+Paid fires `confirm` → on success fires `pay`, then refetches. Any failure re-enables buttons and shows a toast. Ship maps to the EC2 operation string `"shiped"` (verbatim, as captured from portal).

**Edit consignee form** — `regionCity` and `regionArea` (EC2 region IDs) are held from the fetched `form` object and sent back unchanged on save; the operator edits consignee / mobile / email / address / postcode (regionCode) / order note / CS note. Required fields (`consignee`, `mobile`, `address`, `regionCode`) are validated client-side before the POST.

## API contracts

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
`payTime`/`shipTime` are datetimes when done, otherwise the literal `未付款`/`未出货`. HTTP 422 for an unknown orderId.

**`GET /api/orders/:orderId/consignee` response shape:**
```
{ ok, form: { consignee, mobile, email, address, serviceNote, note,
              regionCountry, regionCity, regionArea, regionCode,
              countries:[{id,name}] } }
```

## Background.js handlers

| Message type | API call |
|---|---|
| `GET_ORDER_LIST { psid }` | `GET /api/orders?fbUserId=<psid>&newStatus=0&noCancel=on` |
| `GET_ORDER_DETAIL { orderId }` | `GET /api/orders/:orderId` |
| `GET_ORDER_CONSIGNEE { orderId }` | `GET /api/orders/:orderId/consignee` |
| `UPDATE_ORDER_CONSIGNEE { orderId, data }` | `POST /api/orders/:orderId/consignee` |
| `ORDER_OPERATION { orderId, operation }` | `POST /api/orders/:orderId/operations` |
