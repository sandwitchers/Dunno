# Quick Edit

A SillyTavern extension that lets you select text in chat messages and quickly edit or delete specific parts — without using the built-in full-message editor.

## How It Works

1. Select / highlight any text in a chat message.
2. A floating pill with **edit** (pencil) and **delete** (trash) appears **below** the selection (above it when there is no room below). On narrow screens (<=600px) the edit popup becomes a bottom sheet pinned above the keyboard.
3. Click **edit** to modify just the selected text, or **delete** to remove it.
4. The message is updated in place and persisted to the chat — the AI will see the edited text on the next turn.

Edits go into the raw message source, so the same word appearing twice in a message (for example in the story and inside a hidden `<UpdateVariable>` block) is matched using the text around your selection. A selection that appears more than once, or cannot be found in the source, is refused with a message instead of guessing.

## On / Off

Tap the **wand button** in the send form (bottom left, magic-wand icon) and use the **Quick Edit: On / Off** item. There is no settings panel.

## Installation

1. Open SillyTavern.
2. Extensions → Install Extension.
3. Paste GitHub URL: `https://github.com/sandwitchers/Dunno`
4. Refresh the page.

## Testing

Run the unit tests (pure logic in `util.js`, no framework needed):

```
node test.mjs
```

## Keyboard Shortcuts (in the edit popup)

| Key | Action |
|---|---|
| `Esc` | Cancel and close the popup |
| `Ctrl`/`Cmd` + `Enter` | Save the edit |
| `Ctrl`/`Cmd` + `Z` | Undo the last delete for a few seconds |

Delete cannot be used while the AI is streaming, and neither can edit.

## Changelog

### v0.8.1

- **Multi-paragraph selections can be edited now.** A selection spanning two rendered paragraphs (dialogue + narration, like the screenshot case) used to always answer "Couldn't find that text in the message source". Two causes, both fixed: the context reader threw both halves away when start and end sat in different paragraphs, and the matcher required the selection's single `\n` to equal the raw source's `\n\n` paragraph break. Matching is now line-break tolerant (runs of `\n` / `\r\n` collapse to one `\n` for matching, then map back to raw offsets), and the context is read per block. When the edit keeps the same line count, the original `\n\n` gap is preserved in the saved text; when the user adds or removes a line, their text wins as-is (a single `\n` still renders as a line break in SillyTavern, just without the blank gap).

### v0.8.0

- **Repeated words can be edited now.** The match uses the text around your selection, so a word that also appears inside a hidden `<UpdateVariable>` block no longer blocks the edit. Ambiguous and unfindable selections get separate messages.
- **Streaming guard is real.** The old check read `message.streaming`, a property that does not exist, so it never fired. It now reads SillyTavern's `streamingProcessor` and blocks Edit, Delete, and Save while streaming.
- **Undo is safe.** Undo checks the message is still the same text before restoring, and restores `swipe_id` too, so flipping swipes no longer makes undo look broken. Saving no longer writes `swipes[swipe_id]` without a range check.
- **Rollback / undo no longer write raw source into the DOM as HTML.** They re-render through SillyTavern's `updateMessageBlock` instead.
- **Pill is back below the selection.** Left-of-selection (v0.7.1) made holding a drag selection hard. The on/off toggle moved from the burger menu to the **Wand menu**.
- **Viewport math fixed for pinch-zoom.** Toolbar and popup no longer add the visual-viewport offset on top of client rects.
- **Small fixes:** failed Save / Delete restore focus, opening the edit popup no longer eats the delete-undo, Ctrl+Shift+Z is redo again, dead code removed (`example.html`, the `mesid` fallback, the unused `createdAt` field).
- **Note:** `saveChatDebounced()` cannot report a failed save, so the rollback only covers synchronous errors. A failed save on the server will not roll back.

### v0.7.1

- Pill sized to match Clip / Extract, no tail, quicker grow animation.

### v0.7.0

- Pill below selection, burger-menu on/off, settings panel removed.
- Capsule toolbar with tail, bottom-sheet editor above keyboard (v0.6.0).

### v0.5.2

- Edits go into the raw message source via `replaceOnce` (exact unique match only); the fake `mes_text` field is no longer written; rebind-safe toggle; tap-to-undo on the delete toast.

### v0.5.1

- Rollback invalidates `savedRange`; Save restores focus like Cancel; `aria-modal` is honest (toolbar hidden while the popup is open); undo toast no longer stacks.

### v0.5.0

- More defensive selection-to-message mapping; safe rollback on persistence failure; delete undo window; tighter popup keyboard behavior.

### v0.4.0

- Edit popup no longer closes when the Android keyboard appears (`onViewportChange` repositions instead of closing); `visualViewport` support; debounced viewport handler.

### v0.3.0

- Toolbar icons horizontal; edits actually reach the AI (`mesid` is the chat index); swipe sync; edited badge; `updateMessageBlock` call; HTML escaping; streaming guard; settings migration; dynamic toolbar measurement.

### v0.2.0

- Toolbar defaults to below the selection; buttons bound to `pointerdown`; removed `.select()` on textarea focus; wrote to `context.chat[i].mes`.

### v0.1.0

- Initial release: floating toolbar, edit popup, enable/disable checkbox.
