# UI Panel

## UI theme

The panel uses a **light theme** designed to blend with Meta Business Suite's white/grey interface:

- **Background**: `#ffffff`; borders `#e4e6eb`; surfaces `#f0f2f5`
- **Accent colour**: `#0a7cff` (primary) / `#0060d6` (hover/gradient end) / `#0052b8` (deep gradient). Use these values — do **not** reintroduce the old indigo/purple (`#6366f1`).
- **Text**: primary `#050505`, secondary `#65676b`, muted `#8a8d91`
- **Sidebar margins**: `6px 8px` (intentionally tight so the panel spans the full sidebar width)
- **Floating width**: `300px`
- **Cart prefix textarea**: white (`#ffffff`) background to signal editability
- **MYR/SGD sub-labels** (`.cim-cart-btn-sublabel`): `font-weight: 800`

## Draggable panel

`ensurePanel()` checks the module-level `panelPosition` variable (`null` on page load):

- **`null`** — inserts the panel before the "Contact details" anchor in the sidebar (original behaviour).
- **Set** — appends to `document.body` with `position: fixed` and `.cim-floating` class, restoring the saved `{ x, y }` coordinates.

`initDrag(panel)` wires the `<div class="cim-drag-handle">` at the top of the panel. On the first drag the panel is moved to `document.body` and `.cim-floating` is added (transition from sidebar → floating). Subsequent drags update `panelPosition` on `mouseup`. The variable is module-level, so it persists across conversation switches but resets to `null` on page reload (returning the panel to the sidebar).

The drag handle is an **empty `<div>`** — its 4×2 dot-grid grip is rendered entirely by the CSS `::before` pseudo-element (`radial-gradient` background pattern). Do not put text content inside it.

## Close / restore button

A `<button class="cim-close-btn">` sits in the top-right corner of the panel. It is only visible when **both** conditions are true:

1. The panel is floating (`.cim-floating` is present).
2. The Facebook sidebar is expanded (`.cim-sidebar-visible` is present).

CSS selector that shows it: `#cim-purchase-panel.cim-floating.cim-sidebar-visible .cim-close-btn`.

**`.cim-sidebar-visible` is managed by `syncCloseBtnVisibility()`** — called at the top of every `scheduleCheck()` invocation (i.e. on every DOM mutation). It toggles the class based on whether `findContactDetailsAnchor()` returns a non-null element. This means the × disappears automatically when the user collapses the Facebook sidebar.

Clicking × calls the handler in `initDrag()`: looks up the anchor first; if not found, aborts silently (safety net). Otherwise sets `panelPosition = null`, removes `.cim-floating` and `.cim-sidebar-visible`, clears inline `left`/`top`, and calls `anchor.parentElement.insertBefore(panel, anchor)` to dock the panel back.

## Name row and PSID row

When a PSID is linked, `renderPsidRow()` also updates the name row: the customer name becomes an `<a class="cim-name-link">` (dark text, underline on hover) that calls `openCartModal(psid)` on click — opening the EC2 cart management modal. It does **not** navigate to a new tab.

The PSID number is rendered as a `<span class="cim-psid-link">` (dark text, pointer cursor). Clicking it copies the PSID to the clipboard and shows a "Copied!" tooltip (`.cim-copy-tooltip`) for 1.5 s — it does **not** navigate.

The `(unlink)` link retains its own `.cim-unlink` class (`#0a7cff`) — keep these classes separate so their colours don't bleed into each other.

## Language tag toggle

A `.cim-lang-tags` segmented control sits between the PSID row and the body. It is populated by `renderLangTags(panel, tags, psid)` once `getManyChatInfo` resolves (via `renderManyChatInfoRows`). Two recognised tag IDs:

| Tag ID | Label |
|---|---|
| `35385444` | Chinese |
| `35385464` | English |

**Visual states** (defined in `LANG_TAGS` constant in `content.js`):
- **Neither set** — container track is light red (`#fff5f5`); both chips are muted rose text (`#cd5c5c`), no border.
- **One set** — active chip is light green (`#f0fdf4`, `#15803d` text); inactive chip is transparent/grey. Container track is neutral (`#f0f2f5`).

**Click behaviour**:
1. Clicking the already-active chip is a no-op.
2. Clicking an inactive chip sets it to `.cim-lang-tag--loading` (`cursor: wait`).
3. If another tag is currently active: `MANYCHAT_TAG_ACTION remove` fires first; only on success does `MANYCHAT_TAG_ACTION add` fire.
4. If no tag is active: only `MANYCHAT_TAG_ACTION add` fires.
5. On full success: updates `sessionState.manychatInfo.tags` and re-renders.

**Error handling**:
- *Remove fails*: chip flashes `.cim-lang-tag--error` (red, 1.5 s) then re-renders from unchanged `sessionState` — UI stays as-is.
- *Remove succeeds, Add fails*: `sessionState.manychatInfo.tags` is updated to strip the removed tag **before** the error flash, so after 1.5 s the control re-renders with both chips grey — correctly reflecting ManyChat's real state (neither tag).

`renderPsidRow()` clears `.cim-lang-tags` on every customer switch so stale tags from the previous conversation are never shown.
