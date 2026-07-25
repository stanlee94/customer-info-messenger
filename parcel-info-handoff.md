# Parcel Info tab — full handoff

> Complete walkthrough of **Tab 13 "Parcel Info"** (`UploadPhoto.jsx`) for a fresh
> instance: design, the modals, the internal-vs-customer photo model, and the exact
> API call flow for searching. This is a **derived** doc — the authoritative contract
> is [upload-photo-brief.md](../upload-photo-brief.md); per-tab notes live in
> [features.md](features.md) → *Parcel Info tab*.

## Files at a glance

| Concern | Location |
|---|---|
| Component | [client/src/components/UploadPhoto.jsx](../client/src/components/UploadPhoto.jsx) |
| Backend routes | [src/app.js](../src/app.js) lines ~1271–1547 (`/api/customer-photos*`) |
| Cloudflare proxies | `functions/api/customer-photos.js` + `functions/api/customer-photos/[[path]].js` |
| Route + gating | `client/src/App.jsx` (`ROLE_TABS`, `ROLE_LANDING`, Tools group, `/parcel-info`) |
| Shared UI reused | `client/src/shared/` (`Modal`, `Lightbox`, `PhotoCapture`, `dateGroups`, `useInfiniteList`, `icons`, `imageResize`) |
| Styles | `App.css` — `.gr-*` (shared list/card/modal language) + `.up-*` (Parcel-specific) |

---

## 1. What this tab is for

Packers/checkers photograph a customer's parcel and attach the photos to the right
order by **scanning a QR/barcode on the order paper**. There are **two moments** in
fulfilment, and both must land on the **same order record**:

| Moment | Scanned code | Photos are | `Kind` |
|---|---|---|---|
| **Packing** | **Task ID** (`TASK…` + digits) | evidence of contents/condition | `internal` |
| **Shipping** | **tracking number** (QR or Code128 barcode) | the box the customer receives | `customer` |

Both identifiers resolve — via an **external WMS lookup Lambda** — to one canonical
**WMS order**. The Baserow record is **keyed on `WMS_ID` (one row per order)**, so
re-scanning **either** identifier upserts into the same row (**never duplicates**).
One order therefore accumulates both photo buckets over time.

**Add is mobile + scan only. There is no create-on-PC path.** Desktop is a searchable,
read-only list for everyone.

---

## 2. Roles & access

| Role | View list | Add (mobile scan) | Delete |
|---|---|---|---|
| `checker` | ✅ | ✅ | ❌ |
| `admin` | ✅ | ✅ | ✅ |
| `customer_service` | ✅ | ❌ | ❌ |

- **Frontend gate** (`UploadPhoto.jsx` top of component):
  `canAdd = (roles.includes('checker') || isAdmin) && isCoarsePointer()`.
  `isCoarsePointer()` = `matchMedia('(pointer: coarse)')` → the Scan button and FAB
  render **only on mobile**, so desktop is view-only even for a checker/admin. Delete
  is gated by `canDelete={isAdmin}`.
- **Backend gate** (defence in depth, roles read fresh from Baserow via `userRoles(req)`):
  `POST /api/customer-photos` → 403 unless `checker`/`admin`;
  `DELETE /api/customer-photos/:id` → 403 unless `admin`.
- **First-load landing:** a `checker` lands on this tab (`ROLE_LANDING` in `App.jsx`).
  For multi-role users the first role with a landing entry wins.

---

## 3. Design / layout

Built from the shared `.gr-*` visual language (same as Inventory / Purchase Search) —
a full-bleed tab (`#tab13.tab-content { padding: 0 }`, `.gr-root { overflow: visible }`
on mobile so the sticky toolbar works).

**Toolbar** (`.gr-toolbar` → `.gr-toolbar-row.up-toolbar-row`, a `<form>`):
- Search input (`.gr-input`) with a search icon and an inline clear (✕) button.
- **Search** button (`.gr-search-btn`) — submits the form.
- **Refresh** button (`.gr-refresh-btn`, light mint-green, spins via `gr-spin` while
  `list.loading`) — calls `list.reload()`; shown on all screens.
- **Scan** button (`.gr-new-btn`) — desktop only and only if `canAdd`; opens the scanner.
- Desktop order: search · Search · Refresh · Scan. On mobile (≤768px) `.up-toolbar-row`
  reorders to **Refresh · search bar · Search**, and Scan is hidden (the FAB replaces it).

**Content** (`.gr-content`, the scroll container):
- Loading ring / error box / empty state as appropriate.
- Otherwise a **date-grouped infinite-scroll list** (`groupByDate` → `.gr-group`).
  Each date header shows the relative day + order count + total photo count.
- Each order is a **`RecordCard`** (`.gr-entry.up-entry-clickable`): thumbnail of the
  first photo (with a count badge if >1), customer name (user icon), upload time, and
  Task ID / tracking chips. A `›` chevron signals the **whole row is clickable** →
  opens the read-only detail modal.
- A sentinel div (`list.sentinelRef`) at the bottom loads the next page when it nears
  the viewport (`IntersectionObserver`, `rootMargin: 400px`).

**Mobile Scan FAB** (`.gr-fab`, `canAdd` only) — floating QR button, opens the scanner.

---

## 4. The modals

There are **six** modal states, driven by the `flow` state
(`null | scan | looking | notfound | error | choose | add`) plus a separate `detail`
state for the read-only view and a `lightbox` state for full-screen photos.

| Modal | Component | When | Shows |
|---|---|---|---|
| **Scan order QR** | `ScannerModal` | `flow.step === 'scan'` | Live camera (`@zxing/browser` `BrowserMultiFormatReader`, rear camera, decodes QR **and Code128**) + a green reticle + a **manual-type fallback** input. On decode/submit → `doLookup(value)`. |
| **Looking up…** | inline `Modal` | `'looking'` | Spinner "Searching WMS…" while `/lookup` is in flight. |
| **No order found** | inline `Modal` | `'notfound'` | "No order matched '<query>'" + **Scan again**. |
| **Lookup failed** | inline `Modal` | `'error'` | Error message + **Try again**. |
| **Multiple orders found** | `ChooseMatchModal` | `'choose'` | A pick-list of matches (customer name + WMS/Task/tracking); picking one → `AddModal`. |
| **Add photos** | `AddModal` | `'add'` | See below. |
| **Detail (read-only)** | `DetailModal` | `detail` set (row tapped) | See below. |
| **Lightbox** | `Lightbox` | `lightbox` set | Swipeable full-screen photo viewer. |

### AddModal (mobile add flow)
- Header **`OrderInfo`** panel (read-only): Customer, WMS ID, ERP ID, **EC2 Order**
  (links out to `https://ddherbs.com.my/track/<ec2OrderId>`), Task ID, Tracking.
- A **Photo type toggle** (`Kind`): **Internal 内部存档** vs **Customer 客户可见**,
  defaulted by `defaultKind(matchType, query)` — `task`/`TASK…` → `internal`, else
  `customer`.
- **"Already uploaded"** — read-only thumbnails of the existing photos in the currently
  selected bucket (context so you don't duplicate); tapping opens the Lightbox.
- **`PhotoCaptureField`** — the shared capture/gallery grid. Photos are captured with
  `usePhotoCapture([], { stamp: true })`, which **burns the upload date/time into the
  bottom-right of each photo** (Parcel photos are stamped; Inventory photos are not) and
  downscales client-side before upload.
- **Save photos** → `POST /api/customer-photos` (multipart) → on success closes the flow
  and calls `list.reload()`.

### DetailModal (read-only, opened by tapping any card)
- Title = customer name. Header `OrderInfo` panel + created time / creator line.
- **Two photo sections** rendered from `rec.internal` and `rec.customer`, each with a
  kind badge, the Chinese label, and a count; empty sections show "No … photos yet".
  Tapping any photo opens the Lightbox.
- **Footer Delete button** — admin only (`canDelete`); confirms via `window.confirm`,
  then `DELETE /api/customer-photos/:id`, optimistically removing the row from the list.

---

## 5. Internal vs Customer photos — the difference

Both live on the **same order record** (same `WMS_ID` row) but each **`Customer_Photo_Items`**
row carries a `Kind` single-select. This is the whole point of the two-moment model:

| | **Internal** (`internal` / 内部存档) | **Customer** (`customer` / 客户可见) |
|---|---|---|
| Scanned from | **Task ID** (`TASK…`) — at **packing** | **Tracking number** — at **shipping** |
| `matchType` from WMS | `"task"` | `"tracking"` |
| What it captures | Contents / condition evidence before sealing | The finished parcel/box the customer will see |
| Default bucket in AddModal | selected automatically | selected automatically |

- The default is chosen by `defaultKind(matchType, query)` but the packer can override the
  toggle before saving.
- On the backend nothing distinguishes them except the `Kind` field on each item row; the
  header row is shared. `mapCustomer()` splits items into `internal[]` and `customer[]`
  (plus a combined `images[]` for the card thumbnail/count).

---

## 6. Data model (Baserow → S3 for bytes)

Mirrors Inventory's Entries/Entry_Items (header + one row per photo).

**Table A — `Customer_Photos`** (env `BR_CUSTOMER_PHOTOS`, one row per WMS order):
`Name`, `WMS_ID` (**join key, unique**), `ERP_ID`, `EC2_Order_ID`, `Task_ID`,
`Tracking_Number`, `Customer_Name`, `Last_Photo_At` (Date+time — **list sort key**,
stamped = now on every upload), `Created_By`, `Created_At` (auto).

**Table B — `Customer_Photo_Items`** (env `BR_CUSTOMER_PHOTO_ITEMS`, one row per photo):
`Name` (S3 key), `Entry` (link→A), `Photo_URL` (permanent public S3 URL), `Kind`
(single-select **`internal`/`customer`**), `Uploaded_By`, `Created_At` (auto).

- **Why `Last_Photo_At`?** Baserow parent rows don't bump their modified time when a child
  item is inserted, so an explicit timestamp is stamped on each upload and used as the sort
  key (`order_by=-Last_Photo_At`, newest first).
- **Photo storage:** `ddlive-qrcode` bucket, prefix `goods/customer-photos/`, **public-read**
  (same policy/IAM as Inventory), so `Photo_URL` is a permanent public URL. Key shape:
  `goods/customer-photos/<entryId>-<random>.<ext>`.

---

## 7. Backend endpoints

All JWT-protected (global `requireAuth`). In [src/app.js](../src/app.js):

| Method + path | Purpose |
|---|---|
| `POST /api/customer-photos/lookup` | `{ query }` → `wmsLookup()` resolves the scan, then `findCustomerByWms(wmsId)` reads any existing record + its photos. Returns `{ found, matchType?, order?, existing?, multiple?, matches? }`. |
| `GET /api/customer-photos?q=&limit=&offset=` | Paginated list, `Last_Photo_At` desc. Search + sort + pagination pushed **down to Baserow** (see §8). |
| `POST /api/customer-photos` | Multipart upsert-on-`WMS_ID`. Roles: `checker`/`admin`. |
| `DELETE /api/customer-photos/:id` | Cascade delete items + S3 objects + header. Roles: `admin`. |

**WMS lookup** (`wmsLookup`): `POST {WMS_LOOKUP_URL}` with body `{ query, type: 'auto' }`
and optional `x-api-key`. **Live in production.** When `WMS_LOOKUP_URL` is unset it falls
back to `mockWmsLookup` — a deterministic `WMOCK-…` order (TASK-prefix → `matchType:'task'`)
— so the tab is usable in local dev before the Lambda is wired.

**Upsert logic** (`POST`): `findCustomerByWms(wmsId)` — if no row, create the header; if a
row exists, **fill in only blank identifiers** (e.g. tracking arriving at the shipping step)
and always bump `Last_Photo_At`. Then upload each file to S3 and create one item row per
photo tagged with `Kind`. Returns the mapped record.

---

## 8. Search — the exact API call flow

The search bar does **not** fire per keystroke. Two pieces of state:
- `search` — the live input value.
- `q` — the **submitted** query; only changes on Search-button click / Enter (`submitSearch`)
  or clear (`clearSearch` resets both to `''`).

`q` is passed into the list hook: `useInfiniteList({ endpoint: '/api/customer-photos', params: { q } })`.

**Flow when the user submits a search:**

1. `submitSearch` → `setQ(search.trim())`.
2. `useInfiniteList` sees `params` change (via `paramsKey = JSON.stringify(params)`), its
   effect runs `setRecords([])` then `load(0)` (fresh load, page 1).
3. `load(0)` builds `GET /api/customer-photos?limit=20&offset=0&q=<query>`
   (empty/null params are omitted, so no `q` when cleared) with `credentials: 'include'`.
4. **Cloudflare Pages Function** `functions/api/customer-photos.js` proxies GET → the Lambda.
5. **Backend** `GET /api/customer-photos`:
   - `page = floor(offset/limit) + 1` (Baserow pages by number, not offset).
   - Builds Baserow params: `user_field_names=true`, `size=limit`, `page`,
     `order_by=-Last_Photo_At`.
   - If `q`: `filter_type=OR` + a `filter__<field>__contains=<q>` for **each** of
     `CUST_SEARCH_FIELDS` = Customer_Name / Task_ID / Tracking_Number / WMS_ID / ERP_ID /
     EC2_Order_ID. **Baserow does the matching server-side**, so a hit on row #5000 is still
     found without loading the whole table.
   - One `GET` to Baserow returns that page of headers (+ `count` = total). Then
     `fetchCustItems(pageRowIds)` fetches only that page's photo items, and `loadUserNameMap()`
     resolves creator names (both in parallel).
   - `mapCustomer(row, items)` shapes each row (splits items into `internal`/`customer`).
   - Responds `{ total, offset, limit, count, data }`.
6. **Frontend** sets `total` and **replaces** `records` (offset 0 = replace; offset > 0 =
   append). The list re-renders grouped by date.
7. **Pagination:** scrolling to the sentinel calls `load(records.length)` →
   `offset=records.length` → next page, **appended**. Same `q` rides along, so search results
   paginate too.

**Refresh button** is the same as a submit but keeps the current `q`: it calls
`list.reload()` = `load(0)`.

Key contrast with Inventory: **this list filters server-side (one page per request)**;
Inventory still filters its list in memory. This keeps Parcel Info flat as the table grows.

---

## 9. Env vars

```
BR_CUSTOMER_PHOTOS=        # Baserow table A id
BR_CUSTOMER_PHOTO_ITEMS=   # Baserow table B id
WMS_LOOKUP_URL=            # external WMS Lambda POST endpoint (live in prod)
WMS_LOOKUP_API_KEY=        # optional; sent as x-api-key
```
Plus the shared `BASEROW_TOKEN` / `BASEROW_URL` and the `ddlive-qrcode` S3 setup.
Client dep added: `@zxing/browser` (QR + Code128 scanning).

---

## 10. Gotchas for the next instance

- **Route naming rule:** the endpoint is `/api/customer-photos`, not `/customer-photos`,
  precisely so the Cloudflare proxy doesn't intercept a would-be `/parcel-info`-style page
  navigation. Keep the `/api/` prefix for any new endpoint here.
- **Baserow numbers/strings:** rollup/number fields can come back as strings — normalize
  with `Number(v) || 0` (not relevant to counts here, but the house rule).
- **Full-bleed CSS:** this tab needs `#tab13.tab-content { padding: 0 }` and
  `.gr-root { overflow: visible }` on mobile, or the sticky toolbar breaks.
- **Memory on capture:** photo capture is deliberately **one-at-a-time** with reduced-res
  decode (`shared/imageResize.js` + `PhotoCapture.jsx`) to avoid OOM-crashing mobile Safari.
  Don't parallelize it.
- **Don't add a PC create path** — add is intentionally mobile-scan-only and double-gated
  (coarse-pointer on the client, role check on the server).
