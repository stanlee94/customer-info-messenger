# Baserow Integration

All requests use `Authorization: Token <baserowToken>` and `user_field_names=true`.

- **Users table** (`baserowUsersTableId`, `749`): `findBaserowUserRowByPsid()` filters by `PSID` (case-sensitive, assumed unique) and resolves to `null` (not a thrown error) when no row matches. `updateBaserowRowUid()` PATCHes `UID` (a mirror — `uidPsidMap` is the source of truth). `createBaserowUserRow()` POSTs `PSID`/`UID`/`Name` for new "Link" clicks.
- **Order summary** (`getCustomerSummaryByPsid()`, handles `GET_ORDERS_BY_PSID`): from the matched Users row — `Sum of Order` → "Total Spending" (RM), `Order Count` → "Total Purchase", `Last Order Date` → date string (shown on hover via `data-tooltip`), `Raw_Recency` → "Last Order" display (integer days → `formatRecency()`), `Years_Active`, `RFM_Score` → "Rank", `Address` (with inline copy button when non-empty).
- **Orders table** (`baserowOrdersTableId`, `750`): `fetchBaserowRecentOrders()` is a fallback-only function — called only when the EC2 order API returns fewer than 5 orders. Filters by `PSID` (`link_row_contains`), `order_by=-Date&size=5`, mapping `Order_ID`/`Total_Amount`/`Date` → `{ orderId, orderSn: Order_ID, totalAmount, orderDate }`. Baserow `Order_ID` already includes the `F` prefix (e.g. `"F12345"`), so `orderSn` is used as-is.

If field names change, adjust `getCustomerSummaryByPsid()` / `fetchBaserowRecentOrders()` only — `content.js` just needs `{ ok, data: {...} }` or `{ ok: true, notFound: true }`.

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

## Recent orders panel — click behaviour & colours

`renderRecentOrdersInPanel` distinguishes EC2 orders from Baserow-only orders using:
```js
const isBaserow = !order.orderId || String(order.orderId) === String(order.orderSn);
```
EC2 orders have a separate numeric `orderId`; Baserow-only orders have `orderId === orderSn` (both the F-prefixed string).

**EC2 orders** (`.cim-order-id`, blue `#0a7cff`):
- Rendered as `<span role="button">` — spans are immune to Facebook's button CSS resets.
- Click → `openOrderDetailNoBack(order.orderId)` opens the order detail modal with no back button (`modal._noBack = true`).
- After `GET_ORDER_STATUSES`: `WAIT_AUDIT` status turns the span orange. Other statuses left as blue.

**Baserow-only orders** (`.cim-order-id.cim-order-id--baserow`, dark grey `#555`):
- Rendered as `<a>` linking to `https://ddherbs.com.my/track/<orderSn>` (opens new tab).
- Not targeted by the order detail modal — these are historical records not in EC2.

**Layout**: `li` is `display: block; overflow: hidden`. Amount (`float: right`, first in DOM) anchors to the right; `idEl`, `.cim-order-date`, and copy button flow as inline text after it. This ensures the date is always continuous after the order SN, regardless of wrapping.

**"Recent Orders ↗"** heading button opens the order list modal, passing already-fetched `allOrders` (no second API call).

## Order status colouring

After the orders list is rendered, `content.js` sends `GET_ORDER_STATUSES` with all `orderSn` values (F-prefixed, e.g. `["F12345", ...]`). `background.js` calls:

```
GET https://7n881aguj8.execute-api.ap-southeast-1.amazonaws.com/orders/<id1>,<id2>,...
```

No auth header required. Response: array of `{ onlineOrderNumber, status }`. `fetchOrderStatuses()` builds a `{ [onlineOrderNumber]: status }` map. `content.js` queries `.cim-order-id[data-order-id]` elements and sets `color: orange` for `WAIT_AUDIT`. Other statuses left unstyled.
