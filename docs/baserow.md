# Baserow Integration

All requests use `Authorization: Token <baserowToken>` and `user_field_names=true`.

- **Users table** (`baserowUsersTableId`, `749`): `findBaserowUserRowByPsid()` filters by `PSID` (case-sensitive, assumed unique) and resolves to `null` (not a thrown error) when no row matches. `updateBaserowRowUid()` PATCHes `UID` (a mirror — `uidPsidMap` is the source of truth). `createBaserowUserRow()` POSTs `PSID`/`UID`/`Name` for new "Link" clicks.
- **Order summary** (`getCustomerSummaryByPsid()`, handles `GET_ORDERS_BY_PSID`): from the matched Users row — `Sum of Order` → "Total Spending" (RM), `Order Count` → "Total Purchase", `Last Order Date` → date string (shown on hover via `data-tooltip`), `Raw_Recency` → "Last Order" display (integer days → `formatRecency()`), `Years_Active`, `RFM_Score` → "Rank", `Address` (with inline copy button when non-empty).
- **Orders table** (`baserowOrdersTableId`, `750`): `fetchRecentOrders()` filters its own `PSID` field (a `link_row` to Users, so uses `filters`/`link_row_contains` rather than `filter__PSID__equal`), `order_by=-Order_ID&size=5`, mapping `Order_ID`/`Total_Amount`/`Date` → `{ orderId, totalAmount, orderDate }`.

If field names change, adjust `getCustomerSummaryByPsid()` / `fetchRecentOrders()` only — `content.js` just needs `{ ok, data: {...} }` or `{ ok: true, notFound: true }`.

## Orders view — summary panel

The `orders` case in `renderState` uses a local `addSummaryRow(label, value, extraClass)` helper that returns `{ row, valueEl }` for per-row customisation. Fields displayed:

| Label | Source field | Notes |
|---|---|---|
| Total Spending | `Sum of Order` | Formatted as RM currency |
| Total Purchase | `Order Count` | |
| Last Order | `Raw_Recency` (days) | `formatRecency()` output; `data-tooltip` shows raw `Last Order Date` on hover |
| Years Active | `Years_Active` | |
| Rank | `RFM_Score` | |
| Address | `Address` | Inline copy button appended inside value span when non-empty |

`formatRecency(days)` (in `content.js`) converts an integer day count to a human-readable string with no external library:
- `< 30 d` → `"Xd ago"`
- `< 365 d` → `"Xm Yd ago"`
- `≥ 365 d` → `"Xy Xm Yd ago"`

Custom tooltip pattern: any element with a `data-tooltip` attribute gets a CSS `::after` dark floating tooltip on hover (defined in `styles.css`). Used for the Last Order date. Does not rely on the native `title` attribute, which is unreliable inside injected content scripts.

## External order-management links

In the `orders` view:

- "Recent Orders" heading links to full2house: `https://ec2.full2house.com/Ent/index.php?...&fb_user_id=<PSID>&...`.
- Each order's `Order_ID` links to `https://ddherbs.com.my/track/<Order_ID>` for tracking.
- Each order shows the `Date` field (from Orders table) formatted as `D/M/YYYY` (no leading zeros, no time) in a `.cim-order-date` span between the order ID link and the copy button: e.g. `F9558... (8/6/2026) [copy]`.
- Each order ID link is coloured yellow (`el.style.color = 'yellow'`) if its status from the order-status API is `"WAIT_AUDIT"` (see below).

## Order status colouring

After the orders list is rendered, `content.js` sends `GET_ORDER_STATUSES` with all `orderId` values from `recentOrders`. `background.js` calls:

```
GET https://7n881aguj8.execute-api.ap-southeast-1.amazonaws.com/orders/<id1>,<id2>,...
```

No auth header required. Expected response: an array of objects with `onlineOrderNumber` (the order ID) and `status` fields:

```json
[{ "onlineOrderNumber": "F955820...", "status": "WAIT_AUDIT" }, ...]
```

`fetchOrderStatuses()` in `background.js` builds a `{ [onlineOrderNumber]: status }` map and returns `{ ok: true, statuses }`. `content.js` then queries `.cim-order-id` elements by text content and sets `color: yellow` on any whose status is `"WAIT_AUDIT"`. Other statuses are left unstyled.
