/**
 * Quick Edit — SillyTavern / TauriTavern extension
 *
 * Select text in a chat message -> a small capsule appears beside the
 * selection's first line with Edit / Delete. Edits go into the raw message
 * source (see util.js). On/off lives in the burger (options) menu.
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
 *  - Edits replace text in raw `message.mes`, never rendered HTML; ambiguous
 *    selections are refused.
 *  - After a rollback `savedRange` points at detached nodes: invalidate it
 *    and hide the UI.
 *  - Placement: the capsule sits LEFT of the selection's first line, so it
 *    never overlaps ST's Clip/Extract pill (right side). Native touch handles
 *    hang under the line, hence the bigger gap on coarse pointers. If there
 *    is no room on the left it drops below the selection instead.
 *  - Narrow screens (<=600px) get a bottom sheet pinned to the visual
 *    viewport (rides above the keyboard).
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, saveChatDebounced } from "../../../../script.js";
import { replaceOnce } from "./util.js";

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

/** On/off toggle lives in the burger (options) menu. */
function addMenuItem() {
    if ($("#qe-menu-toggle").length) return;

    const $item = $(`
        <a id="qe-menu-toggle" role="menuitem">
            <i class="fa-lg fa-solid fa-pen-to-square"></i>
            <span></span>
        </a>
    `);
    const $anchor = $("#option_toggle_logprobs");
    const $host = $("#options .options-content");

    if ($anchor.length) {
        $anchor.after($item);
    } else if ($host.length) {
        $host.append($item);
    } else {
        console.warn(`[${extensionName}] Options menu not found; no on/off toggle available`);
        return;
    }

    $item.on("click", () => setEnabled(extension_settings[extensionName].enabled === false));
    updateMenuItem();
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
        if (currentIndex === -1) return;

        const nextIndex = e.shiftKey
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

    positionToolbar(savedRange);
    $toolbar.addClass("is-visible");
}

function positionToolbar(range) {
    if (!$toolbar || !range) return;

    // Preferred spot: on the selection's FIRST line, just LEFT of it, so the
    // capsule sits beside the text like [Edit Delete] [text] [Clip Extract].
    const rects = range.getClientRects();
    const first = rects.length ? rects[0] : range.getBoundingClientRect();
    const last = rects.length ? rects[rects.length - 1] : first;
    const vp = getViewportMetrics();
    const tbW = toolbarWidth;
    const tbH = toolbarHeight;
    const touch = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    const minX = vp.left + 4;
    const minY = vp.top + 4;
    const maxY = vp.top + vp.height - tbH - 4;

    let left = vp.left + first.left - (touch ? 12 : 8) - tbW;
    let top = vp.top + first.top + first.height / 2 - tbH / 2;

    if (left < minX) {
        // No room on the left (selection starts at the edge): drop below.
        left = Math.max(minX, Math.min(vp.left + first.left, vp.left + vp.width - tbW - 4));
        top = vp.top + last.bottom + (touch ? 28 : 10);
    }

    top = Math.max(minY, Math.min(top, maxY));
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

function captureMessageState(message) {
    const swipeIndex = typeof message?.swipe_id === "number" ? message.swipe_id : null;
    const swipeHtml = (
        Array.isArray(message?.swipes) &&
        swipeIndex !== null &&
        swipeIndex >= 0 &&
        swipeIndex < message.swipes.length
    ) ? message.swipes[swipeIndex] : null;

    return {
        mes: message?.mes ?? "",
        is_edited: Boolean(message?.is_edited),
        swipe_id: swipeIndex,
        swipe_html: swipeHtml
    };
}

function restoreMessageState(message, snapshot) {
    if (!message || !snapshot) return;

    message.mes = snapshot.mes;
    message.is_edited = snapshot.is_edited;

    if (
        Array.isArray(message.swipes) &&
        typeof snapshot.swipe_id === "number" &&
        snapshot.swipe_id >= 0 &&
        snapshot.swipe_id < message.swipes.length &&
        snapshot.swipe_html !== null &&
        snapshot.swipe_html !== undefined
    ) {
        message.swipes[snapshot.swipe_id] = snapshot.swipe_html;
    }
}

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

function registerDeleteUndo(idx, snapshot) {
    clearDeleteUndo();
    lastDeletedSnapshot = {
        idx,
        snapshot,
        createdAt: Date.now()
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

    restoreMessageState(message, snapshot);

    const mesEl = $("#chat .mes").eq(idx);
    const $mesText = mesEl.find(".mes_text");
    if ($mesText.length) {
        $mesText.html(snapshot.mes);
    }

    if (typeof context.updateMessageBlock === "function") {
        try {
            context.updateMessageBlock(idx, message);
        } catch (e) {
            console.warn(`[${extensionName}] updateMessageBlock failed during undo (non-fatal):`, e);
        }
    }

    if (typeof saveChatDebounced === "function") {
        saveChatDebounced();
    }

    clearDeleteUndo();
    notify("Delete undone.", "success");
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

    return chat.findIndex(m => String(m?.mesid) === String(mesIdAttr));
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

        if (Array.isArray(message.swipes) && typeof message.swipe_id === "number") {
            message.swipes[message.swipe_id] = nextMes;
        }

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
            registerDeleteUndo(idx, previousSnapshot);
        } else {
            clearDeleteUndo();
        }

        console.log(
            `[${extensionName}] Message ${idx} updated & saved ` +
            `(${previousSnapshot.mes.length} → ${nextMes.length} chars)`
        );
        return true;
    } catch (e) {
        console.error(`[${extensionName}] Persist failed, rolling back:`, e);
        restoreMessageState(message, previousSnapshot);
        if ($mesText.length) {
            $mesText.html(previousSnapshot.mes);
        }

        if (typeof context.updateMessageBlock === "function") {
            try {
                context.updateMessageBlock(idx, message);
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

        notify("The edit could not be saved and was rolled back.", "warning");
        return false;
    }
}

function onEditClick() {
    if (!savedRange || !currentMesEl) return;
    if (!isSelectionBoundToCurrentMessage()) {
        notify("Selection is no longer valid. Please select the text again.", "warning");
        return;
    }

    const mesId = $(currentMesEl).attr("mesid");
    const idx = parseInt(mesId, 10);
    const ctx = getContext();
    if (!isNaN(idx) && ctx?.chat?.[idx]?.streaming) {
        notify("Cannot edit a message that is still streaming", "warning");
        return;
    }

    clearDeleteUndo();

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

    const previousState = getCurrentMessageState();
    if (!previousState) return;

    const newText = String($("#qe-edit-textarea").val() ?? "");
    const nextMes = resolveRawEdit(savedRange.toString(), newText);
    if (nextMes === null) return;

    if (!applyRangeEdit(savedRange, newText)) {
        return;
    }

    if (!saveMessageChanges({ previousState, action: "edit", nextMes })) {
        // Persist failed and was rolled back. The DOM has been
        // restored to its pre-edit state, which means `savedRange`
        // now references DETACHED nodes (the rollback did
        // `$mesText.html(...)` which replaces all children).
        //
        // We MUST invalidate savedRange and close the popup —
        // otherwise the next Save click would run applyRangeEdit
        // against a Range pointing into a detached subtree, which
        // silently does nothing or corrupts the DOM. v0.5 left the
        // popup open here, which was a critical stuck-state bug.
        savedRange = null;
        currentMesEl = null;
        hideToolbar();
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

    const previousState = getCurrentMessageState();
    if (!previousState) return;

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
        hideToolbar();
        clearSelection();
        return;
    }

    hideToolbar();
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
 * Apply the edit to the message's RAW source (`mes`), not the rendered DOM.
 * Returns the new source, or null (with a toast) when the selection can't
 * be located exactly once. See replaceOnce() in util.js.
 */
function resolveRawEdit(selectedText, newText) {
    const message = getCurrentMessage();
    const next = message ? replaceOnce(String(message.mes ?? ""), selectedText, newText) : null;
    if (next === null) {
        notify("Couldn't match that selection in the message source. Try a slightly longer, plain-text phrase.", "warning");
    }
    return next;
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

    let top = vp.top + anchorBottom + gap;
    let left = vp.left + anchorLeft;

    if (top + popH > vp.top + vp.height - 4) top = vp.top + anchorTop - popH - gap;
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

        if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "z" && lastDeletedSnapshot) {
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
        addMenuItem();

        if (extension_settings[extensionName]?.enabled !== false) {
            startListening();
        }

        console.log(`[${extensionName}] ✅ Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Failed to load:`, error);
    }
});
