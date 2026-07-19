/**
 * Quick Edit — SillyTavern third-party extension
 *
 * Lets the user select any portion of a chat message and edit / delete
 * just that portion via a floating toolbar, without opening SillyTavern's
 * full-message editor.
 *
 * ═══════════════════════════════════════════════════════════════
 *  DESIGN NOTES & ROOT-CAUSE LOG (read before touching this file)
 * ═══════════════════════════════════════════════════════════════
 *
 *  1. TOOLBAR LAYOUT — must stay horizontal.
 *     The toolbar is a flex container. We toggle visibility with a
 *     `.is-visible` class (NOT jQuery `.show()/.hide()`), because
 *     `.show()` sets `display:block` inline — overriding the CSS
 *     `display:flex` and causing the round buttons to stack VERTICALLY.
 *
 *  2. TOOLBAR POSITION — defaults to BELOW the selection.
 *     Android's native text-action toolbar always appears ABOVE the
 *     selection, so an above-ours would collide with it. We only
 *     flip above when there's no room below.
 *
 *  3. BUTTON EVENTS — `pointerdown`, not `click`.
 *     On touch devices, `click` is delayed long enough for
 *     `selectionchange` to fire and wipe the saved Range before the
 *     click handler runs. Binding to `pointerdown` (with `mousedown`
 *     fallback) fires BEFORE the browser clears the selection. A
 *     `lastUiInteraction` grace window (500ms) makes `selectionchange`
 *     ignore transient focus-shift events after a toolbar tap.
 *
 *  4. TEXTAREA FOCUS — no `.select()`.
 *     `.select()` highlighted the entire textarea contents, which the
 *     user reported as "selecting all the text". Caret is now placed
 *     at the end via `setSelectionRange(len, len)`.
 *
 *  5. MESSAGE PERSISTENCE — the critical fix.
 *     SillyTavern's `chat` array is indexed by position. The DOM
 *     `mesid` attribute equals that array index (see ST source:
 *     `chat[mesElement.attr('mesid')]`).
 *
 *     v0.1 wrote to `chat[i].mes_text` (not a real field — edits
 *     vanished on reload).
 *     v0.2 wrote to `chat[i].mes` but used
 *         `findIndex(m => String(m.mesid) === String(mesId))`
 *     which ALWAYS returned -1 because message objects don't have a
 *     `mesid` property. `saveMessageChanges()` silently bailed, so
 *     `chat[i].mes` stayed at the old value → context log showed
 *     old text → AI received old text.
 *
 *     v0.5 (this version) resolves the message index more defensively,
 *     saves through ST's own update pipeline, and rolls back the DOM if
 *     persist fails so the user never loses the original message.
 *
 *  6. HTML SAFETY — user-typed text is HTML-escaped before insert.
 *     `&` `<` `>` are escaped; `\n` is converted to `<br>` so
 *     multi-line edits render as line breaks (not literal `\n`).
 *     Without this, typing `<script>` or a newline would corrupt the
 *     message DOM.
 *
 *  7. STREAMING GUARD — editing a message that is currently being
 *     streamed would race with ST's stream writer. We refuse the edit
 *     with a toastr warning instead.
 *
 *  8. SETTINGS MIGRATION — defaults are merged with saved values
 *     (`{ ...defaults, ...saved }`) instead of only applied when the
 *     saved object is empty. This means we can add new settings in
 *     the future without breaking existing users.
 *
 *  9. VIEWPORT CHANGES (KEYBOARD) — CRITICAL FIX in v0.4.
 *     On mobile, the soft keyboard appearing fires `resize` AND
 *     `visualViewport.resize` events. v0.3's `onResizeHide` closed
 *     the popup on these events, which meant every attempt to type
 *     in the edit textarea was immediately killed by the keyboard
 *     appearing — the most frustrating bug in the extension.
 *
 *     v0.4 NEVER closes the popup on viewport changes. It only
 *     repositions the popup if it's off-screen, using
 *     `visualViewport` for keyboard-aware positioning. The toolbar
 *     (without popup) is still hidden on resize because its saved
 *     Range rect is stale.
 *
 * 10. POPUP INVARIANCE — the edit popup is only closed by explicit
 *     user actions: Save, Cancel, Escape, or clicking outside.
 *     System events (resize, scroll, selectionchange) NEVER close
 *     the popup. This is enforced by every handler checking
 *     `$editPopup.hasClass("is-visible")` before touching the popup.
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, saveChatDebounced } from "../../../../script.js";

const extensionName = "Dunno";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

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
let toolbarWidth = 110;
let toolbarHeight = 52;
/** previous focus target before opening the popup */
let previousFocusElement = null;
/** snapshot for delete undo */
let lastDeletedSnapshot = null;
/** timeout handle for delete undo expiration */
let lastDeleteUndoTimer = null;

const UI_GRACE_MS = 500;
const SELECTION_DEBOUNCE_MS = 250;
const DELETE_UNDO_MS = 5000;

/* =============================================================
   SETTINGS
   ============================================================= */

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const merged = { ...defaultSettings, ...extension_settings[extensionName] };
    extension_settings[extensionName] = merged;

    $("#quick_edit_enabled").prop("checked", merged.enabled);
    console.log(`[${extensionName}] Settings loaded:`, merged);
}

function onEnabledChange(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].enabled = value;
    saveSettingsDebounced();
    console.log(`[${extensionName}] enabled =`, value);
    if (value) {
        startListening();
    } else {
        stopListening();
    }
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
                <i class="fa-solid fa-pen"></i>
            </button>
            <button id="qe-delete-btn" class="qe-btn" type="button"
                    title="Delete selected text" aria-label="Delete selected text">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `);

    $editPopup = $(`
        <div id="qe-edit-popup" role="dialog" aria-modal="true" aria-label="Edit selected text">
            <textarea id="qe-edit-textarea"
                      placeholder="Edit selected text..."></textarea>
            <div id="qe-popup-buttons">
                <button id="qe-cancel-btn" type="button">Cancel</button>
                <button id="qe-save-btn" type="button">Save</button>
            </div>
        </div>
    `);

    $("body").append($toolbar).append($editPopup);

    // Measure toolbar dimensions once while temporarily visible.
    $toolbar.css("visibility", "hidden").addClass("is-visible");
    toolbarWidth = $toolbar.outerWidth() || 110;
    toolbarHeight = $toolbar.outerHeight() || 52;
    $toolbar.removeClass("is-visible").css("visibility", "");

    bindQuickAction($("#qe-edit-btn"), onEditClick);
    bindQuickAction($("#qe-delete-btn"), onDeleteClick);
    bindQuickAction($("#qe-cancel-btn"), () => hideEditPopup({ restoreFocus: true }));
    bindQuickAction($("#qe-save-btn"), onEditSave);

    $toolbar.add($editPopup).on("pointerdown.qe-internal mousedown.qe-internal", () => {
        lastUiInteraction = Date.now();
    });

    $editPopup.on("keydown.qe-internal", function (e) {
        if (e.key === "Escape") {
            e.preventDefault();
            hideEditPopup({ restoreFocus: true });
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

    $("#qe-edit-textarea").on("keydown", function (e) {
        if (e.key === "Escape") {
            e.preventDefault();
            hideEditPopup({ restoreFocus: true });
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onEditSave();
        }
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

    const rect = range.getBoundingClientRect();
    const vp = getViewportMetrics();
    const tbW = toolbarWidth;
    const tbH = toolbarHeight;
    const gap = 8;
    const minX = vp.left + 4;
    const minY = vp.top + 4;
    const maxX = vp.left + vp.width - tbW - 4;
    const maxY = vp.top + vp.height - tbH - 4;

    let top = vp.top + rect.bottom + gap;
    let left = vp.left + rect.left + (rect.width / 2) - (tbW / 2);

    if (top + tbH > vp.top + vp.height - 4) {
        top = vp.top + rect.top - tbH - gap;
    }

    top = Math.max(minY, Math.min(top, maxY));
    left = Math.max(minX, Math.min(left, maxX));

    $toolbar.css({ top: `${top}px`, left: `${left}px` });
}

function hideToolbar() {
    if ($toolbar) $toolbar.removeClass("is-visible");
    hideEditPopup({ restoreFocus: false });
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
        mes_text: message?.mes_text,
        is_edited: Boolean(message?.is_edited),
        swipe_id: swipeIndex,
        swipe_html: swipeHtml
    };
}

function restoreMessageState(message, snapshot) {
    if (!message || !snapshot) return;

    message.mes = snapshot.mes;
    message.mes_text = snapshot.mes_text;
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

    notify(`Deleted. Press Ctrl+Z within ${DELETE_UNDO_MS / 1000} seconds to undo.`, "info");
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

function saveMessageChanges({ previousState = null, action = "edit" } = {}) {
    if (!currentMesEl) return false;

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
    const newHtml = $mesText.html();

    try {
        message.mes = newHtml;
        message.mes_text = newHtml;
        message.is_edited = true;

        if (Array.isArray(message.swipes) && typeof message.swipe_id === "number") {
            message.swipes[message.swipe_id] = newHtml;
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
            `(${previousSnapshot.mes.length} → ${newHtml.length} chars)`
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

    previousFocusElement = document.activeElement;
    const $textarea = $("#qe-edit-textarea");
    $textarea.val(savedRange.toString());

    positionEditPopup();

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
    if (!applyRangeEdit(savedRange, newText)) {
        return;
    }

    if (!saveMessageChanges({ previousState, action: "edit" })) {
        return;
    }

    hideToolbar();
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

    if (!applyRangeEdit(savedRange, "")) {
        return;
    }

    if (!saveMessageChanges({ previousState, action: "delete" })) {
        return;
    }

    hideToolbar();
    clearSelection();
}

function getCurrentMessageState() {
    if (!currentMesEl) return null;

    const mesIdAttr = $(currentMesEl).attr("mesid");
    if (mesIdAttr === undefined) return null;

    const context = getContext();
    if (!context || !Array.isArray(context.chat)) return null;

    const idx = resolveMessageIndex(mesIdAttr, context.chat, currentMesEl);
    if (idx === -1 || !context.chat[idx]) return null;

    return captureMessageState(context.chat[idx]);
}

function clearSelection() {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
}

/* =============================================================
   EDIT POPUP
   ============================================================= */

function positionEditPopup() {
    if (!$toolbar || !$editPopup) return;
    const tbRect = $toolbar[0].getBoundingClientRect();
    const vp = getViewportMetrics();
    const gap = 8;

    $editPopup.addClass("is-visible");

    const popW = $editPopup.outerWidth() || 320;
    const popH = $editPopup.outerHeight() || 180;

    let top = vp.top + tbRect.bottom + gap;
    let left = vp.left + tbRect.left;

    if (top + popH > vp.top + vp.height - 4) top = vp.top + tbRect.top - popH - gap;
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

function notify(message, type = "info") {
    try {
        if (typeof toastr !== "undefined" && typeof toastr[type] === "function") {
            toastr[type](message);
            return;
        }
    } catch (e) {
        // fall through
    }
    console.log(`[${extensionName}] ${type}: ${message}`);
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
        if ($(target).closest("#qe-edit-popup").length) {
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
    }
}

function stopListening() {
    $(document).off(".qe");
    $("#qe-edit-btn, #qe-delete-btn, #qe-cancel-btn, #qe-save-btn").off(".qe-btn");
    $toolbar && $toolbar.off(".qe-internal");
    $editPopup && $editPopup.off(".qe-internal");
    window.removeEventListener("scroll", onScrollHide, true);
    window.removeEventListener("resize", onViewportChange);
    if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onViewportChange);
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
        const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
        $("#extensions_settings2").append(settingsHtml);

        $("#quick_edit_enabled").on("input", onEnabledChange);
        loadSettings();
        createUI();

        if (extension_settings[extensionName]?.enabled !== false) {
            startListening();
        }

        console.log(`[${extensionName}] ✅ Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Failed to load:`, error);
    }
});
