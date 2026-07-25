# Parcel Photos (read side) — feature handoff

> Complete walkthrough of the **two `/parcelPhotos/*` routes** added to this repo
> (`auto-send-manual`, `app.js`). These are the **read/consumer side** of the
> Parcel Info feature: the photos are *created* by a different project (the
> qianyi-api-query dashboard's "Parcel Info" tab — see
> [parcel-info-handoff.md](parcel-info-handoff.md) for that write side). This repo
> only **reads** them out of Baserow for a **Facebook Messenger extension** that
> lists a customer's EC2 orders.
>
> Read [parcel-info-handoff.md](parcel-info-handoff.md) first for the data model;
> this doc assumes it.

---

## 1. Why this exists — the use case

The Messenger extension shows a customer's **recent EC2 orders** as a list
(`F955820260711002725  RM 169.50`, etc.). For each order we want to show a small
**photo icon** *only if* that order has parcel photos attached — and load the
actual images **only when the icon is clicked**. No wasted bandwidth: the list
view must not download any image bytes.

That splits cleanly into **two endpoints**, and this is the whole design:

| # | Endpoint | When | Cost |
|---|---|---|---|
| **1** | `GET /parcelPhotos/check?ids=…` | once, for the **whole visible list** | tiny — booleans only, no image bytes |
| **2** | `GET /parcelPhotos/order/:orderId` | **per icon click**, one order | heavier — full image URLs |

**Extension flow:**
1. Render the order list → collect the visible EC2 order ids.
2. One call to **`/parcelPhotos/check`** → for each id, `hasPhotos`.
3. Show the icon on rows where `hasPhotos === true`.
4. On icon click → **`/parcelPhotos/order/:id`** → open that order's photos.

---

## 2. Data model recap (Baserow)

Two Baserow tables on `https://baserow.dd-herbs.com`, written by the qianyi
dashboard, read here. **We never write them.**

**Table 779 — `Customer_Photos`** (one row per **WMS order**):
`Name`, `WMS_ID`, `ERP_ID`, **`EC2_Order_ID`** (our search key), `Task_ID`,
`Tracking_Number`, `Customer_Name`, `Last_Photo_At`, `Created_By`, `Created_At`,
and a reverse-link field **`Customer_Photo_Items`** (array of the linked item
rows — Baserow auto-creates it; **we rely on it**, see §5).

**Table 780 — `Customer_Photo_Items`** (one row per **photo**):
`Name` (S3 key), **`Entry`** (link → 779), **`Photo_URL`** (permanent public S3
URL), **`Kind`** (single-select object `{ value: 'internal' | 'customer', … }`),
`Uploaded_By`, `Created_At`.

**The key many-to-one fact:** one **EC2 order id** can map to **1 or many WMS
orders** (≈30% of buyers split across parcels), so `EC2_Order_ID` is **not**
unique in table 779 — a search returns an **array** of header rows. Each header
then has its own photos in table 780, each tagged `internal` or `customer`.

- `internal` = packing evidence (scanned from **Task ID**).
- `customer` = the finished parcel the customer sees (scanned from **tracking #**).

---

## 3. Where the code lives

All in [app.js](app.js), appended after the `/luckyDraw/order` block, before
`/orders/:id`:

| Symbol | Line (approx) | Purpose |
|---|---|---|
| `CUSTOMER_PHOTOS_URL` (table 779) | [app.js:632](app.js#L632) | header table base URL |
| `CUSTOMER_PHOTO_ITEMS_URL` (table 780) | [app.js:633](app.js#L633) | items table base URL |
| `baserowFetchAll(url, params)` | [app.js:636](app.js#L636) | fetch **all pages** of a Baserow list (200/page cap) |
| `mapParcelPhoto(item)` | [app.js:654](app.js#L654) | shape a table-780 row → frontend photo object |
| `GET /parcelPhotos/order/:orderId` | [app.js:666](app.js#L666) | **API 2** — full detail |
| `parcelPhotoCounts(ids)` | [app.js:719](app.js#L719) | one Baserow OR-query per 50-id chunk → counts |
| `GET /parcelPhotos/check` | [app.js:751](app.js#L751) | **API 1** — batch existence probe |

Documented in [CLAUDE.md](CLAUDE.md) under *Routes in `app.js`*.

---

## 4. API 2 — `GET /parcelPhotos/order/:orderId` (detail, on click)

Fetches **all** parcel photos for one EC2 order id, grouped **per WMS id**.

**Logic:**
1. Filter table 779 by `filter__EC2_Order_ID__equal=<orderId>` (all pages) → header rows.
2. For **each** header, in parallel, filter table 780 by
   `filter__Entry__link_row_has=<headerRowId>` → its photo items.
3. Map each item via `mapParcelPhoto`; split into `internal[]` / `customer[]`; also
   keep a per-WMS combined `images[]`.

**Response (found):**
```json
{
  "found": true,
  "ec2OrderId": "F955820260722007192",
  "orderCount": 1,
  "imageCount": 2,
  "orders": [
    {
      "headerId": 108,
      "wmsId": "S11231856675",
      "erpId": "S260723140971-832",
      "ec2OrderId": "F955820260722007192",
      "taskId": "TASK26072300063",
      "trackingNumber": "DDLMM1529666124558888960",
      "customerName": "Cheok Hun Chuan/…/7402417813108419",
      "lastPhotoAt": "2026-07-23T02:21:59.085000Z",
      "createdBy": "9986 kuan",
      "createdAt": "2026-07-23T02:20:34.131186Z",
      "imageCount": 2,
      "internal": [ { "id", "name", "url", "kind", "uploadedBy", "createdAt" } ],
      "customer": [ { … } ],
      "images":   [ … internal + customer for THIS WMS only … ]
    }
  ]
}
```
Each image object: `{ id, name (S3 key), url (public S3 URL), kind ('internal'|'customer'|null), uploadedBy, createdAt }`.

**Design decisions (don't "fix" these):**
- **Grouped per WMS id, never flattened.** There is deliberately **no** top-level
  array combining images across WMS orders — an earlier version had one and it was
  removed on request. Top-level `imageCount` is just the sum.
- A photo whose `Kind` is unset lands in neither bucket but **still** appears in the
  per-WMS `images[]` with `kind: null` — nothing is silently dropped.

**Three response states — branch on HTTP status first:**
| State | Trigger | Shape |
|---|---|---|
| **found** | ≥1 header row | HTTP 200, `found: true`, orders populated |
| **not found** | empty/whitespace id, or no header rows | HTTP 200, `found: false`, `orders: []`, zero counts |
| **failure** | Baserow down / bad token | HTTP **500** `{ ok: false, error }` — no `found` field |

A header with **zero** photos still counts as **found** (`imageCount: 0`, empty
buckets). In practice this can't happen (see §5).

---

## 5. API 1 — `GET /parcelPhotos/check?ids=a,b,c` (batch probe, for the list)

Answers "**which of these order ids have any photo?**" for a whole list, as
cheaply as possible.

**Input:** `?ids=` comma-separated EC2 order ids. Trimmed, blanks dropped,
**deduped**. (GET only — it's read-only; POST was intentionally removed as
redundant.)

**Response — keyed by id** (easy lookup in the extension):
```json
{
  "count": 3,
  "results": {
    "F955820260720007336": { "hasPhotos": true,  "imageCount": 1 },
    "F955820260722007192": { "hasPhotos": true,  "imageCount": 2 },
    "F955820260711002725": { "hasPhotos": false, "imageCount": 0 }
  }
}
```
Every requested id is present. Unknown / photo-less ids → `hasPhotos: false`.

**Why it's cheap — the two tricks:**
1. **One Baserow query per 50-id chunk**, not one per id. Built in
   `parcelPhotoCounts` with `URLSearchParams` (axios `params` can't hold duplicate
   keys): `filter_type=OR` + one `filter__EC2_Order_ID__equal=<id>` **per id**.
   Chunked at 50 to keep the query string well under URL limits; paginated at
   200/page.
2. **Reads only table 779**, and only two fields, via
   `include=EC2_Order_ID,Customer_Photo_Items`. The reverse-link
   `Customer_Photo_Items` gives the **photo count per header for free** —
   `imageCount` = sum of those array lengths across the id's headers. **Table 780
   is never touched, no `Photo_URL` / S3 bytes are read.**

**`hasPhotos` correctness assumption (important):** we treat "a table-779 header
with ≥1 linked item exists" as "has photos". This holds because the **write side
couples them**: the upsert creates the header *and* uploads photos in the same
request, and delete **cascades** (items + header together). So there are no orphan
headers with zero items. If the write side ever changes to leave empty headers,
`hasPhotos` could report true with `imageCount: 0` — the `imageCount` field guards
against that (check `imageCount > 0` if you want to be strict).

**Edge cases:**
| Input | Result |
|---|---|
| `?ids=` empty / all blank | `{ count: 0, results: {} }` (HTTP 200) |
| duplicates / whitespace | trimmed + deduped before querying |
| > 500 ids | HTTP **400** `{ ok: false, error }` |
| Baserow down / bad token | HTTP **500** `{ ok: false, error }` |

---

## 6. Config / env

No new env vars. Reuses the existing:
- `BASEROW_TOKEN` (env) — Baserow auth, same token as `/luckyDraw/*`.
- Table ids **779** / **780** are hardcoded in `app.js` (`CUSTOMER_PHOTOS_URL` /
  `CUSTOMER_PHOTO_ITEMS_URL`). If Baserow table ids change, edit those two consts.

The S3 photo URLs (`ddlive-qrcode` bucket, `goods/customer-photos/` prefix) are
**public-read**, so `url` in the response is directly usable in an `<img src>` —
no signing, no proxy needed.

---

## 7. Deploy & test

- **Deploy:** `npm run deploy` (= `claudia update`) → AWS Lambda
  `auto-send-manual-executor`, region `ap-southeast-1`, API Gateway `yxch9n4n6e`.
  ⚠️ its output echoes `BASEROW_TOKEN` / `OPENAI_API_KEY` in plaintext.
- **Live base URL:** `https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest`
- **Local:** `node app.js` (port 8000).

Smoke tests (swap host for local vs live):
```bash
BASE=https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest

# API 1 — batch probe (whole list, one call)
curl -s "$BASE/parcelPhotos/check?ids=F955820260720007336,F955820260722007192,F955820260711002725"
#   → { count:3, results:{ …336:{hasPhotos:true,imageCount:1}, …725:{hasPhotos:false,imageCount:0} } }

# API 2 — detail (on click)
curl -s "$BASE/parcelPhotos/order/F955820260722007192"
#   → found:true, 1 WMS order, internal:1 + customer:1
```

To find live test ids: pull table 779 rows and read `EC2_Order_ID` /
`Customer_Photo_Items`:
```bash
curl -s "https://baserow.dd-herbs.com/api/database/rows/table/779/?user_field_names=true&size=200" \
  -H "Authorization: Token $BASEROW_TOKEN"
```

---

## 8. Gotchas for the next instance

- **`EC2_Order_ID` is not unique** in table 779 — always handle the multi-WMS
  (array) case. Current live data happens to be all 1:1, so a real multi-WMS
  example may not exist yet to eyeball; the array shape covers it regardless.
- **Don't add a write path here.** This repo is read-only for these tables; photos
  are created by the qianyi "Parcel Info" tab. Uploading/deleting is out of scope.
- **Duplicate query-param keys** need `URLSearchParams` (not an axios `params`
  object) — that's why `parcelPhotoCounts` builds params manually. Don't refactor
  it back to a plain object; the OR-filter would collapse to a single id.
- **Keep API 1 free of table 780.** The whole point is bandwidth. If you ever need
  per-kind counts (internal vs customer) in the list probe, get them from a lighter
  source before reaching for table 780 / S3.
- **`Kind` is an object, not a string** — read `item.Kind && item.Kind.value`.
  `mapParcelPhoto` already normalizes to `'internal' | 'customer' | null`.
- **Baserow pages at 200 rows** — `baserowFetchAll` and `parcelPhotoCounts` both
  paginate; keep that if you change either.
- **`single_select_equal` filter takes an option id, not the text** — that's why
  the split is done in JS on `Kind.value`, not via a Baserow filter. Don't switch
  it to a server-side Kind filter without using the option id.
- **500 vs "no photos" are different** — a chatbot/extension must branch on HTTP
  status. A strict `hasPhotos === false` on a 500 body would wrongly tell a user
  "no photos" during an outage.
