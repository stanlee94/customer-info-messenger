# Feature handoff — Copy another customer's cart into the current cart

Self-contained spec for the frontend instance. Nothing else needed to build it.

## What it does

The operator has one customer's cart open, types a **second** `fbUserId` (another
customer), and this pulls all of that other customer's cart lines into the current
cart. Quantities merge if a product already exists in the target.

## Endpoint (live)

```
POST https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest/api/cart/copy
Content-Type: application/json
```

No auth, no cookies — plain JSON `fetch`. CORS is enabled. Every response is
`{ok:true, ...}` or `{ok:false, msg}` — always branch on `ok`, show `msg` verbatim on failure.

### Request body

```jsonc
{
  "fbUserId":       "<current cart owner>",   // TARGET — the cart already open (receives items)
  "sourceFbUserId": "<the OTHER customer>",   // copy FROM — the id the operator types
  "includeExpired": false,   // optional, default false → (过期) lines are skipped
  "dryRun":         false     // optional, default false → true = preview only, writes nothing
}
```

### Response

```jsonc
{
  "ok": true,
  "fbUserId": "...",
  "sourceFbUserId": "...",
  "sourceItemCount": 5,                 // how many lines the source cart had
  "dryRun": false,
  "added":   [{ "goodsId": "...", "name": "...", "qty": 3, "expired": false }],  // added (or "would add" if dryRun)
  "skipped": [{ "goodsId": "...", "name": "...", "qty": 1, "reason": "expired" }],// not attempted, with reason
  "failed":  [{ "goodsId": "...", "name": "...", "qty": 2, "error": "..." }],     // add attempted but rejected
  "cart":    { "fbUserId": "...", "userId": "...", "ecUserId": "...", "items": [ /* TARGET cart AFTER copy */ ] }
}
```

`cart` is the target cart **re-fetched after the copy** — it is the source of truth, use
it directly to re-render (no extra `GET /api/cart` needed).

## How to use — recommended: preview → confirm

```js
const API_BASE = "https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest";

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.msg || "Request failed"); // show json.msg in a toast
  return json;
}

// 1) PREVIEW — show what WOULD be copied; writes nothing
const preview = await api("/api/cart/copy", {
  method: "POST",
  body: { fbUserId: currentId, sourceFbUserId: typedId, dryRun: true },
});
// render preview.added (will be added) + preview.skipped (won't), then ask operator to confirm

// 2) COMMIT — actually copy
const result = await api("/api/cart/copy", {
  method: "POST",
  body: { fbUserId: currentId, sourceFbUserId: typedId },
});
// use result.cart DIRECTLY to re-render the cart (already re-fetched)
// show a summary from result.added / result.skipped / result.failed
```

## General rules

- **Quantities merge**: if the target already has a product, the source qty adds to the
  existing qty. The returned `cart` shows the real result.
- **One bad line never aborts the batch** — it lands in `failed[]` and the rest still copy.
  Always surface `failed[]` to the operator.
- **Errors** (standard envelope): missing `fbUserId` or `sourceFbUserId` → HTTP `400`;
  `sourceFbUserId === fbUserId` → HTTP `422`. Both are `{ok:false, msg}`.
- **Limitation**: product style/variant is not carried (the cart page doesn't expose it),
  so copies default to the base product (style `0`). Fine for standard items; a
  variant-specific line copies as the base product.

## Edge case 1 — the source cart has EXPIRED items ( (过期) lines )

- **Default (`includeExpired` omitted or `false`)**: each expired line is **skipped**. It
  appears in `skipped[]` with `reason: "expired"` and is **not** added. All non-expired
  lines copy normally.
- **`includeExpired: true`**: the expired line is attempted like any other. Because it is
  re-added by `goodsId` as a brand-new line, it comes into the target cart **fresh (not
  expired)**.

**UI suggestion:** default behaviour (skip) is usually what you want. If you show an
"include expired" toggle, make it opt-in, and after the copy show the `skipped[]` list so
the operator knows which lines were left out.

## Edge case 2 — an item has 0 AVAILABLE (out of stock)

The copy calls the portal's own add-to-cart for each product and honours the portal's
success/error result:

- **If the portal REJECTS the out-of-stock add** (returns an error such as 库存不足 /
  insufficient stock): that line goes into **`failed[]`** with the portal's error message,
  and the copy **continues** with the remaining items. Nothing crashes.
- **If the portal ALLOWS the add** (backorder / oversell permitted): the item is simply
  **added successfully**, appearing in `added[]` like any normal line.

> ⚠️ **Unconfirmed which one this portal does.** We have not run a live out-of-stock test,
> so it is not yet verified whether this portal blocks or allows a 0-available add. Either
> way is handled safely (blocked → `failed[]`; allowed → `added[]`) and the rest of the
> cart still copies — but do **not** assume out-of-stock is guaranteed to be blocked.
> Always read `failed[]` and reflect it in the UI; if you need certainty, run one real
> out-of-stock copy and observe whether the item lands in `added[]` or `failed[]`.

## Summary of outcomes

| Situation | What happens | Where it shows |
|---|---|---|
| Normal in-stock item | Added (qty merges if already present) | `added[]` |
| Expired line, default | Skipped, not added | `skipped[]` (`reason: "expired"`) |
| Expired line, `includeExpired:true` | Added fresh (no longer expired) | `added[]` |
| 0 available, portal blocks | Not added, batch continues | `failed[]` (with error) |
| 0 available, portal allows | Added normally | `added[]` |
| `dryRun: true` | Nothing written; `added[]` = what *would* be added | `added[]` / `skipped[]` |
| Bad/missing ids | Request rejected | HTTP 400 / 422 `{ok:false,msg}` |

In all cases: nothing crashes, the batch never half-aborts, and `added` / `skipped` /
`failed` together tell you exactly what happened. The returned `cart` is always the true
post-copy state.
