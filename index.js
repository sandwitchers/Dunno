/**
 * Quick Edit — SillyTavern / TauriTavern extension
 *
 * Select text in a chat message -> a small pill appears BELOW the
 * selection with Edit / Delete. Edits go into the raw message source
 * (see util.js). On/off lives in the Wand (extensions) menu.
 *
 * Root causes worth remembering when editing this file:
 *  - Visibility is a `.is-visible` class, never jQuery .show(): an inline
 *    display would break the flex row.
 *  - Buttons act on `pointerdown` (mousedown fallback): on touch, `click`
 *    arrives after `selectionchange` already wiped the saved Range.
 *    `lastUiInteraction` gives selectionchange a 500ms grace window.
 *  - Never close the edit popup on resize/scroll/selectionchange: the soft
 *    keyboard fires resize and would kill it while typing.
 *  - `mesid` equals the index into `chat[]`; message objects have no `mesid`.
 *  - Edits replace text in raw `message.mes`, never rendered HTML; the
 *    match is located with surrounding rendered context (util.js
 *    `locateEdit`), because the same word can appear twice in the source
 *    — once in the story, once inside a hidden <UpdateVariable> block.
 *    Ambiguous selections are refused; unfindable ones are refused too.
 *  - After a rollback `savedRange` points at detached nodes: invalidate it
 *    and hide the UI.
 *  - Placement: the pill sits BELOW the selection's last line (above it
 *    when there is no room below), so it never covers the text the user
 *    is holding to copy. Left-of-selection was tried in v0.7.1 and made
 *    holding a drag selection hard, so v0.8.0 puts it back below.
 *  - Streaming is a global signal, not a message flag: message objects
 *    have NO `.streaming` property. The real signal is
 *    `getContext().streamingProcessor` (null when idle).
 *  - `saveChatDebounced()` cannot report failure: the debounced save
 *    runs later and swallows errors, so the rollback in
 *    `saveMessageChanges` only covers synchronous errors. A failed save
 *    on the server will NOT roll back; do not claim otherwise.
 *  - Client rects and `position: fixed` share layout-viewport
 *    coordinates. Never add `visualViewport.offsetLeft/Top` to a
 *    rect-derived position — it double-counts under pinch-zoom. The
 *    offset belongs only in clamps to the visible area and in the
 *    bottom-sheet pin, which must follow the visual viewport above
 *    the keyboard.
 *  - Narrow screens (<=600px) get a bottom sheet pinned to the visual
 *    viewport (rides above the keyboard).
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, saveChatDebounced } from "../../../../script.js";
import {
    locateEdit,
    captureMessageState,
    restoreMessageState,
    writeCurrentSwipe,
    isUndoValid,
} from "./util.js";

const extensionName = "Dunno";

const defaultSettings = {
    enabled: true
};

// ── Internal state ──────────────────────────────────────────
/** @type {jQuery|null} floating toolbar element */
let $toolbar = null;
/** @type {jQuery|null} edit popup element */
let $editPopup = null;
/** @type {Range|null} snapshot of the user's last text selection */
let savedRange = null;
/** @type {jQuery|null} the .mes element that owns the selection */
let currentMesEl = null;
/** timestamp (ms) of the last pointerdown on toolbar / popup */
let lastUiInteraction = 0;
/** debounce handle for the `selectionchange` listener */
let selectionTimer = null;
/** debounce handle for viewport (resize / visualViewport) events */
let resizeTimer = null;
/** cached toolbar outer dimensions (measured once in createUI) */
let toolbarWidth = 96;
let toolbarHeight = 26;
/** previous focus target before opening the popup */
let previousFocusElement = null;
/** snapshot for delete undo */
let lastDeletedSnapshot = null;
/** timeout handle for delete undo expiration */
let lastDeleteUndoTimer = null;
/** clear function for the last undo toast, so we can dismiss it
 *  before showing a new one (prevents toast stacking on rapid
 *  deletes). */
let lastUndoToastClear = null;

const UI_GRACE_MS = 500;
const SELECTION_DEBOUNCE_MS = 250;
const DELETE_UNDO_MS = 5000;
/** shorter undo toast timeout — toast clears before the undo window
 *  expires so it doesn't sit there taunting the user. */
const UNDO_TOAST_MS = 4000;
/** viewport width (px) at or below which the edit popup is a bottom sheet */
const SHEET_MAX_WIDTH = 600;

/* =============================================================
   SETTINGS
   ============================================================= */

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const merged = { ...defaultSettings, ...extension_settings[extensionName] };
    extension_settings[extensionName] = merged;

    console.log(`[${extensionName}] Settings loaded:`, merged);
}

function setEnabled(value) {
    extension_settings[extensionName].enabled = value;
    saveSettingsDebounced();
    console.log(`[${extensionName}] enabled =`, value);
    if (value) {
        startListening();
    } else {
        stopListening();
    }
    updateMenuItem();
}

/**
 * On/off toggle lives in the Wand (extensions) menu: `#extensionsMenu`
 * is SillyTavern's dropdown under the wand button in the send form.
 * ST shows the wand button only while the menu has a visible child,
 * so our item being there is what makes the button appear.
 * Returns true when the item exists, false when the menu is not in
 * the DOM yet (the caller retries).
 */
function addMenuItem() {
    if ($("#qe-menu-toggle").length) return true;

    const $host = $("#extensionsMenu");
    if (!$host.length) return false;

    const $item = $(`
        <a id="qe-menu-toggle" role="menuitem">
            <i class="fa-lg fa-solid fa-pen-to-square"></i>
            <span></span>
        </a>
    `);
    $host.append($item);

    $item.on("click", () => setEnabled(extension_settings[extensionName].enabled === false));
    updateMenuItem();
    return true;
}

/** Retry the Wand menu item: the menu is built by ST core and may
 *  not exist yet when this extension loads. */
let menuRetryCount = 0;
function tryAddMenuItem() {
    if (addMenuItem()) return;
    menuRetryCount++;
    if (menuRetryCount >= 10) {
        console.warn(`[${extensionName}] Wand menu not found; no on/off toggle available`);
        return;
    }
    setTimeout(tryAddMenuItem, 500);
}

function updateMenuItem() {
    const on = extension_settings[extensionName]?.enabled !== false;
    $("#qe-menu-toggle").toggleClass("qe-off", !on).find("span").text(`Quick Edit: ${on ? "On" : "Off"}`);
}

/* =============================================================
   UI CREATION
   ============================================================= */

function createUI() {
    if ($("#qe-toolbar").length) return;

    $toolbar = $(`
        <div id="qe-toolbar" role="toolbar" aria-label="Quick edit toolbar">
            <button id="qe-edit-btn" class="qe-btn" type="button"
                    title="Edit selected text" aria-label="Edit selected text">
                <i class="fa-solid fa-pen" aria-hidden="true"></i><span>Edit</span>
            </button>
            <span class="qe-sep" aria-hidden="true"></span>
            <button id="qe-delete-btn" class="qe-btn" type="button"
                    title="Delete selected text" aria-label="Delete selected text">
                <i class="fa-solid fa-trash" aria-hidden="true"></i><span>Delete</span>
            </button>
        </div>
    `);

    $editPopup = $(`
        <div id="qe-edit-popup" role="dialog" aria-modal="true" aria-label="Edit selected text">
            <div class="qe-label">Selected text</div>
            <div id="qe-original"></div>
            <textarea id="qe-edit-textarea" aria-label="Edited text"
                      placeholder="Edit selected text..."></textarea>
            <div id="qe-popup-buttons">
                <button id="qe-cancel-btn" type="button">Cancel</button>
                <button id="qe-save-btn" type="button">Save changes</button>
            </div>
        </div>
    `);

    $("body").append($toolbar).append($editPopup);

    // Measure toolbar dimensions once while temporarily visible.
    $toolbar.css("visibility", "hidden").addClass("is-visible");
    toolbarWidth = $toolbar.outerWidth() || 96;
    toolbarHeight = $toolbar.outerHeight() || 26;
    $toolbar.removeClass("is-visible").css("visibility", "");

    bindQuickAction($("#qe-edit-btn"), onEditClick);
    bindQuickAction($("#qe-delete-btn"), onDeleteClick);
    // Cancel and Save both restore focus to the previously-focused
    // element. v0.5 only restored on Cancel — v0.5.1 makes both
    // paths consistent.
    bindQuickAction($("#qe-cancel-btn"), () => hideEditPopup({ restoreFocus: true }));
    bindQuickAction($("#qe-save-btn"), onEditSave);

    $toolbar.add($editPopup).on("pointerdown.qe-internal mousedown.qe-internal", () => {
        lastUiInteraction = Date.now();
    });

    // Popup keydown: only handle Tab (focus trap) and Ctrl+Enter
    // (save). Escape is handled ONCE in the global `keydown.qe`
    // handler in startListening() — having two Escape handlers
    // (popup + global) was dead-code duplication in v0.5.
    $editPopup.on("keydown.qe-internal", function (e) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onEditSave();
            return;
        }

        if (e.key !== "Tab") return;

        const focusables = $editPopup.find("#qe-edit-textarea, #qe-cancel-btn, #qe-save-btn").filter(":visible");
        if (!focusables.length) return;

        const currentIndex = focusables.index(document.activeElement);
        // Focus escaped the popup (e.g. a click outside the focusables):
        // pull it back to the first (Tab) or last (Shift+Tab) control
        // instead of letting Tab leave the modal dialog.
        const nextIndex = currentIndex === -1
            ? (e.shiftKey ? focusables.length - 1 : 0)
            : e.shiftKey
                ? (currentIndex - 1 + focusables.length) % focusables.length
                : (currentIndex + 1) % focusables.length;

        e.preventDefault();
        focusables.eq(nextIndex).trigger("focus");
    });
}

function bindQuickAction($el, handler) {
    const startEvent = window.PointerEvent ? "pointerdown" : "mousedown";
    let handled = false;

    $el.on(startEvent + ".qe-btn", function (e) {
        if (e.button && e.button !== 0) return;
        e.preventDefault();
        handled = true;
        lastUiInteraction = Date.now();
        handler.call(this, e);
        setTimeout(() => { handled = false; }, 500);
    });

    $el.on("click.qe-btn", function (e) {
        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
        } else if (e.detail === 0) {
            // Enter/Space fire a click with detail 0 and no pointerdown.
            handler.call(this, e);
        }
    });
}

/* =============================================================
   SELECTION DETECTION
   ============================================================= */

function getViewportMetrics() {
    const vv = window.visualViewport;
    return {
        left: vv ? vv.offsetLeft : 0,
        top: vv ? vv.offsetTop : 0,
        width: vv ? vv.width : window.innerWidth,
        height: vv ? vv.height : window.innerHeight
    };
}

function normalizeNode(node) {
    if (!node) return null;
    return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}

function handleSelection() {
    if (!extension_settings[extensionName]?.enabled) return;
    if ($editPopup && $editPopup.hasClass("is-visible")) return;

    const sel = window.getSelection();
    const hasSelection = !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;

    if (!hasSelection && Date.now() - lastUiInteraction < UI_GRACE_MS) {
        return;
    }

    if (!hasSelection) {
        hideToolbar();
        return;
    }

    const anchorNode = sel.anchorNode;
    if (!anchorNode) {
        hideToolbar();
        return;
    }

    const anchorEl = normalizeNode(anchorNode);
    if (!anchorEl) {
        hideToolbar();
        return;
    }

    const mesText = $(anchorEl).closest("#chat .mes_text");
    if (mesText.length === 0) {
        hideToolbar();
        return;
    }

    const anchorMes = $(anchorEl).closest(".mes");
    if (!anchorMes.length) {
        hideToolbar();
        return;
    }

    const focusNode = sel.focusNode;
    if (focusNode) {
        const focusEl = normalizeNode(focusNode);
        const focusMes = focusEl ? $(focusEl).closest(".mes") : $();
        if (focusMes.length && anchorMes.attr("mesid") !== focusMes.attr("mesid")) {
            hideToolbar();
            return;
        }
    }

    currentMesEl = anchorMes;

    try {
        savedRange = sel.getRangeAt(0).cloneRange();
    } catch (e) {
        hideToolbar();
        return;
    }

    // Show first: positionToolbar re-measures the pill while visible.
    $toolbar.addClass("is-visible");
    positionToolbar(savedRange);
}

function positionToolbar(range) {
    if (!$toolbar || !range) return;

    // Below the selection's LAST line: that is where the native touch
    // handles hang, and the pill never covers the text the user is
    // holding to copy. Flips above when there is no room below.
    // Re-measure here (the toolbar is visible by now): a theme or font
    // change after load would leave the cached size stale.
    toolbarWidth = $toolbar.outerWidth() || toolbarWidth;
    toolbarHeight = $toolbar.outerHeight() || toolbarHeight;

    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const vp = getViewportMetrics();
    const tbW = toolbarWidth;
    const tbH = toolbarHeight;
    const touch = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    const gap = touch ? 28 : 10;
    const minX = vp.left + 4;
    const minY = vp.top + 4;
    const maxX = vp.left + vp.width - tbW - 4;
    const maxY = vp.top + vp.height - tbH - 4;

    // Rect values and position:fixed share layout-viewport coordinates:
    // no vp.left/vp.top here, or the pill double-counts under pinch-zoom.
    let top = rect.bottom + gap;
    let left = rect.left;

    if (top + tbH > vp.top + vp.height - 4) {
        top = rect.top - tbH - gap;
    }

    top = Math.max(minY, Math.min(top, maxY));
    left = Math.max(minX, Math.min(left, maxX));
    $toolbar.css({ top: `${top}px`, left: `${left}px` });
}

/**
 * Hide the toolbar (and popup). Accepts an options object so callers
 * can request focus restoration — used by onEditSave to match
 * Cancel's behavior. Default is no focus restore for backward
 * compatibility with system-event callers (scroll/resize/mousedown).
 */
function hideToolbar({ restoreFocus = false } = {}) {
    if ($toolbar) $toolbar.removeClass("is-visible");
    hideEditPopup({ restoreFocus });
    savedRange = null;
    currentMesEl = null;
}

/* =============================================================
   EDIT & DELETE ACTIONS
   ============================================================= */

function isSelectionBoundToCurrentMessage() {
    if (!savedRange || !currentMesEl || !currentMesEl.length) return false;
    const mesNode = currentMesEl[0];
    const ancestor = normalizeNode(savedRange.commonAncestorContainer);
    return !!mesNode && !!ancestor && mesNode.contains(ancestor);
}

/* captureMessageState / restoreMessageState live in util.js now,
   so the tests can cover them (they are pure: no DOM, no ST). */

function clearDeleteUndo() {
    if (lastDeleteUndoTimer) {
        clearTimeout(lastDeleteUndoTimer);
        lastDeleteUndoTimer = null;
    }
    lastDeletedSnapshot = null;
    // Clear any pending undo toast so it doesn't outlive the undo
    // window and confuse the user.
    if (lastUndoToastClear) {
        try { lastUndoToastClear(); } catch (_) { /* ignore */ }
        lastUndoToastClear = null;
    }
}

function registerDeleteUndo(idx, snapshot, expectedMes) {
    clearDeleteUndo();
    // expectedMes is the message text right after the delete. Undo
    // refuses later if the message no longer matches it (see
    // isUndoValid in util.js): the index alone cannot tell whether
    // this is still the same message.
    lastDeletedSnapshot = {
        idx,
        snapshot,
        expectedMes
    };
    lastDeleteUndoTimer = setTimeout(() => {
        clearDeleteUndo();
    }, DELETE_UNDO_MS);

    // Single ephemeral toast — clears any prior undo toast first so
    // rapid deletes don't stack up a wall of notifications.
    lastUndoToastClear = notify(
        "Deleted. Tap here to undo (or Ctrl+Z).",
        "info",
        { timeOut: UNDO_TOAST_MS, onclick: undoLastDelete }
    );
}

function undoLastDelete() {
    if (!lastDeletedSnapshot) return false;

    const context = getContext();
    if (!context || !Array.isArray(context.chat)) {
        notify("Undo failed: chat context unavailable", "warning");
        clearDeleteUndo();
        return false;
    }

    const { idx, snapshot } = lastDeletedSnapshot;
    if (idx < 0 || idx >= context.chat.length) {
        notify("Undo failed: original message index is no longer valid", "warning");
        clearDeleteUndo();
        return false;
    }

    const message = context.chat[idx];
    if (!message) {
        notify("Undo failed: original message is no longer available", "warning");
        clearDeleteUndo();
        return false;
    }

    // The index alone cannot prove this is still the same message:
    // refuse when the text changed since the delete instead of
    // overwriting whatever now sits at this index.
    if (!isUndoValid(lastDeletedSnapshot, message)) {
        notify("That message changed since the delete, so undo is no longer available.", "warning");
        clearDeleteUndo();
        return false;
    }

    restoreMessageState(message, snapshot);

    // Re-render from the restored data. Never write snapshot.mes into
    // the DOM with .html(): it is raw markdown source, not rendered
    // HTML, and any tag inside it would be parsed as HTML.
    let rendered = false;
    if (typeof context.updateMessageBlock === "function") {
        try {
            context.updateMessageBlock(idx, message);
            rendered = true;
        } catch (e) {
            console.warn(`[${extensionName}] updateMessageBlock failed during undo (non-fatal):`, e);
        }
    }

    if (typeof saveChatDebounced === "function") {
        saveChatDebounced();
    }

    clearDeleteUndo();
    notify(
        rendered ? "Delete undone." : "Delete undone, but the message on screen is stale. Reload the chat to refresh.",
        rendered ? "success" : "warning"
    );
    return true;
}

function resolveMessageIndex(mesIdAttr, chat, mesEl) {
    const direct = parseInt(mesIdAttr, 10);
    if (!isNaN(direct) && direct >= 0 && direct < chat.length) {
        return direct;
    }

    const domIdx = mesEl?.length ? $("#chat .mes").index(mesEl[0]) : -1;
    if (domIdx >= 0 && domIdx < chat.length) {
        return domIdx;
    }

    // No further fallback: message objects have no `mesid` field (the
    // DOM `mesid` is the array index), so a findIndex on it could
    // never match.
    return -1;
}

function applyRangeEdit(range, newText) {
    try {
        const sel = window.getSelection();
        if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
        }

        range.deleteContents();

        if (newText.length > 0) {
            const html = escapeHtml(newText).replace(/\n/g, "<br>");
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = html;
            const fragment = document.createDocumentFragment();
            while (tempDiv.firstChild) {
                fragment.appendChild(tempDiv.firstChild);
            }
            range.insertNode(fragment);
        }

        const common = range.commonAncestorContainer;
        if (common && typeof common.normalize === "function") {
            common.normalize();
        }

        return true;
    } catch (e) {
        console.error(`[${extensionName}] applyRangeEdit failed:`, e);
        notify("Could not apply the edit to the selected text.", "warning");
        return false;
    }
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function saveMessageChanges({ previousState = null, action = "edit", nextMes } = {}) {
    if (!currentMesEl || typeof nextMes !== "string") return false;

    const mesIdAttr = $(currentMesEl).attr("mesid");
    if (mesIdAttr === undefined) {
        console.error(`[${extensionName}] No mesid found on element`, currentMesEl);
        notify("Could not resolve the selected message.", "warning");
        return false;
    }

    const context = getContext();
    if (!context || !Array.isArray(context.chat)) {
        console.error(`[${extensionName}] getContext() or chat array unavailable`);
        notify("Could not access SillyTavern chat data.", "warning");
        return false;
    }

    const idx = resolveMessageIndex(mesIdAttr, context.chat, currentMesEl);
    if (idx === -1) {
        console.error(
            `[${extensionName}] Could not resolve mesid "${mesIdAttr}" to a chat index ` +
            `(chat length: ${context.chat.length})`
        );
        notify("Could not map the selected text back to a chat message.", "warning");
        return false;
    }

    const message = context.chat[idx];
    if (!message) {
        console.error(`[${extensionName}] chat[${idx}] is null/undefined`);
        notify("Selected chat message is no longer available.", "warning");
        return false;
    }

    const $mesText = $(currentMesEl).find(".mes_text");
    if ($mesText.length === 0) {
        console.error(`[${extensionName}] .mes_text not found inside message element`);
        notify("Could not find the editable text block for this message.", "warning");
        return false;
    }

    const previousSnapshot = previousState || captureMessageState(message);

    try {
        message.mes = nextMes;
        message.is_edited = true;

        writeCurrentSwipe(message, nextMes);

        if (typeof context.updateMessageBlock === "function") {
            try {
                context.updateMessageBlock(idx, message);
            } catch (e) {
                console.warn(`[${extensionName}] updateMessageBlock failed (non-fatal):`, e);
            }
        }

        if (typeof saveChatDebounced === "function") {
            saveChatDebounced();
        } else {
            throw new Error("saveChatDebounced not available");
        }

        if (action === "delete") {
            registerDeleteUndo(idx, previousSnapshot, nextMes);
        } else {
            clearDeleteUndo();
        }

        console.log(
            `[${extensionName}] Message ${idx} updated & saved ` +
            `(${previousSnapshot.mes.length} → ${nextMes.length} chars)`
        );
        return true;
    } catch (e) {
        // This only runs on a SYNCHRONOUS error (bad state, a throw
        // from the lines above). saveChatDebounced() cannot report an
        // async save failure, so a failed save on the server does NOT
        // reach this rollback — do not claim otherwise.
        console.error(`[${extensionName}] Edit failed, rolling back:`, e);
        restoreMessageState(message, previousSnapshot);

        // Never write the snapshot into the DOM with .html(): it is raw
        // markdown source, not rendered HTML. Re-render from data.
        let rendered = false;
        if (typeof context.updateMessageBlock === "function") {
            try {
                context.updateMessageBlock(idx, message);
                rendered = true;
            } catch (rollbackError) {
                console.warn(`[${extensionName}] rollback updateMessageBlock failed:`, rollbackError);
            }
        }

        if (typeof saveChatDebounced === "function") {
            try {
                saveChatDebounced();
            } catch (saveError) {
                console.warn(`[${extensionName}] rollback saveChatDebounced failed:`, saveError);
            }
        }

        notify(
            rendered
                ? "The edit could not be saved and was rolled back."
                : "The edit could not be saved and was rolled back. Reload the chat to refresh.",
            "warning"
        );
        return false;
    }
}

/**
 * True while the AI is streaming a reply. Streaming is a GLOBAL
 * signal: message objects have NO `.streaming` property, so the old
 * `chat[idx].streaming` check never fired. The real signal is
 * `getContext().streamingProcessor` (null when idle).
 */
function isStreaming() {
    const ctx = getContext();
    const sp = ctx?.streamingProcessor;
    return !!sp && !sp.isFinished && !sp.isStopped;
}

function onEditClick() {
    if (!savedRange || !currentMesEl) return;
    if (!isSelectionBoundToCurrentMessage()) {
        notify("Selection is no longer valid. Please select the text again.", "warning");
        return;
    }

    if (isStreaming()) {
        notify("Cannot edit a message that is still streaming", "warning");
        return;
    }

    // Capture focus BEFORE opening the popup so we can restore it on
    // both Save and Cancel paths (v0.5.1 consistency fix).
    previousFocusElement = document.activeElement;

    const $textarea = $("#qe-edit-textarea");
    $textarea.val(savedRange.toString());
    $("#qe-original").text(savedRange.toString());

    positionEditPopup();

    // ARIA honesty: hide the toolbar while the popup is open.
    // `aria-modal="true"` on the popup promises screen readers that
    // nothing else is interactive; leaving the toolbar visible was
    // a WCAG violation in v0.5.
    if ($toolbar) $toolbar.removeClass("is-visible");

    const ta = $textarea[0];
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
}

function onEditSave() {
    if (!savedRange || !currentMesEl) return;
    if (!isSelectionBoundToCurrentMessage()) {
        notify("Selection changed before saving. Please try again.", "warning");
        return;
    }

    // Re-check here, not just on Edit click: the stream may have
    // started while the popup was open.
    if (isStreaming()) {
        notify("Cannot edit a message that is still streaming", "warning");
        return;
    }

    const previousState = getCurrentMessageState();
    if (!previousState) {
        notify("That message is no longer available.", "warning");
        return;
    }

    const newText = String($("#qe-edit-textarea").val() ?? "");
    const nextMes = resolveRawEdit(savedRange.toString(), newText);
    if (nextMes === null) return;

    if (!applyRangeEdit(savedRange, newText)) {
        return;
    }

    if (!saveMessageChanges({ previousState, action: "edit", nextMes })) {
        // Persist failed and was rolled back. The DOM has been
        // restored to its pre-edit state, which means `savedRange`
        // now references DETACHED nodes (the rollback re-rendered
        // the message block, which replaces all children).
        //
        // We MUST invalidate savedRange and close the popup —
        // otherwise the next Save click would run applyRangeEdit
        // against a Range pointing into a detached subtree, which
        // silently does nothing or corrupts the DOM. v0.5 left the
        // popup open here, which was a critical stuck-state bug.
        savedRange = null;
        currentMesEl = null;
        hideToolbar({ restoreFocus: true });
        clearSelection();
        return;
    }

    // Save succeeded — restore focus to the previously-focused
    // element (the chat, usually) for parity with Cancel.
    hideToolbar({ restoreFocus: true });
    clearSelection();
}

function onDeleteClick() {
    if (!savedRange || !currentMesEl) return;
    if (!isSelectionBoundToCurrentMessage()) {
        notify("Selection changed before deleting. Please try again.", "warning");
        return;
    }

    if (isStreaming()) {
        notify("Cannot delete text from a message that is still streaming", "warning");
        return;
    }

    const previousState = getCurrentMessageState();
    if (!previousState) {
        notify("That message is no longer available.", "warning");
        return;
    }

    const nextMes = resolveRawEdit(savedRange.toString(), "");
    if (nextMes === null) return;

    if (!applyRangeEdit(savedRange, "")) {
        return;
    }

    if (!saveMessageChanges({ previousState, action: "delete", nextMes })) {
        // Same rollback rationale as onEditSave: savedRange is now
        // pointing into detached DOM, must invalidate.
        savedRange = null;
        currentMesEl = null;
        hideToolbar({ restoreFocus: true });
        clearSelection();
        return;
    }

    hideToolbar({ restoreFocus: true });
    clearSelection();
}

function getCurrentMessage() {
    if (!currentMesEl) return null;

    const mesIdAttr = $(currentMesEl).attr("mesid");
    if (mesIdAttr === undefined) return null;

    const context = getContext();
    if (!context || !Array.isArray(context.chat)) return null;

    const idx = resolveMessageIndex(mesIdAttr, context.chat, currentMesEl);
    return idx === -1 ? null : (context.chat[idx] ?? null);
}

function getCurrentMessageState() {
    const message = getCurrentMessage();
    return message ? captureMessageState(message) : null;
}

/**
 * Rendered text around the saved selection, for locating it in the
 * raw source. Takes up to 100 chars each side from the selection's
 * nearest block element (a <p>, a <div>, or .mes_text itself).
 * Falls back to empty context when the DOM cannot give it: locateEdit
 * then behaves like an exact-match search.
 */
function getSelectionContext(range) {
    try {
        const startEl = normalizeNode(range.startContainer);
        const blockEl = startEl?.closest("p, div, li, h1, h2, h3, h4, blockquote, pre") || null;
        if (!blockEl) return { before: "", after: "" };
        const readRange = (startNode, startOffset, endNode, endOffset) => {
            const r = document.createRange();
            r.setStart(startNode, startOffset);
            r.setEnd(endNode, endOffset);
            return r.toString();
        };
        const before = readRange(blockEl, 0, range.startContainer, range.startOffset).slice(-100);
        const after = readRange(range.endContainer, range.endOffset, blockEl, blockEl.childNodes.length).slice(0, 100);
        return { before, after };
    } catch (e) {
        return { before: "", after: "" };
    }
}

/**
 * Apply the edit to the message's RAW source (`mes`), not the rendered DOM.
 * Returns the new source, or null (with a toast) when the selection can't
 * be located exactly once. See locateEdit() in util.js: the same word can
 * appear twice in the source (story + hidden <UpdateVariable> block), so
 * the surrounding rendered text is used to pick the right occurrence.
 */
function resolveRawEdit(selectedText, newText) {
    const message = getCurrentMessage();
    if (!message) return null;
    const source = String(message.mes ?? "");
    const context = savedRange ? getSelectionContext(savedRange) : { before: "", after: "" };
    const loc = locateEdit(source, selectedText, context.before, context.after);
    if (loc.error === "ambiguous") {
        notify("That text appears more than once. Select a slightly longer phrase.", "warning");
        return null;
    }
    if (loc.error === "notfound") {
        notify("Couldn't find that text in the message source (formatting?). Select a plainer phrase.", "warning");
        return null;
    }
    return source.slice(0, loc.start) + newText + source.slice(loc.end);
}

function clearSelection() {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
}

/* =============================================================
   EDIT POPUP
   ============================================================= */

function positionEditPopup() {
    if (!$editPopup) return;
    const vp = getViewportMetrics();
    const gap = 8;
    const sheet = vp.width <= SHEET_MAX_WIDTH;

    $editPopup
        .toggleClass("is-sheet", sheet)
        .css("width", sheet ? `${vp.width - 16}px` : "")
        .addClass("is-visible");

    const popW = $editPopup.outerWidth() || 320;
    const popH = $editPopup.outerHeight() || 180;

    if (sheet) {
        // Pin to the bottom of the VISUAL viewport (above the keyboard).
        $editPopup.css({
            top: `${Math.max(vp.top + 8, vp.top + vp.height - popH - 8)}px`,
            left: `${vp.left + 8}px`
        });
        return;
    }

    // The toolbar may have been hidden (aria-modal honesty in
    // onEditClick). Use its last-known rect if available, otherwise
    // anchor the popup to the selection's vertical center.
    let anchorTop, anchorLeft, anchorBottom;
    if ($toolbar && $toolbar.hasClass("is-visible")) {
        const tbRect = $toolbar[0].getBoundingClientRect();
        anchorTop = tbRect.top;
        anchorBottom = tbRect.bottom;
        anchorLeft = tbRect.left;
    } else if (savedRange) {
        const r = savedRange.getBoundingClientRect();
        anchorTop = r.top;
        anchorBottom = r.bottom;
        anchorLeft = r.left + (r.width / 2) - (popW / 2);
    } else {
        anchorTop = vp.top + (vp.height / 2) - (popH / 2);
        anchorBottom = anchorTop;
        anchorLeft = vp.left + (vp.width / 2) - (popW / 2);
    }

    // Rect values and position:fixed share layout-viewport coordinates,
    // so no vp.top/vp.left on the anchor-derived position — it would
    // double-count under pinch-zoom. vp.* stays in the clamps below
    // (the visible area, in the same coordinates) and in the sheet pin.
    let top = anchorBottom + gap;
    let left = anchorLeft;

    if (top + popH > vp.top + vp.height - 4) top = anchorTop - popH - gap;
    if (top < vp.top + 4) top = vp.top + 4;
    if (left + popW > vp.left + vp.width - 4) left = vp.left + vp.width - popW - 4;
    if (left < vp.left + 4) left = vp.left + 4;

    $editPopup.css({ top: `${top}px`, left: `${left}px` });
}

function hideEditPopup({ restoreFocus = false } = {}) {
    if ($editPopup) $editPopup.removeClass("is-visible");
    if (restoreFocus) {
        restorePreviousFocus();
    }
}

function restorePreviousFocus() {
    const target = previousFocusElement;
    previousFocusElement = null;

    if (!target || typeof target.focus !== "function") {
        return;
    }

    if (!document.contains(target)) {
        return;
    }

    try {
        target.focus({ preventScroll: true });
    } catch (e) {
        try {
            target.focus();
        } catch (_) {
            // ignore
        }
    }
}

/* =============================================================
   UTILITIES
   ============================================================= */

/**
 * Show a toastr notification if toastr is available (SillyTavern
 * always loads it). Falls back to console.log so the message is
 * never lost.
 *
 * @param {string} message - text to show
 * @param {string} [type="info"] - toastr method name (info/success/warning/error)
 * @param {object} [overrides] - extra toastr options (e.g. {timeOut})
 * @returns {function|null} a clear function (to dismiss the toast
 *   programmatically) when toastr is available; otherwise null.
 */
function notify(message, type = "info", overrides = {}) {
    try {
        if (typeof toastr !== "undefined" && typeof toastr[type] === "function") {
            const toast = toastr[type](message, "", overrides);
            // toastr returns a jQuery-wrapped toast element; expose a
            // clear helper so callers can dismiss it before timeout.
            if (toast && typeof toastr.clear === "function") {
                return () => {
                    try { toastr.clear(toast); } catch (_) { /* ignore */ }
                };
            }
            return null;
        }
    } catch (e) {
        // fall through
    }
    console.log(`[${extensionName}] ${type}: ${message}`);
    return null;
}

/* =============================================================
   EVENT LISTENERS
   ============================================================= */

function onSelectionChangeHandler() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(handleSelection, SELECTION_DEBOUNCE_MS);
}

function onScrollHide() {
    if (
        $toolbar && $toolbar.hasClass("is-visible") &&
        $editPopup && !$editPopup.hasClass("is-visible")
    ) {
        hideToolbar();
    }
}

function onViewportChange() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if ($editPopup && $editPopup.hasClass("is-visible")) {
            repositionPopupForViewport();
            return;
        }
        if ($toolbar && $toolbar.hasClass("is-visible")) {
            hideToolbar();
        }
    }, 150);
}

function repositionPopupForViewport() {
    if (!$editPopup || !$editPopup.hasClass("is-visible")) return;

    const vp = getViewportMetrics();
    if (vp.width <= SHEET_MAX_WIDTH) {
        positionEditPopup(); // re-pin the sheet above the keyboard
        return;
    }
    const rect = $editPopup[0].getBoundingClientRect();

    if (
        rect.top >= vp.top + 4 &&
        rect.bottom <= vp.top + vp.height - 4 &&
        rect.left >= vp.left + 4 &&
        rect.right <= vp.left + vp.width - 4
    ) {
        return;
    }

    const popW = $editPopup.outerWidth() || 320;
    const popH = $editPopup.outerHeight() || 180;

    let top = Math.max(vp.top + 4, vp.top + (vp.height - popH) / 2);
    let left = Math.max(vp.left + 4, vp.left + (vp.width - popW) / 2);

    $editPopup.css({ top: `${top}px`, left: `${left}px` });
}

function startListening() {
    $(document).on("mouseup.qe", function (e) {
        if ($(e.target).closest("#qe-toolbar, #qe-edit-popup").length) return;
        setTimeout(handleSelection, 10);
    });

    document.addEventListener("selectionchange", onSelectionChangeHandler);

    $(document).on("mousedown.qe", function (e) {
        if (!$(e.target).closest("#qe-toolbar, #qe-edit-popup, #chat .mes_text").length) {
            hideToolbar();
        }
    });

    $(document).on("keydown.qe", function (e) {
        if (e.key === "Escape") {
            if ($editPopup && $editPopup.hasClass("is-visible")) {
                hideEditPopup({ restoreFocus: true });
            } else {
                hideToolbar();
            }
            return;
        }

        const target = e.target;
        if ($(target).closest("#qe-edit-popup, input, textarea, [contenteditable='true']").length) {
            return;
        }

        // Ctrl+Shift+Z is redo, not undo: let it pass through.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === "z" && lastDeletedSnapshot) {
            e.preventDefault();
            undoLastDelete();
        }
    });

    window.addEventListener("scroll", onScrollHide, true);
    window.addEventListener("resize", onViewportChange);
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", onViewportChange);
        window.visualViewport.addEventListener("scroll", onViewportChange);
    }
}

function stopListening() {
    $(document).off(".qe");
    // Button/popup handlers are bound once in createUI(); only the
    // document/window listeners from startListening() are removed here.
    window.removeEventListener("scroll", onScrollHide, true);
    window.removeEventListener("resize", onViewportChange);
    if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onViewportChange);
        window.visualViewport.removeEventListener("scroll", onViewportChange);
    }
    document.removeEventListener("selectionchange", onSelectionChangeHandler);
    clearTimeout(selectionTimer);
    clearTimeout(resizeTimer);
    clearDeleteUndo();
    hideToolbar();
}

/* =============================================================
   INIT
   ============================================================= */

jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);

    try {
        loadSettings();
        createUI();
        tryAddMenuItem();

        if (extension_settings[extensionName]?.enabled !== false) {
            startListening();
        }

        console.log(`[${extensionName}] ✅ Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Failed to load:`, error);
    }
});
