# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension that injects a customer-info panel into Meta Business Suite's Messenger inbox (`https://business.facebook.com/latest/inbox/*`). By default the panel sits above the "Contact details" section in the right sidebar; users can drag it anywhere on screen via the handle at the top.

Plain JS/HTML/CSS, no build step, package manager, or test suite — loaded directly as an unpacked extension.

## Development workflow

- Reload via `chrome://extensions` after editing (full reload needed if `manifest.json` changes).
- Config lives in `chrome.storage.local`, set via the options page (`chrome://extensions` → this extension → "Details" → "Extension options"):
  - `manychatToken` — ManyChat API token.
  - `baserowBaseUrl` / `baserowToken` / `baserowUsersTableId` (`749`) / `baserowOrdersTableId` (`750`). If the base URL's host changes, also update `host_permissions` in `manifest.json`.
  - `aiApiUrl` / `aiApiToken` — AI Reply backend base URL (trailing slash stripped on save) and optional Bearer token. The backend must expose `GET /ai/health` and `POST /ai/reply`. Also add the backend host to `host_permissions` in `manifest.json` once the URL is known.
- Debugging: `content.js` logs to the Business Suite tab's DevTools console; `background.js` via the "service worker" link on `chrome://extensions`.
- No live Facebook/ManyChat/Baserow sandbox for CLI testing — verify DOM-scraping and API changes manually in a real Business Suite tab.

## Module docs

### [core-architecture.md](./docs/core-architecture.md)
Three-piece architecture: `content.js` (DOM + UI), `background.js` (cross-origin fetch), `options.html/js` (config). State machine `sessionState` drives customer lookup via `check()` on every `MutationObserver` tick. Covers: UID→PSID lookup flow, `uidPsidMap` storage, `rehydrate()`, `proceedWithLookup()` stale-DOM guard, and fragile DOM selectors (`findContactDetailsAnchor`, `getCustomerNameFromDom`, `findMessengerReplyBox`).

### [ui-panel.md](./docs/ui-panel.md)
Panel visual theme (blue `#0a7cff`, light background, tight sidebar margins). Draggable panel lifecycle: sidebar-docked vs. floating (`panelPosition`, `.cim-floating`). Close/restore button visibility logic (`syncCloseBtnVisibility`, `.cim-sidebar-visible`). Name row → opens cart modal; PSID row → clipboard copy. Language tag toggle (Chinese `35385444` / English `35385464`): visual states, click sequence (remove-then-add), error handling.

### [ai-rewrite.md](./docs/ai-rewrite.md)
`#cim-ai-buttons` bar injected into Facebook's composer (not the panel). Health-check gate (`GET /ai/health`, cached in `aiHealthy`). Button layout: ↩ back | ✨ AI Rewrite | 华语/English toggle. Covers: Lexical editor empty/filled detection, `clearReplyBox()` char-by-char backspace loop, `insertTextIntoMessenger()` via paste ClipboardEvent, `injectTextIntoReplyBox()` for prepend. Backend contract: `POST /ai/reply { messages, mode:"quick", language }`.

### [manychat.md](./docs/manychat.md)
ManyChat API calls (all via `background.js`): `searchManyChatByName` (find by name → candidate cards), `getManyChatInfo` (phone/email/WhatsApp/tags, cached in `sessionState.manychatInfo`), `manyChatTagAction` (add/remove tag). Manual candidate search bar: empty → re-search by name, "F…" → Baserow order ID lookup, numeric → Baserow PSID lookup.

### [baserow.md](./docs/baserow.md)
Two tables: Users (`749`) and Orders (`750`). `findBaserowUserRowByPsid`, `updateBaserowRowUid` (PATCH), `createBaserowUserRow` (POST). Summary panel fields (Total Spending, Total Purchase, Last Order via `formatRecency()`, Years Active, Rank, Address with copy button). Recent orders: EC2 primary (`fetchOrderList`), Baserow fallback-only when EC2 < 5 orders, deduped by `orderSn`. EC2 orders (blue `<span role="button">`) open order detail via `openOrderDetailNoBack`; Baserow-only orders (grey `<a>`) link to `ddherbs.com.my/track/<orderSn>`. Layout: float-based (amount float:right, inline text flow so date is continuous after SN). Status colouring: `GET_ORDER_STATUSES` → AWS Lambda → `WAIT_AUDIT` = orange.

### [cart-summary-buttons.md](./docs/cart-summary-buttons.md)
Cart API base: `https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest`. Session check on load (`CHECK_SESSION`). `probeCartAndShowButtons()`: `GET /checkSession` → if valid, GET cart summary option 1. Three buttons: ALL (option 1), 🇲🇾 MYR (option 2, green, shows `RM X`), 🇸🇬 SGD (option 3, amber, shows `S$ X`). Expired items → amber pill. Cart prefix textarea (bilingual livestream reminder, persists within page session). Copy-to-clipboard with "Copied!" tooltip.

### [cart-modal.md](./docs/cart-modal.md)
Full EC2 cart management modal (`#cim-cart-modal`, 480 px, 78 vh). Opened by clicking customer name. Four header modes: `cart` / `goods` / `checkout` / `copy`. Cart view: item rows with checkbox, qty stepper (inline input, Enter/blur commits), per-item delete (popover confirm), bulk Delete + Renew Expiry, sticky total bar. Goods picker: Normal mode (keyword search, pagination) + Smart mode (comma-split → parallel `SMART_SEARCH_GOODS` per segment, labeled groups). Product thumbnails are clickable (zoom-in cursor) → full-screen gallery modal. Multi-select toolbar: **Quote** button (copies `"{name} - RM {price}"` lines to clipboard) + **Add Selected**. `goodsDataMap` caches `{name, price}` per goodsId for the Quote button. Checkout (2-step: form prefill → success panel with adjustment + Confirm/Pay buttons). Copy cart (source fbUserId → dry-run preview → confirm → green/amber/red result sections). Lists all `background.js` message handlers with API calls.

### [order-modal.md](./docs/order-modal.md)
Order list + detail inside one modal (`#cim-order-list-modal`, 480 px, 78 vh). List triggered by "Recent Orders ↗" heading — passes already-fetched `allOrders` so no second API call is made. Refresh button (↻) re-fetches via `GET_ORDER_LIST` and updates both the modal and the panel's top-5 from the same data. `orderSn` is returned F-prefixed by the EC2 API itself (e.g. `F0955820260113003753`); `background.js` passes it through verbatim — never prepend `"F"` on the client. Detail view: status row, order meta, recipient + Edit, items (44 × 44 px thumbnails clickable → gallery showing all item images in the order with ←/→ nav), fee breakdown, adjustment (hidden when `statusParts.shipping` starts with `已`), notes, and async Parcel Photos section (reuses `buildWmsContent`, keyed by `data.orderSn`). Action buttons from `statusParts`: Confirm, Confirm+Paid, Pay, Ship. `openOrderDetailNoBack` sets `modal._noBack = true` so the back button is suppressed when opening from the panel. Delegating `_backAction`/`_refreshAction` pattern.

### [parcel-photos.md](./docs/parcel-photos.md)
After orders render, `CHECK_PARCEL_PHOTOS` batch-probes all order IDs (`GET /parcelPhotos/check?ids=…` → booleans). Camera icon appended to orders with photos. Clicking opens centered modal (`#cim-parcel-drawer`). Single WMS: flat info card + meta + photo sections (Internal lavender / Customer green / Other grey). Multiple WMS: collapsible sections, first expanded. Gallery modal: full-screen dark overlay, ‹/› nav, thumbnail strip, keyboard (←/→/Escape). Gallery keydown listener uses `capture: true` + `stopImmediatePropagation` so Escape/arrows are consumed by the gallery and never reach the parent modal's Escape handler. Detail endpoint: `GET /parcelPhotos/order/:orderId`.
