# Backend Handoff: `mergeDuplicates` flag for `POST /api/cart/copy`

## Summary

The Chrome extension's Copy Cart feature now sends an optional `mergeDuplicates` boolean in the request body. The backend currently has no logic for this field — it needs to be implemented.

---

## Endpoint

```
POST /api/cart/copy
```

---

## Updated Request Body

```json
{
  "fbUserId": "111222333",
  "sourceFbUserId": "999888777",
  "dryRun": true,
  "includeExpired": false,
  "mergeDuplicates": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `fbUserId` | string | yes | Destination customer |
| `sourceFbUserId` | string | yes | Source customer to copy from |
| `dryRun` | boolean | no | If true, simulate only — do not write |
| `includeExpired` | boolean | no | If true, include expired items from source |
| `mergeDuplicates` | boolean | no | Controls duplicate handling (see below) |

---

## `mergeDuplicates` Behaviour

### `mergeDuplicates: false` (default, omitted = false)

If a product (`goodsId`) from the source cart **already exists** in the destination cart:
- **Add it as a new separate row** regardless of the existing row.
- The destination cart ends up with two separate rows for the same `goodsId`.
- The existing row's quantity is **not touched**.

This is the new default. The frontend no longer merges by default.

### `mergeDuplicates: true`

If a product (`goodsId`) from the source cart **already exists** in the destination cart:
- **Add the source quantity onto the existing row** (i.e. `existingQty += sourceQty`).
- No new row is created for that product.
- This was the previous default behaviour.

---

## Effect on `dryRun` Preview

The `dryRun: true` call is made first so the frontend can show a preview before the user confirms. The `mergeDuplicates` flag must be respected in dry-run too, because the preview sections shown to the user depend on it:

- **`mergeDuplicates: false`** — products that already exist in destination appear in `added` (they will become separate rows), not `skipped`.
- **`mergeDuplicates: true`** — products that already exist in destination appear in `added` with a note like `merged`, or in a separate `merged` bucket if you prefer, rather than `skipped`.

The frontend reads `added`, `skipped`, and `failed` arrays from the dry-run response and displays them. Keep the same response shape.

---

## Response Shape (unchanged)

```json
{
  "ok": true,
  "added": [{ "goodsId": "...", "name": "...", "qty": 2 }],
  "skipped": [{ "goodsId": "...", "name": "...", "qty": 1, "reason": "expired" }],
  "failed": [],
  "cart": null
}
```

No change to response shape is needed. The `mergeDuplicates` flag only changes which items land in `added` vs `skipped` and how the write is performed.

---

## Summary of What Needs to Be Built

1. Read `mergeDuplicates` from the request body (default `false` if absent).
2. When copying items from source → destination:
   - For each source item, check if the same `goodsId` exists in the destination cart.
   - If **no duplicate**: add as new row (same as current behaviour).
   - If **duplicate exists**:
     - `mergeDuplicates: false` → add as new separate row.
     - `mergeDuplicates: true` → increment qty on the existing row.
3. Apply the same logic in both the real write and the `dryRun` simulation.
