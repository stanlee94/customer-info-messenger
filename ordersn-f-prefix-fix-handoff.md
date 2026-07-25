# ⚠️ BREAKING: `orderSn` now includes the `F` prefix — remove your manual `"F" + ...`

**Status:** ✅ Deployed to production (`yxch9n4n6e`, ap-southeast-1) on 2026-07-25.
**Action required (frontend):** Delete every place that prepends `"F"` to `orderSn`. Display the API value **verbatim**.

---

## TL;DR

The API used to return a **truncated** order SN. The frontend patched around it by
sticking `"F"` on the front. The API is now **fixed** and returns the complete,
correct SN — including the `F` **and** a leading `0` that the frontend workaround
never accounted for. So the workaround is now both **redundant and wrong**.

| Order ID | API `orderSn` **before** (truncated) | Frontend showed (`"F"+sn`) | API `orderSn` **now** (correct) |
|---|---|---|---|
| `11867319` | `955820260113003753` | `F955820260113003753` ❌ | `F0955820260113003753` ✅ |
| `11762369` | `955820251219013928` | `F955820251219013928` ❌ | `F0955820251219013928` ✅ |
| `11654442` | `955820251128000997` | `F955820251128000997` ✅ | `F955820251128000997` ✅ |

> Note the workaround wasn't just redundant — for the first two orders it produced the
> **wrong** number (`F9558…`), because it dropped the `0`. The real SN is `F0955…`.
> Only orders that happen to have **no** leading `0` came out right by luck.

---

## What you must change

**Remove all manual `F` prefixing. Use `order.orderSn` directly.**

```diff
- const displaySn = "F" + order.orderSn;   // ❌ delete this everywhere
+ const displaySn = order.orderSn;         // ✅ API already returns the full SN
```

Search your codebase for anything like:
- `"F" + orderSn`, `` `F${orderSn}` ``, `"F".concat(...)`, `prefix = "F"`
- any template that renders `F{{orderSn}}` in markup

…and strip the `F`. The value from the API is already display-ready.

---

## Field reference (unchanged shape, corrected value)

`GET /api/orders?fbUserId=<id>&newStatus=0` returns `{ ok, orders: [...] }`.
Each row:

| Field | Example | Use for |
|---|---|---|
| `orderId` | `11867319` | **All API calls / lookups** — this is the internal id the portal routes take (`/api/orders/:orderId`, operations, etc.) |
| `orderSn` | `F0955820260113003753` | **Display only** — the customer-facing 订单编号, now complete with `F` prefix. Do **not** build API URLs from this. |

> **Retrieve by Order ID only.** For any fetch/detail/operation call, use `orderId`
> (`11867319`), never `orderSn`. The `orderSn` is a display string; its format
> (`F`, optional `0`, shop id `9558`, tail) is not a stable key for lookups.

---

## Why the prefix isn't a fixed `"F0"`

The SN is `F` + an **optional** leading `0` + shop id `9558` + tail. Two of the three
sample orders are `F0955…`; one is `F955…` (no zero). That's exactly why you can't
reconstruct it on the client — you'd have to know whether each order has the `0`.
Just render what the API sends.

---

## Backend searches by `orderId`, never by `orderSn`

Every backend order operation (detail, confirm, pay, ship, discount, consignee edit)
sends the **numeric `orderId`** (`order_id`) to EC2. `orderSn` is **not** a search key
anywhere in the operate/detail path.

The one place `orderSn` is compared is `findOrderIdBySn(orderSn)` — a reverse lookup
that scans the order list for an **exact string match** and returns the `orderId`:

```js
.find(o => o.orderSn === orderSn)   // exact equality
```

Because the parser now returns the **complete** SN, that match key is now the full
`F…` value — and the prefix is **per-order, not fixed**:

- `F0955820260113003753` — has the leading `0`
- `F955820251128000997`  — **no** leading `0`

So if you ever call `findOrderIdBySn`, you must pass the SN **verbatim as the API
returned it** (sometimes `F0…`, sometimes `F…`). Do **not** hardcode `"F0" + digits` or
`"F" + digits` — a constructed prefix will fail to match the orders whose real prefix
differs. Anything still passing the **old** truncated `9558…` (or the frontend's old
`F9558…`) will no longer resolve. **Preferred: skip `findOrderIdBySn` entirely and use
the `orderId` you already have next to the SN.**

---

## Backend change (for reference)

Both SN parsers were anchored on `9558`, assuming the SN started there. It doesn't —
`F` and the leading `0` are part of the real number and were being discarded.
Fixed in `portal.js`:

- `parseOrderList` — `/(9558\d{12,16})/` → `/(F\d*9558\d{12,16})/`
- `parseOrderDetail` — same fix on the primary pattern; label fallback now allows a leading `F`

No response-shape change — same fields, same envelope. Only the **value** of `orderSn`
is now correct.
