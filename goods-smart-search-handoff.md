# Smart goods search — `POST /api/goods/search`

Self-contained handoff for the **quick-add / shorthand** product search. Everything a
frontend needs is here; nothing else in the codebase is required reading. This is a
purely **additive** feature — it does not change `GET /api/goods` or any other route.

Related docs: `handoff-ec2-reverse-engineer.md` (the full portal contract, Goal 2 =
the interactive single-box search) and `CLAUDE.md` (architecture).

---

## Why this exists

The EC2 backend's only product-search lever is `goods_name`, which it feeds straight
into a SQL `LIKE '%…%'` (verified live). That means a naive multi-word search only
matches when the words are **contiguous** in the product name — so `红枣 500g` finds
nothing, because no product is literally named "红枣 500g". Real names look like
`【1级/去核】一级红枣 Seedless Red Dates 500g`: the words you'd type are scattered,
out of order, and split across Chinese + English.

This endpoint lets an operator type a shorthand bag of words per product and get the
right SKU back, regardless of word order or language.

---

## The frontend's job (before calling)

The operator types **one sentence, comma-separated, one product per segment**:

```
红枣 去核 500g，枸杞 250g，菊花 朵，黄精 茶
```

The **frontend** does the splitting and fans out **one request per product** (do them
in parallel):

1. Split the sentence on **both** comma forms: `sentence.split(/[，,]/)` (the fullwidth
   `，` is the common one on a Chinese keyboard).
2. `trim()` each segment and drop blanks.
3. Split each segment on whitespace into a token array: `seg.trim().split(/\s+/).filter(Boolean)`.
4. `POST /api/goods/search` with `{ words: <that array> }` — one call per product.

So the sentence above becomes **4 independent POSTs**:
`["红枣","去核","500g"]`, `["枸杞","250g"]`, `["菊花","朵"]`, `["黄精","茶"]`.

Render each response as that product's picker list (with the `img` thumbnail — see
Photos below). The operator taps the correct SKU, and you add it to the cart via the
normal `POST /api/cart/items` flow (see `handoff-ec2-reverse-engineer.md` Goal 2).

---

## Request

```
POST /api/goods/search
Content-Type: application/json

{ "words": ["红枣", "去核", "500g"] }
```

- `words` — the product's tokens as an **array** (preferred), OR a raw **string**
  (`"红枣 去核 500g"`) which the backend will split on whitespace itself. Either works.
- No other fields. **The backend chooses the search method — the frontend never
  picks a mode.**
- Missing / empty `words` → **HTTP 400** `{ ok:false, msg }`.

CORS: the `/api` surface answers preflight and allows cross-origin JSON POSTs, so this
works from the operator panel's origin.

---

## Response

```jsonc
{
  "ok": true,
  "query":  ["红枣","去核","500g"],   // echo of what you sent (array or string)
  "tokens": ["红枣","去核","500g"],   // the normalized token list actually searched
  "total":  7,                        // number of matching SKUs
  "items": [
    { "goodsId":"…", "name":"【1级/去核】一级红枣 Seedless Red Dates 500g",
      "price":"…", "stock":"…", "warehouseCode":"…", "onSale":"…", "img":"https://img.full2house.com/…jpeg" }
    // …
  ]
}
```

- `items` is the same row shape as `GET /api/goods`, so any existing goods-row
  component renders it unchanged. `img` is a permanent public CDN URL (or `null`);
  load it directly in the browser, no cookie/proxy.
- **No match** → `total: 0`, `items: []` (an empty array — not a missing key, unlike
  `GET /api/goods`'s `noResult`). Just check `total === 0` or `items.length === 0`.
- Failure (EC2/cookie problem) → `{ ok:false, msg }` with HTTP 422 (portal rejected)
  or 500. Branch on `ok`.
- **No pagination.** This is a quick-add picker, not a browse — you get the full match
  set for the query (match sets are small because the words are specific). If a set is
  ever unexpectedly large, cap it in the UI.

---

## What the backend does (so you can trust the results)

The backend picks the method by **word count** — all three are order-independent and
case-insensitive for Latin, and none require the words to be contiguous:

| Words | Method | How |
|-------|--------|-----|
| **1** | plain | one `LIKE '%word%'` |
| **2** | `%`-union | queries `A%B` **and** `B%A`, merges + dedupes → order-independent AND, done entirely in the DB |
| **3+** | probe-min | one probe per word to learn each word's result count, **anchor on the rarest word**, then AND-filter the rest in memory (any order) |

Why probe-min for 3+: SQL `LIKE` can only AND words *in a fixed order*, and the words
you type are rarely in the name's order. Trying every order would cost N! queries.
Instead the backend asks the DB how rare each word is, fetches only the rarest word's
(small) result set, and filters the other words in memory. Every true match contains
the rarest word, so nothing is missed. Selective queries cost just N lightweight
requests and no extra fetching.

Edge cases handled for you:
- Any word matching **nothing** → the whole query is `total:0` (a real product must
  contain every word).
- The rarest word is capped at 5 pages as a safety net; in practice a real product
  word (红枣, 枸杞, 黄精…) returns well under one page.

---

## Verified live (2026-07-24)

Sentence `红枣 去核 500g，枸杞 250g，菊花 朵，黄精 茶` → 4 requests:

| `words` sent | method | total | top hit |
|--------------|--------|-------|---------|
| `["红枣","去核","500g"]` | probe-min | 7 | 【1级/去核】一级红枣 Seedless Red Dates 500g |
| `["枸杞","250g"]` | %-union | 10 | 黑枸杞 Black Goji Berry 250g |
| `["菊花","朵"]` | %-union | 3 | 桐乡朵菊花 TongXiang Chrysanthemum 100g |
| `["黄精","茶"]` | %-union | 1 | 九制黄精茶 36*6g |

---

## Backend location (for maintainers)

- `portal.js` — `looseSearchOne(words)` (the dispatch) + `_goodsQuery(pattern, page)`
  (low-level single native query) + `dedupeGoods(items)` helper.
- `express-router.js` — `POST /goods/search` (400 guard → `looseSearchOne`).
- Parsers are regex over live EC2 HTML/JSON with no fixtures — verify any change
  against a live response (`node app.js`, then POST to `localhost:8000/api/goods/search`).
