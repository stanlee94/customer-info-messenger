# Parcel Photos — Icon, Modal, Gallery

After the orders list is rendered, `content.js` fires two parallel async calls: `GET_ORDER_STATUSES` and `CHECK_PARCEL_PHOTOS`. Both use the same captured `uid` guard so stale responses from a previous customer are discarded.

## Batch photo probe

`CHECK_PARCEL_PHOTOS` sends `background.js` the full `orderIds` array. `background.js` calls:

```
GET ${CART_API_BASE}/parcelPhotos/check?ids=<id1>,<id2>,...
→ { count, results: { [orderId]: { hasPhotos: boolean, imageCount: number } } }
```

No auth, no image bytes — just booleans. `content.js` iterates the results and, for every order where `hasPhotos === true`, appends a `.cim-photo-icon` camera SVG button to that order's `.cim-order-id-wrap`. The icon is skipped if one already exists (idempotent). `.cim-order-id` elements carry a `data-order-id` attribute (set at render time) so lookup is `querySelector('[data-order-id="…"]')` rather than text matching.

## Centered modal

Clicking the camera icon calls `openParcelDrawer(orderId)`, which:
1. Calls `ensureParcelDrawer()` — creates `#cim-parcel-overlay` (the centering backdrop) with `#cim-parcel-drawer` (the modal) nested inside it, both appended to `document.body` once; subsequent calls return the existing modal.
2. Shows `.cim-parcel-overlay--visible` (`display: flex`, centers the modal).
3. Sends `GET_PARCEL_PHOTO_ORDER { orderId }` → `background.js` calls `GET ${CART_API_BASE}/parcelPhotos/order/<orderId>`.
4. Renders `renderDrawerContent(body, modal, res, orderId)` on success.

Closing: ✕ button in modal header, Close button in modal footer, clicking the backdrop (`e.target === overlay`), or Escape key all call `closeParcelDrawer()` which removes `.cim-parcel-overlay--visible`.

**Modal layout** — `#cim-parcel-drawer` is `height: 85vh; display: flex; flex-direction: column`. The body (`.cim-drawer-body`) is `flex: 1; min-height: 0; overflow-y: auto; display: block` — block (not flex) so the flex engine doesn't fight the height constraint, enabling reliable inner scroll when collapsibles expand.

The modal header shows:
- **Title** — `wmsOrder.customerName` from the first WMS order (falls back to `orderId`).
- **Subtitle** — parcel count: counts only WMS orders that have a `trackingNumber`. Orders without tracking are still rendered but not counted.

## Content rendered by `renderDrawerContent` + `buildWmsContent`

*Single WMS* — content is rendered flat (no collapsible wrapper):
- Info card (`.cim-drawer-info-card`) — bordered table with rows: Customer / WMS ID / ERP ID / EC2 Order (blue link → `https://ddherbs.com.my/track/<id>`) / Task ID / Tracking. The Tracking row always renders: shows the number if present, or `"No tracking number"` in red italic (`.cim-drawer-info-value--no-tracking`) if absent.
- Meta line (`.cim-drawer-meta`) — `⏱ HH:MM am/pm · createdBy`.
- Photo sections — one `.cim-drawer-kind-section` per kind present: `[Internal]` lavender pill + `内部存档 · N` / `[Customer]` green pill + `客户可见 · N` / `[Other]` grey pill. 3-column `.cim-drawer-photo-grid` of `.cim-drawer-thumb` tiles.
- `kind: null` photos fall into "Other" (never silently dropped).

*Multiple WMS* — each order is a collapsible `.cim-parcel-section` row:
- **Header** — WMS ID (bold) + optional `[No tracking]` rose pill (`.cim-parcel-no-tracking`) when `trackingNumber` is absent + photo count + ▸ chevron. WMS ID text is red (`.cim-parcel-section-title--no-tracking`) when no tracking number.
- **Body** — same info card / meta / photo sections as the single-WMS flat layout, shown/hidden via `sectionBody.style.display` toggled by the header click.
- First parcel starts expanded; all others start collapsed.

## Detail endpoint contract

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
HTTP 500 on Baserow failure; `found: false` for unknown order IDs — branch on HTTP status first, then `found`.

## Gallery modal

Clicking any `.cim-drawer-thumb` calls `openGalleryModal(wmsOrder.images, startIndex)` where `images` is the flat per-WMS combined array and `startIndex` is the clicked photo's position within it. The modal (`#cim-gallery-modal`, `display:none` → `display:flex`):
- Full-screen dark overlay (`rgba(0,0,0,0.92)`), `z-index: 2147483647`.
- Centre image (`.cim-gallery-img`, `object-fit: contain`).
- `‹` / `›` navigation buttons (hidden when `images.length <= 1`).
- `N / total` counter at the top centre.
- Scrollable thumbnail strip (`.cim-gallery-thumbs`) at the bottom; active thumb gets a white border + full opacity.
- Keyboard: `←`/`→` to navigate, `Escape` to close. The `keydown` listener is attached on open and removed on close (`modal._onKeyDown`).
- Clicking anywhere that is not a button, image, or thumb strip closes the modal (`!e.target.closest('button, img, .cim-gallery-thumbs')`).

## Module-level state (in `content.js`)

- `PARCEL_DRAWER_ID`, `PARCEL_OVERLAY_ID`, `GALLERY_MODAL_ID` — element IDs.
- `galleryImages` — current image array for the open gallery session.
- `galleryIndex` — current image index.

No `manifest.json` changes needed — `yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com` is already in `host_permissions` for the cart endpoints.

## Smoke-test curl

```bash
BASE=https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest
# Batch probe (all order IDs at once):
curl "$BASE/parcelPhotos/check?ids=F955820260720007336,F955820260722007192"
# Detail (on icon click):
curl "$BASE/parcelPhotos/order/F955820260722007192"
```
