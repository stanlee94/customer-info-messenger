# AI Rewrite Button Bar

`#cim-ai-buttons` is a `<div>` injected directly into Facebook's chat composer area — **not** inside `#cim-purchase-panel`. It appears between the text-input row and the emoji/attachment toolbar row.

## Lifecycle

`ensureAiButtons()` is called from the debounced `scheduleCheck()` callback. It exits immediately if `document.contains(existing)` is true, so the buttons survive DOM mutations without flickering. They are only re-created when Facebook's SPA fully removes the composer (e.g. on conversation switch). `updateAiButtonState()` is also called every debounce cycle to dim/enable the buttons based on whether the reply box is empty.

**Health check** — on the first `ensureAiButtons()` call, `GET_AI_HEALTH` is sent to `background.js` which calls `GET <aiApiUrl>/ai/health`. The result is cached in the module-level `aiHealthy` flag (`null` = unchecked, `true`/`false` = result). Buttons are only created if `{ ok: true }` is returned. A second module-level flag `aiHealthPending` prevents duplicate in-flight checks.

**Button layout** (left → right): `↩` back button | `✨ AI Rewrite` | `华语 / English` language toggle

**Module-level state**: `aiHealthy` (`null`/`true`/`false`), `aiHealthPending` (bool), `aiLanguage` (`'chinese'`/`'english'`, defaults to `'chinese'`).

## Finding the reply box

`findMessengerReplyBox()`:
1. `[data-lexical-editor="true"]` whose `aria-placeholder` contains `"Messenger"` or `"Reply"` (primary — confirmed against live DOM).
2. `[contenteditable="true"]` with matching `aria-placeholder` (fallback).

`findComposerInsertionPoint()` walks up from the reply box until it finds an ancestor with `width > 200 px`, `60 px < height < 150 px`, and a `nextElementSibling` (the toolbar row). That element is the input row; inserting after it places our div between input and toolbar.

## Empty vs filled detection (Lexical-specific DOM)

- **Empty**: `<br data-lexical-managed-linebreak="true">` present in the editor.
- **Filled**: `<span data-lexical-text="true">user text</span>` present.

`isReplyBoxEmpty()` queries `br[data-lexical-managed-linebreak]`. Buttons are `disabled` (opacity 0.45) when the box is empty.

**Reading reply box text** — `getReplyBoxText()` collects all `[data-lexical-text="true"]` spans and joins their `textContent`.

**Clearing the reply box** — `clearReplyBox()` targets `[contenteditable="true"][role="textbox"]` directly. It deletes character-by-character: for each character (`textContent.length + 2` iterations to catch invisible zero-width chars), it collapses the selection to the end then fires `keydown Backspace` → `beforeinput deleteContentBackward` → `execCommand('delete')` → `input deleteContentBackward` → `keyup Backspace`. Returns `false` if the editor is not found.

Do **not** attempt select-all + single delete for Lexical — it ignores browser-level non-collapsed selections for delete operations.

**Inserting text** — `insertTextIntoMessenger(text)` handles multiline AI responses:
1. Normalises `\\n` escape sequences and `\r\n` to `\n`.
2. Builds a `DataTransfer` with `text/plain` set to the cleaned text.
3. Dispatches a synthetic `ClipboardEvent('paste')` on the editor — Lexical intercepts this natively and converts `\n` into its internal line breaks without triggering Enter (which would send the message). Do **not** use Shift+Enter simulation or `insertLineBreak` execCommand — the paste approach is the only reliable method.

**Prepend text** — `injectTextIntoReplyBox(text)` (used by other features, not AI buttons):
- *Empty*: `box.focus()` then `execCommand('insertText', false, text)`.
- *Filled*: moves the cursor to offset 0 of the first `[data-lexical-text="true"]` span via the Selection/Range API, then `execCommand('insertText', false, text + ' ')`.

## Language toggle

A segmented control (`cim-ai-lang`) with two chips: `华语` (`chinese`) and `English` (`english`). Styled as an iOS-style segmented control: active chip is a **white pill with a subtle drop shadow**; inactive chips are `#65676b` text on transparent background. This keeps it visually distinct from the panel's green ManyChat lang-tag toggle. Chips have `role="button"`, `tabindex="0"`, `aria-pressed`, and a `keydown` handler for Enter/Space keyboard activation. Selection is stored in the module-level `aiLanguage` variable (defaults to `'chinese'`; persists across conversation switches, resets on page reload).

## Click behaviour (✨ AI Rewrite)

1. Read current reply box text via `getReplyBoxText()`. If empty, do nothing.
2. Save text to `chrome.storage.local` as `aiLastInput`.
3. Only after the storage write completes, send `{ messages: [text], mode: 'quick', language: aiLanguage }` as `AI_REPLY` to `background.js` → `POST <aiApiUrl>/ai/reply`.
4. All action buttons dim immediately; the clicked button adds `.cim-ai-btn--loading`: `color: transparent` hides the button text; a `::after` spinner is absolutely centered (`position:absolute; top/left 50%; translate(-50%,-50%)`). No status text.
5. On `{ ok: true, text }`: call `clearReplyBox()` then `insertTextIntoMessenger(text)`.
6. On complete (success or error): remove `.cim-ai-btn--loading`, re-enable buttons.

## Back button (↩)

White pill with `1px solid #d8dadf` border (`aria-label="Restore previous text"`):
- Always starts enabled. `updateAiButtonState()` dims it (along with all `.cim-ai-btn`) when the reply box is empty.
- Clicking it reads `aiLastInput` from `chrome.storage.local`. If found, calls `clearReplyBox()` then `insertTextIntoMessenger(aiLastInput)` to restore the text before the last AI rewrite.
- If `aiLastInput` is not set (no AI call made yet in this session), the click is a no-op.

## Backend contract

```
GET <aiApiUrl>/ai/health
Authorization: Bearer <aiApiToken>   (omitted if token not set)
→ { "ok": true }

POST <aiApiUrl>/ai/reply
Authorization: Bearer <aiApiToken>   (omitted if token not set)
Content-Type: application/json
{ "messages": ["the text from the reply box"], "mode": "quick", "language": "chinese" | "english" }
→ { "ok": true, "text": "AI reply text" }
→ { "ok": false, "error": "reason" }
```

`mode` is always `"quick"`. `language` reflects the user's selected language toggle (defaults to `"chinese"`). `messages` is always a single-element array containing whatever the agent typed. The model choice and system prompt live entirely on the backend.
