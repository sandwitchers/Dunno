# Quick Edit

A SillyTavern extension that lets you select text in chat messages and quickly edit or delete specific parts — without using the built-in full-message editor.

## How It Works

1. Select / highlight any text in a chat message.
2. A floating toolbar with **edit** (pencil) and **delete** (trash) icons appears **below** the selection.
3. Click **edit** to modify just the selected text, or **delete** to remove it.
4. The message is updated in place and persisted to the chat — the AI will see the edited text on the next turn.

## Installation

1. Open SillyTavern.
2. Extensions → Install Extension.
3. Paste GitHub URL: `https://github.com/sandwitchers/Dunno`
4. Refresh the page.

## Testing

Look for **Quick Edit** in Extensions settings (right panel).

## Keyboard Shortcuts (in the edit popup)

| Key | Action |
|---|---|
| `Esc` | Cancel and close the popup |
| `Ctrl`/`Cmd` + `Enter` | Save the edit |

## Changelog

### v0.3.0

**Bug fixes (user-reported)**

- **Toolbar icons are now horizontal, with comfortable spacing.** The root cause was subtle: the CSS declared `gap` and `align-items` on `#qe-toolbar` but never set `display:flex`. When jQuery's `.show()` set an inline `display:block`, the round buttons (each `display:flex` = block-level) stacked vertically. Fixed by toggling visibility with an `.is-visible` class that sets `display:flex !important`, making the buttons `display:inline-flex`, and increasing `gap` from `6px` to `12px`.
- **Edits now actually reach the AI.** The previous version used `findIndex(m => String(m.mesid) === String(mesId))` to locate the message in `context.chat`. But SillyTavern message objects **do not have a `mesid` field** — the DOM `mesid` attribute is the array index (see ST source: `chat[mesElement.attr('mesid')]`). `findIndex` always returned `-1`, so `saveMessageChanges()` silently bailed, `chat[i].mes` stayed at the old value, the context log showed the old text, and the AI received the old text. Fixed with `parseInt(mesId, 10)` as the array index, with a `findIndex` fallback for forward compatibility.

**Forward-thinking safeguards (proactive)**

- **Swipe sync.** If the edited message has swipes, the current swipe is now also updated (`message.swipes[message.swipe_id] = newHtml`). Without this, switching swipes would silently undo the edit.
- **Edited badge.** Sets `message.is_edited = true` so SillyTavern shows the standard "edited" indicator on the message.
- **`updateMessageBlock` call.** After persisting, calls ST's own `context.updateMessageBlock(idx, message)` so the DOM, token cache, and any other extensions that hook into message rendering all see the edit. Wrapped in try/catch so a future ST API change won't break the extension.
- **HTML escaping.** User-typed text is now HTML-escaped (`<` → `&lt;` etc.) before being inserted into the DOM. Typing `<script>` no longer corrupts the message. Newlines are converted to `<br>` so multi-line edits render as line breaks instead of being collapsed by HTML's default whitespace handling.
- **Streaming guard.** Refuses to edit a message that is currently being streamed (`message.streaming === true`), with a toastr warning. Editing a streaming message would race with ST's stream writer and silently lose the edit.
- **Settings migration.** Defaults are now merged with saved values (`{ ...defaults, ...saved }`) instead of only applied when the saved object is empty. Future-added settings will automatically get their default for existing users.
- **Dynamic dimension measurement.** Toolbar width/height are measured once after creation and cached, so `positionToolbar()` always uses the real size. Previously hardcoded `84×44` which drifted from the actual CSS.
- **Viewport resize handler.** Hides the toolbar on `resize` because the saved Range's bounding rect becomes stale. Previously the toolbar would float in the wrong spot after rotating the phone or resizing the window.
- **Defensive index validation.** `resolveMessageIndex()` checks `isNaN`, range bounds, and `null` message objects before touching `chat[idx]`, with detailed console errors for each failure mode.

**Code quality (DX)**

- Top-of-file design-notes block documenting every root cause and fix rationale — future maintainers don't need to re-derive the analysis.
- New helpers: `escapeHtml`, `resolveMessageIndex`, `notify`, `onResizeHide`.
- `notify()` wrapper uses `toastr` when available, falls back to `console.log` so messages are never lost.

### v0.2.0

- Toolbar defaults to below the selection (avoids Android native toolbar collision).
- Buttons bound to `pointerdown` (was `click`) — fixes "edit icon just closes" on mobile.
- Removed `.select()` on textarea focus — fixes "selects all the text" bug.
- Wrote to `context.chat[i].mes` (was `mes_text`).
- Capture-phase scroll listener for inner scrollers.

### v0.1.0

- Initial release: floating toolbar, edit popup, enable/disable checkbox.
