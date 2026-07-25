# HANDOFF — Frontend build spec for the EC2 remote-control panel

Audience: whoever builds the UI (or the next Claude session). This file maps each
product goal to the exact API calls, in order, with all edge cases. **It is the
complete, self-contained API contract — you need nothing else to build the frontend.**

## Base URL — the API is LIVE ✅

The backend is already deployed and running. Point the frontend at:

```
https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest
```

Make it a single config constant, e.g. `const API_BASE = "https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest"`.
**Every path in this doc already starts with `/api/…`, so the full URL is just
`API_BASE + path`.** Examples:

| Doc says | Full URL you call |
|---|---|
| `GET /api/cart?fbUserId=123` | `${API_BASE}/api/cart?fbUserId=123` |
| `POST /api/orders` | `${API_BASE}/api/orders` |
| `GET /api/orders/:orderId` | `${API_BASE}/api/orders/955820260724002120` |

Minimal fetch helper (the ENTIRE transport layer — no auth, no cookies, no headers to manage):

```js
const API_BASE = "https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest";

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.msg || "Request failed"); // show json.msg verbatim in a toast
  return json;                                                 // {ok:true, ...}
}
// GET  → api(`/api/cart?fbUserId=${id}`)
// POST → api(`/api/orders`, { method: "POST", body: {...} })
```

CORS is already enabled on the backend (including `OPTIONS` preflight and
`Content-Type: application/json`), so plain browser `fetch` from any origin works.

Non-negotiables that apply to every screen:

- Every response is `{ok:true, ...}` or `{ok:false, msg}`. **Always branch on `ok`,
  show `msg` verbatim on failure.** The portal (EC2) session cookie is handled ENTIRELY
  by the backend — it is auto-refreshed on the server from the shared Baserow store, so
  the frontend never sees, stores, or refreshes it, and must NOT build a cookie bar.
  If `msg` = "Please login first" (rare — only when the EC2 session itself has died),
  just show the error; fixing it is a backend-ops task, not a frontend concern.
- The only ID the operator ever types is **`fbUserId`** (the customer's Facebook id).
  Everything else (`userId`, `ecUserId`, `recId`, `goodsId`, `orderId`) comes from
  API responses and must be carried along, never typed, never mixed up.
- After **every** write, re-fetch the affected resource (cart or order detail) —
  never update local state optimistically. The portal is the only source of truth.

---

## Goal 1 — Open a cart by customer id: view / add / remove / change qty / renew expiry

### View
```
GET /api/cart?fbUserId=<typed by operator>
→ {ok, fbUserId, userId, ecUserId, items:[{recId, goodsId, name, qty, price, origin, expired}]}
```
- **Store `userId` and `ecUserId` in page state** — needed by checkout and order create.
- `items:[]` for both an empty cart and an unknown fbUserId (not an error).
- `expired:true` → render the row with a warning badge + offer "renew expiry".
- `origin` is `"system"` or `"live"` — display only.

### Add product → see Goal 2 (goods picker).

### Remove product(s)
```
POST /api/cart/delete        {recIds:["73880790", ...]}   // batch — works for 1 or many
→ re-fetch GET /api/cart
```

### Renew expiry (更新有效期)
```
POST /api/cart/refresh-validity   {recIds:[...]}          // batch; NO date param —
→ re-fetch GET /api/cart                                  // the server sets the new expiry
```

### Change quantity
```
POST /api/cart/quantity      {recId, qty}          // ONE line per call, qty >= 1
→ re-fetch GET /api/cart
```
This is a faithful replica of the portal's own edit request (captured in
`captures/cart-qty-edit.har`): the backend replays the portal's exact sequence —
`ajax_getNewCartPrice` (price/rule re-check) then `saveCartNumber` (the save; the
portal names the rec id `cartId` on that route). **Never** delete+re-add to change
a qty. For multi-row edits, call once per changed row, then re-fetch the cart once.

(Independent of cart editing: `POST /api/orders` takes its own `items[].qty`, so the
qty *ordered* can still differ from the cart if the operator adjusts it on the
checkout form.)

---

## Goal 2 — Add-product flow: goods list with search, photos, qty

```
GET /api/goods?keyword=<search text>&page=1
→ {ok, result:{total, pages, items:[{goodsId, name, price, stock, warehouseCode, onSale}], noResult, keyword}}
```
- Empty keyword = full list. 100 rows/page; render pager from `pages`.
- No match → `result.noResult === true` and **no `items` key** — guard for it.
- On select: show a qty stepper, then
  ```
  POST /api/cart/items   {fbUserId, goodsId, qty}
  → re-fetch GET /api/cart
  ```
  Duplicate adds are accepted silently and merge qty — the re-fetch shows the truth.

### Photos — ✅ available
Every goods row includes `img` — a full CDN URL
(`https://img.full2house.com/ec2/ec2_9558/…jpeg`) or `null` when the product has no
photo. Render `<img src={img}>` with a placeholder for null. Images load straight
from `img.full2house.com` in the browser — no proxying needed (plain public GETs,
no cookie required).

---

## Goal 3 — Multi-select / select-all in cart → delete / renew / create order

Pure frontend state — checkboxes per row + a select-all header box. All three batch
actions already accept arrays:

| Action on selection | Call |
|---|---|
| Delete selected | `POST /api/cart/delete {recIds:[...selected]}` |
| Renew expiry selected | `POST /api/cart/refresh-validity {recIds:[...selected]}` |
| Create order from selected | open checkout (Goal 4) with the selected rows as `items:[{recId, qty, price}]` |

- Disable the action buttons when nothing is selected (empty `recIds` = portal error).
- If any selected row has `expired:true`, renew expiry first (or warn) before ordering.

---

## Goal 4 — Create order: prefilled customer, shipping choice, discount, SN, confirm vs confirm+paid

### Step 1 — load the prefilled checkout form
```
GET /api/checkout?fbUserId=&userId=&recIds=a,b&goodsNumbers=1,2
→ {ok, customer}
```
(`userId` = the one returned by `GET /api/cart`. `goodsNumbers` = the qtys, same order
as `recIds`.)

`customer` prefills everything for a returning buyer:

| Field | Use in form |
|---|---|
| `consignee`, `mobile`, `address`, `email` | text inputs (email optional, rest **required**) |
| `shippingOptions:[{id, code, label, fee, checked}]` | the **4 shipping radios** — render `label` (includes the RM fee), pre-check the `checked` one |
| `stateOptions` / `areaOptions` | State→Area dropdowns; on state change call `GET /api/regions/areas?stateId=` to repopulate areas and set postcode to `areas[0].code`; on area change `GET /api/regions/postcode?areaId=` |
| `regionCity`, `regionArea`, `regionCode` | current selection ids + postcode |
| `paymentId` | keep in state, pass through unchanged |

**Client-side validation before submit** (portal rejects with the unhelpful
`参数不能为空^_^[收件人资料]` otherwise): `consignee`, `mobile`, `address`,
`regionCity`, `regionArea`, `paymentId` all non-empty.

The form also has an optional **discount / add-amount** input (see step 3).

### The canonical sequence (matches the manual habit in the portal)

> **create → (discount / add amount) → confirm → paid** — the adjustment goes on the
> order **while it is still 待确认**, and the paid amount is locked at the moment of
> the pay click, so pay always comes last.

### Step 2 — create the order (create ONLY — no confirm yet)
```
POST /api/orders
{ fbUserId, userId, items:[{recId, qty, price}], customer,
  shippingIdType:<chosen radio id>, confirm:false, pay:false }
→ {ok, orderId, orderSn, status:"待确认", paid:false, via}
```
`confirm:false` = create only: the backend does create → race-safe numeric-id
resolution → verify, then **stops**. The order sits at 待确认 exactly as if the
operator had clicked 生成订单 in the portal. **It is a real write.**

Show the success panel immediately:
- **Order SN display:** API returns digits `955820260724002120`; the portal shows it
  as **`F955820260724002120`** (captured verbatim from a HAR). So render
  **`"F" + orderSn`** — that's the number the customer receives on Messenger.
  (The spec request said "F09958/F9958" — the real captured prefix is `F9558`:
  `F` + shop id `9558` + date + sequence.)
- **`via` badge (must surface):** `exact` = 🔒 safe; `multi-newest` = ⚠ two
  simultaneous orders for this customer, newest taken; `fallback` = ⚠ id may be
  wrong — tell the operator to verify in the Orders view before trusting it.
- Keep the returned **`orderId`** in state — steps 3–4 need it.

### Step 3 — discount / add amount (optional, BEFORE confirm)
```
POST /api/orders/:orderId/adjustments   {price, type, note?}
```
`type: 1` = discount (subtracts), `type: 2` = additional payment (adds).
Then `GET /api/orders/:orderId` to show the new `payable` on the panel.

### Step 4 — the two buttons
Both buttons drive `/operations` on the already-created order:

| Button | Calls, in order |
|---|---|
| **确认 Confirm** | `POST /api/orders/:orderId/operations {operation:"confirm"}` |
| **确认+已付 Confirm & Paid** | `…{operation:"confirm"}` → `…{operation:"pay"}` |

**Why this ordering is mandatory:** the paid amount is locked when `pay` fires. If
pay ran before the adjustment, the order would be settled at the pre-discount total.
Create-only first also means the SN is on screen (and sendable to the customer)
before any status decision is made.

After each operation, re-fetch `GET /api/orders/:orderId` — the panel's buttons must
follow the real EC2 status (`confirm` slot `待…` → Confirm visible; confirmed +
`payment` `未…` → Pay visible; see Goal 6).

*(Shortcut for automation: `pay:true` on the create call still does
create+confirm+pay in one shot — only safe when there is no adjustment. `pay:true`
implies confirm regardless of the `confirm` flag.)*

---

## Goal 5 — List a customer's orders: 全部 tab, excluding cancelled

One call — `新状态` tab 0 is 全部, `noCancel=on` strips 已取消:
```
GET /api/orders?fbUserId=<id>&newStatus=0&noCancel=on
→ {ok, orders:[{orderId, orderSn, mobile, amount, consignee, statusText, statusParts}]}
```
- Rows come **newest-first** with each row's real 3-part status already included
  (taken from the list's own 状态 column) — do NOT fetch detail per row to show status.
- Render `"F" + orderSn`, consignee, amount, and `statusText`.
- Row click → Goal 6 detail view, passing the row's **numeric `orderId`** (never the SN).
- Other tabs if ever needed: 1=未处理(default), 2=未付款, 5=已付款未出货, 6=已付款,
  8=已付款已出货.

---

## Goal 6 — Order detail: one internal request, HTML → JSON

Clicking an order loads exactly one portal page (`EntMall/orderDetail`) server-side;
the backend parses the **entire** page into JSON:
```
GET /api/orders/:orderId
→ {ok, orderId, orderSn, statusText, statusParts:{confirm, payment, shipping},
   subtotal, shipping, payable,
   buyer:{name, fbUserId}, orderTime, paymentMethod, payTime, shippingMethod, shipTime,
   recipient:{consignee, mobile, address, email},
   customerGroup, note, csNote,
   items:[{recId, img, name, shipState, desc, note, origin, price, qty, stock, lineTotal}],
   itemsCount, itemsTotal,
   discount:{amount, note}|null, addAmount:{amount, note}|null}
```
Field notes (all values verbatim from EC2):
- `items[]` — one row per 商品信息 line: `img` is a full CDN URL (may be null),
  `shipState` is the per-line (已出货/未出货), `note` is the live order code
  (e.g. `K2+1`, `P4+4`, `后台加单`), `origin` is the live session name or `--`,
  `price`/`lineTotal` are plain decimals. `itemsCount` is the total *quantity*
  (e.g. 16 rows can be 33 pieces), `itemsTotal` the 合计.
- `payTime`/`shipTime` — a datetime once paid/shipped, otherwise the literal
  `未付款`/`未出货`.
- `discount`/`addAmount` — the 其他折扣金额 / 其他金额 fee rows with their note;
  `null` when absent. ⚠ EC2 shows the note only next to the LATEST adjustment, so an
  earlier discount's note can become null after an add-amount — render what arrives.
- `payable` = `itemsTotal` + `shipping` − `discount` + `addAmount`.
- Bad/unknown id → HTTP 422 `{ok:false, msg}` — show msg, don't crash.
- **Status values are verbatim from EC2** (`待确认/处理中/已确认…`, `未付款/已付款…`,
  `未出货/已出货…`). Never hardcode the set — render whatever arrives. Real captures
  include `处理中` in the confirm slot after payment.
- **Action buttons derive ONLY from `statusParts` string prefixes**
  (`待`/`未` = action still available, `已` = done):
  - **Confirm** while `confirm` starts with `待` → `POST …/operations {operation:"confirm"}`
  - **Pay** when confirmed and `payment` starts with `未` → `{operation:"pay"}`
  - **Ship** when paid and `shipping` starts with `未` → `{operation:"shiped"}`
  - **Cancel** / **Refund** (`{operation:"cancel"|"payreturned"}`) guarded by
    取消/退款 appearing in the respective slot.
- **Set discount / Add amount** — always available while the order is 待确认, 已确认 or
  已付款 (verified: EC2 renders the same discount dialog even on a paid+shipped order):
  `POST /api/orders/:orderId/adjustments {price, type, note?}` (`type 1` = discount −,
  `type 2` = add amount +), then re-fetch to show the new `payable` and the
  `discount`/`addAmount` fee rows. The Goal-4 "adjust before pay" rule is about locking
  the right paid amount at creation — it does NOT mean adjustments are closed after
  payment; post-payment corrections (e.g. note `mistake`) are a normal EC2 flow.
- **After every operation, re-fetch the detail** so buttons follow the new EC2 state.

### Edit recipient info (收件人资料 编辑)
The detail view's Edit button opens a dialog backed by two endpoints (replica of the
portal's `orderConsigneeEdit` / `ajaxOrderConsigneeEdit`, from `captures/order-edit.har`):

```
GET /api/orders/:orderId/consignee
→ {ok, form:{consignee, mobile, email, address, serviceNote, note,
             regionCountry, regionCity, regionArea, regionCode,
             countries:[{id,name}]}}
```
Prefill the dialog from `form`. Region selects: `countries` comes with the form
(Malaysia = `801`); for State→Area reuse the SAME endpoints as checkout —
`GET /api/regions/areas?stateId=` on state change, `GET /api/regions/postcode?areaId=`
on area change (verified: same region-id space as this form). The postcode field stays
manually editable (the captured order used `25300` where the area default is `25000`).

```
POST /api/orders/:orderId/consignee
{consignee, mobile, address, regionCity, regionArea, regionCode,   // required (400 if empty)
 regionCountry?, email?, note?, serviceNote?}                       // optional
→ {ok}
```
Then **re-fetch `GET /api/orders/:orderId`** to show the updated recipient block.
Notes: `note` = the order's 备注, `serviceNote` = 客服备注 — both editable in the same
dialog. 图片备注 (photo upload) is deliberately NOT supported — the backend always
sends `note_image` empty, per the capture-scoped design.

---

## Backend gaps summary

**None open.** All closed: `goods_img` in `/api/goods` rows (Goal 2 photos),
`confirm:false` create-only mode (Goal 4 sequence), cart qty edit
(`POST /api/cart/quantity`, replica of the portal's `saveCartNumber`), the full
order-detail parse (Goal 6 — items, recipient, buyer, times, fee adjustments), and
recipient edit (`GET/POST /api/orders/:id/consignee`).

---

## Deployment split — backend Lambda vs frontend

> **Backend status: ✅ DONE — already deployed.** The two engine files are integrated
> into the `auto-send-manual` Lambda (API Gateway `yxch9n4n6e`, region `ap-southeast-1`)
> and mounted at `/api`, live at the Base URL above. The cookie is wired to that
> project's existing auto-refreshed Baserow cookie (no `PORTAL_COOKIE` env var needed —
> see note in the checklist). **The section below is historical/backend-ops reference
> only — the frontend does NOT need to do any of it.**

The work is split across two other instances. **What each instance receives:**

### → Backend instance (existing Lambda project, Express server already running) — ✅ done

**Copy exactly TWO files, side by side, into the Lambda project:**

| Copy this file | To (example) | Why |
|---|---|---|
| `lib/portal.js` | `lib/portal.js` | The whole engine — every EC2 route, parser, and the race-safe order resolver. Zero dependencies, Node 18+. |
| `lib/express-router.js` | `lib/express-router.js` | Ready-made Express router exposing ALL `/api/*` endpoints. Requires `./portal` relatively — keep the two files in the same folder. |

Then in the Express app, ONE line:
```js
app.use('/api', require('./lib/express-router'));
```

Backend configuration checklist (all in the router file's header too):
1. **Cookie — already wired, no env var in this deployment.** In the `auto-send-manual`
   Lambda the router is fed the project's existing auto-refreshed EC2 cookie via
   `portalRouter.setCookieProvider(() => cookiesNewPage)` (the cookie is pulled from the
   shared Baserow store and refreshed ~every 2h / per cold start). So there is **no
   `PORTAL_COOKIE` secret to manage here** — when the EC2 session dies, it is refreshed
   at the Baserow source, which fixes both the legacy routes and `/api` at once. (The
   `PORTAL_COOKIE` env var and `POST /api/session` runtime-swap remain as fallbacks if
   no provider is injected — unused in this deployment.)
2. **Lambda timeout ≥ 30s** — `POST /api/orders` chains 5–7 sequential portal calls
   with retry delays; the 3s default will cut it off mid-write.
3. **CORS** — the frontend is served from a different origin, so the Express app must
   allow it (`cors()` middleware or equivalent) including `OPTIONS` preflights and
   `Content-Type: application/json`.
4. **Region** — deploy close to `ec2.full2house.com` (Malaysia):
   `ap-southeast-1` (Singapore) or `ap-southeast-5` (Malaysia).
5. **Never log `PORTAL_COOKIE`** to CloudWatch.
6. Concurrency is safe as-is: order-id resolution is fb-scoped per customer and needs
   no shared state between Lambda instances.

Do NOT copy `server.js` (local-dev only: raw Node http + cookie file persistence),
`test/`, or `captures/` (contain live session data — never leave this machine).

### → Frontend instance

**Give it exactly ONE file: this `HANDOFF.md`.** It is the complete API contract:
every endpoint, request/response shape, required-field validation, button-state
rules, and edge cases — written so the frontend needs no knowledge of the EC2 portal.

Frontend ground rules (repeated here so the file is self-contained):
- API base URL = the Lambda's URL (make it a config value). All calls are plain
  JSON `fetch` — no cookies, no auth headers, nothing to manage. **Skip the cookie
  bar and both `/api/session` endpoints entirely — they are backend-ops tools.**
- Branch on `ok`; on `ok:false` show `msg` verbatim in a toast/banner. That is the
  entire error-handling contract (including an expired backend cookie).
- After every write, re-fetch the affected resource. Never trust local state.
- The only id the operator types is `fbUserId`. Carry `userId`/`ecUserId`/`recId`/
  `goodsId`/`orderId` from API responses only, and never mix them up.
- Render order SNs as `"F" + orderSn`.
