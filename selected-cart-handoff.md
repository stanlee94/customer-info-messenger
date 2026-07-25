# `POST /users/:id/selected` — hand-picked cart summary

Send-ready bilingual cart message (identical formatting to `GET /users/:id`) for a
**subset** of a customer's cart, chosen by product id. Built additive: the original
`GET /users/:id` and `fetchCartData` are untouched — this route is a self-contained
block in `app.js` right after `/users/:id`.

## Why a new route (not a changed `/users/:id`)
`GET /users/:id` is live in many places, so it was left alone. The new route re-fetches
the **same** cart HTML (`a=EntLive&m=liveUserCartLists&fb_user_id=<psid>`) and reuses
`portal.js`'s exported `parseCart` — the only parser that exposes `goodsId` — then
rebuilds the same message over just the picked lines.

## Robust flow (recommended): two-step, select by recId
The operator is looking at ONE customer's cart and ticks a few lines:
```
1. GET  /api/cart?fbUserId=<psid>   → lines, each with recId + goodsId + name + qty + price
   (operator ticks a few)
2. POST /users/<psid>/selected      → same manual-listing message, option 1/2/3
   { "recIds": ["<ticked recId>", ...], "option": 1 }
```
`recId` is robust because you already have it from the cart you're displaying, and it
names one **exact** line — unambiguous even when the same product is on two lines.

## recId vs goodsId (the two selectors)
Each cart line carries both:
- **`recId`** — the **cart-line** id. Per-cart, learned by reading the cart (step 1).
  Names one exact line. **Preferred selector.** Also what the portal's mutating ops
  (delete / quantity / ship) act on.
- **`goodsId`** — the **product** (catalogue) id. Global: same value in every cart.
  Known ahead of time → pick without reading the cart, but keeps **ALL** lines of that
  product (if one product sits on two lines/styles, both are kept). **Fallback.**

## Request
```
POST /users/<fbUserId>/selected
Content-Type: application/json

{ "recIds": ["8891", "8894"], "option": 1 }        // preferred
{ "goodsIds": ["10002", "10005"], "option": 1 }    // fallback (by product)
```
- `recIds` **or** `goodsIds` **(one required)** — whitelist of ids to keep. Each accepts
  an array or a comma/space-separated string (`"8891 8894"`). Trimmed + deduped. If
  **both** are given, `recIds` wins. Neither present / empty after cleanup →
  `400 { ok:false, msg }`. The chosen selector is echoed as `selectBy` in every response.
- `option` — `1|2|3`, same currency/postage/bank block as `/users/:id`. Default `1`.
  `1` = RM+SGD +RM10 WM postage, both banks; `2` = RM only +RM10, MY bank; `3` = SGD
  only, no postage, SG bank.
- **qty is kept as-is** from the cart — no per-line override.

## Response (mirrors `/users/:id`, plus matched/missing)
```json
{
  "version": "v2",
  "selectBy": "recId",
  "expiredAvailable": false,
  "matched": ["8891"],
  "missing": ["8894"],
  "myrSum": "176.00",
  "sgdSum": "88.00",
  "content": { "messages": [{ "type": "text", "text": "【多多直播人手结单…】…" }] }
}
```
- `matched` / `missing` — requested ids that **did** / **didn't** land in the message.
  An id present only on a `过期` (expired) line counts as **`missing`** (it can't be sent).
- `myrSum` / `sgdSum` — subtotals recomputed over the kept lines, **always** present
  (unlike `/users/:id`, which only adds them on `option=1`).
- `expiredAvailable` — `true` if the cart had any expired line (mirrors `/users/:id`).

### Edge cases
- **Nothing matched** (`kept.length === 0`) → HTTP 200 with the empty-cart message
  (`您的购物车里暂无商品哦~`), still carrying `matched:[]` + `missing`.
- **Cart fetch fails** → 200 with the "not able to see your cart" message,
  `matched:[]`, `missing` = all requested ids.
- **Source page says `无数据`** (unknown fb id or genuinely empty cart — indistinguishable)
  → 200 empty-cart message.
- **SGD conversion fails** → 200 with the "not able to update" message.

## Deliberate differences from `GET /users/:id`
- **No "Total:" verification.** The legacy route checks the parsed sum against the
  page's `Total:` and errors on mismatch. A partial cart never matches, so that check
  is dropped here.
- `myrSum`/`sgdSum` always included (see above).
- Line RM = `unit price × qty` computed from `parseCart`'s `price`/`qty` (the legacy
  route reads the page's own line-subtotal `<td>`); these agree on normal data.

## Testing
- Load check: `node -e "require('./app.js')"` — route registers as
  `POST /users/:id/selected`.
- Live: run `node app.js` (needs a valid Baserow cookie), then
  `curl -X POST localhost:8000/users/<psid>/selected -H 'Content-Type: application/json' -d '{"goodsIds":["<id>"],"option":1}'`.
- Parsers are regex over live EC2 HTML with no fixtures — verify against a live cart
  after any change to `parseCart` or this block.

## Deploy
Not auto-deployed. `npm run deploy` (= `claudia update`) to push to Lambda.
