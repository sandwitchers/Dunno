# Quick Edit

A SillyTavern extension that lets you select text in chat messages and quickly edit or delete specific parts — without using the built-in full-message editor.

## How It Works

1. Select / highlight any text in a chat message.
2. A floating toolbar with **edit** (pencil) and **delete** (trash) icons appears **below** the selection.
3. Click **edit** to modify just the selected text, or **delete** to remove it.
4. The message is updated in place and persisted to the chat.

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

### v0.2.0

**Bug fixes**

- **Toolbar now appears below the selection.** Previously it appeared above and collided with Android's native copy/share toolbar. It now defaults to below, flipping above only when there's no room.
- **Tapping the edit / delete buttons no longer closes the toolbar.** Buttons are now bound to `pointerdown` (with a `mousedown` fallback) instead of `click`, so the action fires before the browser clears the text selection. Previously, on mobile, the `selectionchange` event would wipe the saved range before `click` ran, so the edit popup never opened.
- **The edit textarea no longer auto-selects all its text.** The caret is now placed at the end of the text, so you can append, re-select, or use `Ctrl+A` yourself. Previously, `.select()` highlighted the entire textarea contents.
- **Edits are now actually persisted on reload.** The previous version wrote to `context.chat[i].mes_text`, which is not a real property on the SillyTavern chat object — edits appeared in the DOM but were lost on refresh. We now write to `context.chat[i].mes` (the canonical field) and mirror to `mes_text` for third-party compatibility.
- **Scroll handling now works on inner containers.** Previously `$(document).on("scroll")` missed scrolls on `#chat` and other inner scrollers (scroll events don't bubble). We now use the capture phase so any scroll dismisses the toolbar (unless the edit popup is open).

**UX / accessibility**

- Toolbar and popup gain a subtle pop-in animation (disabled under `prefers-reduced-motion`).
- Buttons gain `type="button"`, `aria-label`, and `role="toolbar"` / `role="dialog"` for screen-reader users.
- Touch targets enlarged on screens ≤480px.
- `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent` on all interactive elements to remove the 300ms tap delay and the blue flash.
- Textarea `font-size: 16px` to prevent iOS auto-zoom on focus.
- Edit popup clamps to `max-width: calc(100vw - 16px)` so it never overflows on narrow screens.

**Code quality (DX)**

- JSDoc comments on every public function and module-level state variable.
- Magic numbers (`250`, `500`) extracted into named constants (`SELECTION_DEBOUNCE_MS`, `UI_GRACE_MS`).
- Replaced `nodeType === 3` magic number with `Node.TEXT_NODE`.
- New helpers: `bindQuickAction`, `clearSelection`, `onScrollHide`.
- Safer `stopListening` that also unbinds button and internal pointerdown handlers (previously only `$(document).off(".qe")` ran, leaving button handlers orphaned if the user toggled the extension off then on).

### v0.1.0

- Initial release: floating toolbar, edit popup, enable/disable checkbox.
