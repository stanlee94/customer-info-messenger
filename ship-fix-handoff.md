# Ship fix — full ship (已出货) vs partial ship (部分出货)

Standalone reference for **one** issue: the order "出货 / Ship" button was landing orders
in **部分出货** (partial shipment) instead of **已出货** (fully shipped). This doc covers
the root cause, the fix, and how to call the API. Nothing else.

- **Fixed in:** `portal.js` (`operate` → `ship` → `getShippableLines`/`parseShippableLines`)
- **Deployed:** Lambda `auto-send-manual`, Version 70 (commit `ca544e5`)
- **Frontend contract:** **unchanged** — still `POST /api/orders/:orderId/operations {operation:"shiped"}`

---

## 1. The symptom

The order-detail panel has three action buttons: **确认 (Confirm)**, **确认+已付
(Confirm & Paid)**, **出货 (Ship)**.

Clicking **Ship** set the order's shipping status to **部分出货** (partial shipment).
It should become **已出货** (fully shipped).

## 2. Root cause

The old code posted a **bare** operation:

```js
// BEFORE (broken)
ship(orderId) { return this.operate(orderId, 'shiped'); }
// → POST ajax_operate_post { order_id, operation:'shiped', action_note:'', cancel_flag:'0' }
```

But on the live EC2 order page, that button (`operatePost('shiped')`) is **commented
out in the HTML** and no longer used:

```html
<!--<input name="shiped" type="button" onclick="operatePost('shiped')" ...>-->
```

The **real** Ship button calls a different function:

```html
<input name="shiped" type="button" onclick="sendOutByGoods()" value="...">
```

`sendOutByGoods()` opens a **goods-selector** iframe (`EntMall&m=getOrderGoods`) where
**every order line is pre-checked** and each line's ship-quantity (`outNum`) is
**pre-filled with the full ordered qty**. Confirming (`selectGoodsOk()`) posts to the
**same** `ajax_operate_post` endpoint, but with **per-line shipment data**:

```js
// what the real UI sends
{ order_id, operation:'shiped', action_note, cancel_flag:0,
  rec_ids: [<every line's rec_id>],   // e.g. ['59058012','59058013']
  outNums: [<qty per rec_id>],        // e.g. ['2','1']   (positionally paired)
  shipment_sn, package_weight, package_value, package_shipping_date,
  package_width, package_height, package_length, service_level }
```

**Because the old code omitted `rec_ids`/`outNums`, EC2 shipped ZERO lines** → the order
was recorded as **部分出货**. To fully ship, you must send **all** line `rec_ids` with
their **full** quantities (`outNums`), exactly like the pre-checked UI defaults.

## 3. The fix

`Portal.operate()` special-cases `'shiped'` and delegates to a real full-ship method.
Everything else (`confirm`, `pay`, `cancel`, `payreturned`) is untouched.

```js
async operate(orderId, operation, actionNote = '') {
  if (operation === 'shiped') return this.ship(orderId, { actionNote });   // ← full ship
  return this._postEnvelope('EntMall', 'ajax_operate_post', {
    order_id: orderId, operation, action_note: actionNote, cancel_flag: '0',
  });
}

async ship(orderId, opts = {}) {
  const lines = await this.getShippableLines(orderId);          // parses getOrderGoods
  if (!lines.length) throw new PortalError(`order ${orderId}: no shippable lines`, { orderId });
  return this._postEnvelope('EntMall', 'ajax_operate_post', {
    order_id: orderId, operation: 'shiped', action_note: opts.actionNote || '', cancel_flag: '0',
    'rec_ids[]': lines.map(l => l.recId),
    'outNums[]': lines.map(l => l.outNum),
    // packaging fields are blank in the UI by default — send them so the payload matches.
    shipment_sn: '', package_weight: '', package_value: '', package_shipping_date: '',
    package_width: '', package_height: '', package_length: '', service_level: '',
  });
}

async getShippableLines(orderId) {
  const html = await this._get('EntMall', 'getOrderGoods', { order_id: orderId });
  return parseShippableLines(html);   // [{recId, outNum}] — only default-checked lines
}
```

`parseShippableLines(html)` reads the goods-selector page and returns every
**default-checked** line with its full-qty `outNum` (already-shipped lines are unchecked
and skipped). `rec_ids[]` and `outNums[]` are built positionally from that list, so the
Nth quantity always belongs to the Nth rec_id.

## 4. How to use the API

**No frontend change.** The Ship button still calls the same endpoint:

```
POST /api/orders/:orderId/operations
Content-Type: application/json

{ "operation": "shiped" }
```

Optional: `{ "operation": "shiped", "actionNote": "..." }` to attach a note.

### Success

```json
{ "ok": true, "data": { ... } }
```

The backend fetched the order's shippable lines and shipped them all at full quantity.
Re-fetch `GET /api/orders/:orderId` and the shipping slot of `statusParts` should now
read **已出货**.

### Errors

| HTTP | Body | Meaning |
|---|---|---|
| `422` | `{ ok:false, msg:"order <id>: no shippable lines" }` | Nothing left to ship (already fully shipped, or bad/unknown order id). |
| `422` | `{ ok:false, msg:"<EC2 message>" }` | EC2 rejected the ship (e.g. `下单10分钟后才可以操作出货` — must wait 10 min after order creation). Show `msg` verbatim. |
| `500` | `{ ok:false, msg:... }` | Unexpected server/network error. |

Branch on `ok`; show `msg` as-is.

### Button-state rule (unchanged)

Show the **Ship** button only when the order is paid and not yet shipped — i.e.
`statusParts.shipping` starts with **未** (未出货). After a successful ship, re-fetch the
detail; the button disappears once `shipping` reads **已出货**.

## 5. Sample payload (on the wire)

Real order `12587924`, three lines (qty 2, 1, 1):

```
POST https://ec2.full2house.com/Ent/index.php?a=EntMall&m=ajax_operate_post

order_id=12587924&operation=shiped&action_note=&cancel_flag=0
&rec_ids[]=59058012&rec_ids[]=59058013&rec_ids[]=59058014
&outNums[]=2&outNums[]=1&outNums[]=1
&shipment_sn=&package_weight=&package_value=&package_shipping_date=
&package_width=&package_height=&package_length=&service_level=
```

(On the actual wire the `[]` is URL-encoded as `%5B%5D`; PHP array notation.)

- `rec_ids[]` and `outNums[]` are **positionally paired** — Nth quantity ↔ Nth rec_id.
- **Full ship** = each `outNums[]` equals that line's ordered qty (the UI default).
- Packaging fields are sent blank because the EC2 UI leaves them empty by default; the
  order is still recorded as **已出货**.

## 6. How this was verified (no real order shipped)

- All reverse-engineering was **read-only GETs**: the order list, `orderDetail`, and the
  `getOrderGoods` selector page — no `ajax_operate_post` was ever POSTed to a live order.
- The outgoing payload was captured with a **mocked `fetch`** (selector HTML fed from a
  saved capture; the ship POST intercepted, not sent), confirming the exact wire body
  above.
- End-to-end confirmation (an order actually flipping to **已出货**) must be done manually
  against a real paid-unshipped order — shipping is irreversible on EC2.

## 7. Notes / gotchas

- **Parsers are regex over live EC2 HTML** with no fixtures — as brittle as the rest of
  `portal.js`. If EC2 changes the goods-selector markup, `parseShippableLines` can silently
  return `[]` (→ 422 "no shippable lines") or wrong quantities. Re-capture `getOrderGoods`
  and re-verify if shipping starts failing.
- **10-minute rule:** EC2 blocks 出货 until 10 minutes after order creation
  (`下单10分钟后才可以操作出货`). A too-early ship returns that message as a `422`.
- **Partial ship is not exposed.** This fix always ships *all* default-checked lines at
  full qty (the "已出货" button's behaviour). There is no API to ship a subset — if that's
  ever needed, it's a new endpoint that takes explicit `rec_ids`/`outNums`.
