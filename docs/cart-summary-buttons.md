# Cart-Summary Copy Buttons (orders view)

`background.js` exposes `CART_API_BASE = https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest` (no auth header required).

On content-script load, `initCartSessionCheck()` sends `CHECK_SESSION` → `background.js` calls `GET /checkSession` and resolves `{ ok: true, valid: boolean }`. If `valid` is `true`, the module-level `cartSessionValid` flag is set to `true`.

When `cartSessionValid` is `true` and the `orders` view first renders, `probeCartAndShowButtons()` silently calls `GET_CART_SUMMARY` with `option: '1'` to check whether the cart is empty. The response shape is:

```json
{ "expiredAvailable": boolean, "myrSum": number|null, "sgdSum": number|null, "version": "v2", "content": { "messages": [{ "type": "text", "text": "..." }] } }
```

`background.js` `getCartSummary()` forwards `expiredAvailable`, `myrSum`, and `sgdSum` from the raw API JSON alongside `text`.

- **Non-empty**: sets `sessionState.cartHasItems = true`, saves `myrSum`/`sgdSum` to `sessionState`, and injects `buildCartSection(psid, { myrSum, sgdSum })` (buttons + prefix textarea) above "Recent Orders".
- **Empty**: sets `sessionState.cartHasItems = false` and injects a `.cim-cart-empty` pill ("🛒 Empty Cart") in the same position.
- **`expiredAvailable: true`**: sets `sessionState.expiredAvailable = true` and injects a `.cim-expired-notice` amber pill ("⚠️ Expired items available") at the top of the body. Nothing is shown when `false`.
- **Error / no response**: silently ignored; no UI change.

`cartHasItems`, `expiredAvailable`, `myrSum`, and `sgdSum` are all reset to `null` on each conversation switch so the probe runs once per customer. `renderState` reads them for rehydration (when Facebook removes and re-adds the panel).

| Button | CSS modifier | `option` param | Sub-label |
|---|---|---|---|
| ALL | `cim-cart-btn--both` (`#0a7cff` → `#0052b8` gradient) | `1` | — |
| 🇲🇾 MYR | `cim-cart-btn--myr` (green gradient) | `2` | `RM {myrSum}` (`.cim-cart-btn-sublabel`) |
| 🇸🇬 SGD | `cim-cart-btn--sgd` (amber gradient) | `3` | `S$ {sgdSum}` (`.cim-cart-btn-sublabel`) |

`buildCartSection(psid, prices)` passes a `subLabel` to `buildCartOptionButton` for the MYR and SGD buttons. The sub-label is omitted if `prices.myrSum` / `prices.sgdSum` is `null`. Buttons use `display: flex; flex-direction: column` so the price sits below the flag+currency label.

Clicking a button sends `GET_CART_SUMMARY { psid, option }` → `background.js` calls `GET /users/:id?option=N` and returns `{ ok: true, text, expiredAvailable, myrSum, sgdSum }` (full bilingual order-summary string) or `{ ok: false, error }`.

- Empty-cart detection: `text.includes('您的购物车里暂无商品哦~')` → shows "Empty Cart!" tooltip, does **not** copy.
- Non-empty: reads `.cim-cart-prefix` textarea value at click time. If non-empty, replaces `DEFAULT_CART_PREFIX` in the response text before copying; otherwise copies as-is. Calls `copyToClipboard(text)` → shows "Copied!" tooltip for 1.5 s.
- Errors: shows the error message in the tooltip instead.

**Cart prefix textarea** — `buildCartSection()` renders a `<textarea class="cim-cart-prefix">` below the three buttons (only shown when cart has items, never with the empty-cart pill). The module-level `cartPrefixText` variable persists the typed value across conversation switches within the same page session; it resets on page reload or extension reload. `DEFAULT_CART_PREFIX` is the bilingual livestream-reminder text constant in `content.js`.

Tooltip reuses the existing `.cim-copy-tooltip` / `.cim-copy-tooltip--visible` CSS. `buildCartOptionButton()` in `content.js` handles the click logic.
