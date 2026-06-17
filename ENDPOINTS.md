# `/checkSession` and `/users/:id` — behavior notes

Base URL (deployed): `https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest`

## `GET /checkSession`

**Purpose:** cheap diagnostic to verify the cached session cookie
(`cookiesNewPage`) still works against `ec2.full2house.com`, without doing a
full scrape.

**Logic** (`app.js:104-139`):
- GETs the EntLive admin index page with the cached cookie, `maxRedirects: 0`,
  `validateStatus: () => true` (so redirects/errors are inspected manually
  instead of throwing).
- Redirected to `a=Login` → cookie expired → `401 {status:'expired', ...}`
- `200` and body contains `<tbody>` (looks like the real admin page) →
  `200 {status:'ok', message:'Session cookie is valid', baserowHit}`
- Anything else → `401 expired`; axios/network error → `500 {status:'error', message}`
- `baserowHit` reflects whether the global cookie-refresh middleware
  (`app.js:26-52`) re-fetched the cookie from Baserow on *this* request (true
  if >2h since last fetch, or a fresh Lambda execution environment).

### Example

```
GET /checkSession
200
{"status":"ok","message":"Session cookie is valid","baserowHit":true}
```

## `GET /users/:id?option=1|2|3`

**Purpose:** core "view cart" endpoint — scrapes a Facebook user's
live-shopping cart, converts MYR→SGD, and builds a bilingual order summary
text for the chatbot.

**Logic** (`app.js:151-385`):
1. GET `ec2.full2house.com/...&m=liveUserCartLists&fb_user_id=<id>` with the
   cached cookie.
2. If the response contains `无数据` ("no data") → return the "cart is empty"
   message immediately.
3. Otherwise split the HTML by `<tr`; rows 0 and 1 are header rows and are
   skipped.
4. Per item row, columns by index: `<td>` 5 = item name, 8 = qty, 9 = RM
   subtotal.
5. The **last row** is special — it also carries the page's "Total:" figure
   (`itemFinalSum`).
6. **Expired items** (row text contains `过期`):
   - Non-last expired row → flagged via `expired = true` and **silently
     excluded** from `items`. (Note: `expired` is set but never read anywhere
     else — no "some items expired" notice ever reaches the customer.)
   - Last row expired → `lastRowExpired = true`, that row is skipped entirely
     (so `itemFinalSum` is never set).
7. Remaining items' RM subtotals are batch-converted to "nice" SGD prices via
   the `myr-sgd-price-api` worker.
8. **Validation**: if `lastRowExpired` is false, `sum(items)` must match
   `itemFinalSum` (±0.001) or it returns a generic "can't update your cart
   right now" error (catches markup-parsing drift). If `lastRowExpired` is
   true, this check is skipped and `subtotalAmount = sum(items)`.
9. Builds the bilingual `text` per `option`: `1` = RM+SGD, +RM10 postage, both
   bank accounts (default); `2` = RM only, +RM10, MY bank; `3` = SGD only, no
   postage, SG bank.
10. If nothing got appended to `text` (all items filtered out), falls back to
    the "empty cart" message.

### Test results (option=1)

| ID | Description | Result |
|---|---|---|
| `6823090411121153` | empty cart | `"您的购物车里暂无商品哦~ / Your shopping cart is empty"` |
| `12345` | fake/non-existent id | **Same** empty-cart message as above |
| `24468469792828712` | not empty | Full 12-item summary, Subtotal RM 649.20 / SGD ~244, +RM10 postage → **Total RM 659.20**, both MY & SG bank accounts shown |
| `5640437852740540` | cart with an expired item | Full 6-item summary, Subtotal RM 236.70 → **Total RM 246.70**, **no mention of any expired item** |

#### Example: empty cart / fake id (`6823090411121153`, `12345`)

```json
{"version":"v2","content":{"messages":[{"type":"text","text":"您的购物车里暂无商品哦~\nYour shopping cart is empty for the moment ❤️✌️"}]}}
```

#### Example: non-empty cart (`24468469792828712`)

```json
{"version":"v2","content":{"messages":[{"type":"text","text":"多多贴心人手结单 Manual Listing\n---------------------------------\n\n✅ 【买10送1】(中大)加拿大泡参片 (L)Canada Ginseng Slice 20g x 10（120.00/ SGD $45.00）\n✅ (500g)【600头】大连珍珠元贝 Dalian Dried Scallops x 1（99.00/ SGD $37.00）\n✅ 胎菊 Chrysanthemum Buds 100g x 1（9.00/ SGD $3.50）\n✅ 特级金银花 Premium Honeysuckle 50g x 1（9.90/ SGD $3.90）\n✅ 新【超特】新疆红枣 XXL Xinjiang Red Dates 500g x 1（10.80/ SGD $4.00）\n✅ (特大) 宁夏贡枸杞 Premium XL Goji Berry 250g x 1（17.00/ SGD $6.80）\n✅ 莆田头水紫菜 Putien Seaweed 100g x 1（19.90/ SGD $7.90）\n✅ 【顶级】七彩菌汤包 Superior Mixed Fungus Soup Pack x 1（19.90/ SGD $7.90）\n✅ 珍珠白花菇王 Pearl Mushroom King 200g x 1（29.90/ SGD $10.90）\n✅ 【吉饼ORANGE】雪梨吉饼海底椰糖水 Dried Pear Nourishing Sweet Soup x 2（27.80/ SGD $10.30）\n✅ (加料版)多多肉骨茶 DD Bak Kut Teh x 2（36.00/ SGD $13.80）\n✅ 【200g】(40-45头) 美国金山秃 USA Sea Cucumber 200g x 1（250.00/ SGD $93.00）\n\n合计 Subtotal: RM 649.20/ SGD $244.00000000000003\n+ RM10 (一次性 西马邮费 WM Postage)\n🇸🇬 邮寄新加坡必须付款新币户口 SG orders must be paid to the SGD account\n⚠️ 东马/新加坡 邮费另计 EAST M'SIA & SG POSTAGE CALCULATED SEPARATELY\n---------------------------\n总数 Total: *RM 659.20* (西马 WEST MSIA)\n\n---------------------------\n*银行户口 BANK ACCOUNT*\n🇲🇾 马来西亚 Malaysia (MYR)\nDD GROUP SDN BHD\n322-856-3632\nPUBLIC BANK\n\n🇸🇬 新加坡 Singapore (SGD)\nDD GROUP GLOBAL PTE. LTD.\n5958-0844-5001\nOCBC BANK\n"}]}}
```

#### Example: cart with an expired item (`5640437852740540`)

```json
{"version":"v2","content":{"messages":[{"type":"text","text":"多多贴心人手结单 Manual Listing\n---------------------------------\n\n✅ [单盒](50g/圆盒)【12年】加拿大泡参片 (XXL)Canada Ginseng Slice x 1（120.00/ SGD $45.00）\n✅ 长条沙参 Sha Shen 300g x 1（27.00/ SGD $9.90）\n✅ (8A) 特厚玉竹 Premium YukZuk 200g x 1（22.00/ SGD $8.10）\n✅ (4L)原夏威夷果 Raw Macadamia 300g x 1（29.90/ SGD $10.90）\n✅ 【500g! 500g!】(新年礼袋)美国盐烤杏仁 USA Roasted Almond  x 1（29.90/ SGD $10.90）\n✅ (5粒配套) 黄金罗汉果 Golden LuoHonGor Package x 1（7.90/ SGD $2.90）\n\n合计 Subtotal: RM 236.70/ SGD $87.70000000000002\n+ RM10 (一次性 西马邮费 WM Postage)\n🇸🇬 邮寄新加坡必须付款新币户口 SG orders must be paid to the SGD account\n⚠️ 东马/新加坡 邮费另计 EAST M'SIA & SG POSTAGE CALCULATED SEPARATELY\n---------------------------\n总数 Total: *RM 246.70* (西马 WEST MSIA)\n\n---------------------------\n*银行户口 BANK ACCOUNT*\n🇲🇾 马来西亚 Malaysia (MYR)\nDD GROUP SDN BHD\n322-856-3632\nPUBLIC BANK\n\n🇸🇬 新加坡 Singapore (SGD)\nDD GROUP GLOBAL PTE. LTD.\n5958-0844-5001\nOCBC BANK\n"}]}}
```

## Known issues / quirks

- **Can't distinguish "empty cart" from "no such user"**: `liveUserCartLists`
  returns `无数据` for both a real user with an empty cart and a
  non-existent `fb_user_id`, so `/users/12345` and
  `/users/6823090411121153` produce an identical response.
- **Expired items vanish silently**: when a cart item is marked `过期`
  (expired) on the source page, it's dropped from the parsed `items` list with
  no indication in the customer-facing message that anything was removed. The
  `expired` flag (`app.js:3`) is set but never read.
