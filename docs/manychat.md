# ManyChat Integration

All ManyChat requests use `Authorization: Bearer <manychatToken>`.

**`searchManyChatByName()`** — `GET /fb/subscriber/findByName?name=...`, expecting `{ data: [{ id, name|first_name/last_name, profile_pic, last_input_text, last_interaction }] }` (`id` = PSID), sorted by `last_interaction` descending. `content.js` renders candidates as cards (`.cim-candidates-list`, ~3 visible rows). If `lastMessage` is a URL, `getAttachmentLabel()` maps the extension to "Photo"/"Video"/"PDF"/"Audio"/"Attachment" and links to it.

**`getManyChatInfo(psid)`** — `GET /fb/subscriber/getInfo?subscriber_id=<psid>`. Called automatically after the `orders` view renders (`fetchAndRenderManyChatInfo()`). Returns `{ ok, phone, email, whatsappPhone, tags: [{ id, name }] }`. Result cached in `sessionState.manychatInfo`; re-used on rehydration without a second network call. Phone/email/WhatsApp are appended to the summary panel (with copy buttons) if non-null.

**`manyChatTagAction(action, psid, tagId)`** — `POST /fb/subscriber/addTag` or `/fb/subscriber/removeTag` with body `{ subscriber_id, tag_id }`. Used by the language tag toggle.

## Manual candidate search (candidates view)

Below `.cim-candidates-list`, a search bar (`handleCandidateSearch()`) lets staff find a customer by Order ID or PSID:

- Empty input → re-runs `SEARCH_MANYCHAT_BY_NAME` for the customer's scraped name (`sessionState.name`), refreshing `view.manychatCandidates` on success.
- Input starting with "F"/"f" → `SEARCH_BASEROW_BY_ORDER_ID`: Orders table by `Order_ID` → linked Users row; falls back to a PSID search if no match.
- Otherwise → `SEARCH_BASEROW_BY_PSID`: exact `PSID` match in Users table.

Both map a Users row via `mapUserRowToCandidate()` to `{ psid, name, lastOrderDate, rfmScore }` (`Last Order Date`/`RFM_Score` field names). Results render via `buildBaserowCandidateCard()` (Name/Last Order/Rank, no avatar) instead of the ManyChat card. Empty/failed results leave the list unchanged and show a message in `.cim-search-status`.
