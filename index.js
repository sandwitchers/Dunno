/**
 * Quick Edit — SillyTavern third-party extension
 *
 * Lets the user select any portion of a chat message and edit / delete
 * just that portion via a floating toolbar, without opening SillyTavern's
 * full-message editor.
 *
 * ── Design notes (post-revamp) ─────────────────────────────────
 *  1. The floating toolbar defaults to BELOW the selection. This is
 *     deliberate: Android's native text-action toolbar always appears
 *     ABOVE the selection, so an above-ours would collide with it.
 *     We only flip above when there is no room below.
 *
 *  2. Buttons are bound to `pointerdown` (with a `mousedown` fallback)
 *     rather than `click`. On touch devices, `click` is delayed long
 *     enough for `selectionchange` to fire and wipe the saved range
 *     before the click handler runs — which is why tapping the edit
 *     icon used to "just close" the toolbar.
 *
 *  3. The saved selection (`savedRange`) is preserved across focus
 *     shifts. We track `lastUiInteraction` and ignore transient
 *     `selectionchange` events that fire within a short grace window
 *     after a toolbar / popup interaction.
 *
 *  4. The edit popup's textarea is focused WITHOUT calling `.select()`
 *     so the user can place the caret freely; previously `.select()`
 *     selected all the text in the textarea, which the user reported
 *     as "selecting all the text".
 *
 *  5. Edits are persisted to `context.chat[idx].mes` (the real
 *     SillyTavern field). The previous version wrote to `mes_text`,
 *     which is not a real property — edits were lost on reload.
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
/** debounce handle for the `selectionchange` listener */
let selectionTimer = null;
/** timestamp (ms) of the last pointerdown on toolbar / popup */
let lastUiInteraction = 0;
/** ignore transient selectionchange events for this long after a
 *  toolbar / popup interaction (ms). */
const UI_GRACE_MS = 500;
/** selectionchange debounce delay (ms). */
const SELECTION_DEBOUNCE_MS = 250;

/* =============================================================
   SETTINGS
   ============================================================= */

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
    $("#quick_edit_enabled").prop("checked", extension_settings[extensionName].enabled);
    console.log(`[${extensionName}] Settings loaded:`, extension_settings[extensionName]);
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
    if ($("#qe-toolbar").length) return; // prevent duplicates

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
        <div id="qe-edit-popup" role="dialog" aria-label="Edit selected text">
            <textarea id="qe-edit-textarea"
                      placeholder="Edit selected text..."></textarea>
            <div id="qe-popup-buttons">
                <button id="qe-cancel-btn" type="button">Cancel</button>
                <button id="qe-save-btn" type="button">Save</button>
            </div>
        </div>
    `);

    $("body").append($toolbar).append($editPopup);

    // Bind button actions to `pointerdown` so they fire BEFORE the
    // browser clears the text selection on touch devices. This is the
    // fix for "the edit icon just closes when I tap it".
    bindQuickAction($("#qe-edit-btn"), onEditClick);
    bindQuickAction($("#qe-delete-btn"), onDeleteClick);
    bindQuickAction($("#qe-cancel-btn"), hideEditPopup);
    bindQuickAction($("#qe-save-btn"), onEditSave);

    // Track any pointerdown on the toolbar / popup so we can ignore
    // transient `selectionchange` events that follow.
    $toolbar.add($editPopup).on("pointerdown.qe-internal mousedown.qe-internal", () => {
        lastUiInteraction = Date.now();
    });

    $("#qe-edit-textarea").on("keydown", function (e) {
        if (e.key === "Escape") {
            e.preventDefault();
            hideEditPopup();
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onEditSave();
        }
    });
}

/**
 * Bind a handler that fires on `pointerdown` (preferred) or
 * `mousedown` (fallback). Calling `e.preventDefault()` on these
 * early events prevents the browser from shifting focus away from
 * the page selection, which is what wiped `savedRange` before
 * `click` could run on mobile.
 *
 * The follow-up `click` is suppressed so the handler doesn't run
 * twice.
 */
function bindQuickAction($el, handler) {
    const startEvent = window.PointerEvent ? "pointerdown" : "mousedown";
    let handled = false;

    $el.on(startEvent + ".qe-btn", function (e) {
        // Only react to the primary button (left click / touch / pen).
        if (e.button && e.button !== 0) return;
        e.preventDefault();            // prevent focus shift / selection clearing
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

function handleSelection() {
    if (!extension_settings[extensionName]?.enabled) return;
    if ($editPopup && $editPopup.is(":visible")) return; // don't hide while editing

    const sel = window.getSelection();
    const hasSelection = !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;

    // If the user just tapped a toolbar / popup button, the browser
    // may briefly clear the selection (focus shift). Ignore those
    // transient events so we don't lose `savedRange` — BUT only when
    // there is no fresh selection. A new selection should always be
    // honoured, even within the grace window.
    if (!hasSelection && Date.now() - lastUiInteraction < UI_GRACE_MS) {
        return;
    }

    if (!hasSelection) {
        hideToolbar();
        return;
    }

    const anchorNode = sel.anchorNode;
    if (!anchorNode) { hideToolbar(); return; }

    const anchorEl = anchorNode.nodeType === Node.TEXT_NODE
        ? anchorNode.parentElement
        : anchorNode;
    if (!anchorEl) { hideToolbar(); return; }

    // Must be inside #chat .mes_text
    const mesText = $(anchorEl).closest("#chat .mes_text");
    if (mesText.length === 0) { hideToolbar(); return; }

    // Must be within a SINGLE message (no cross-message selection)
    const anchorMes = $(anchorEl).closest(".mes");
    if (!anchorMes.length) { hideToolbar(); return; }

    const focusNode = sel.focusNode;
    if (focusNode) {
        const focusEl = focusNode.nodeType === Node.TEXT_NODE
            ? focusNode.parentElement
            : focusNode;
        const focusMes = focusEl ? $(focusEl).closest(".mes") : $();
        if (focusMes.length && anchorMes.attr("mesid") !== focusMes.attr("mesid")) {
            hideToolbar();
            return;
        }
    }

    // Save references
    currentMesEl = anchorMes;
    try {
        savedRange = sel.getRangeAt(0).cloneRange();
    } catch (e) {
        hideToolbar();
        return;
    }

    positionToolbar(savedRange);
    $toolbar.show();
}

/**
 * Position the floating toolbar relative to a Range.
 *
 * Default: BELOW the selection (so it doesn't collide with Android's
 * native text-action toolbar, which always appears above). Flips above
 * only when there's no room below, then clamps to the viewport.
 */
function positionToolbar(range) {
    const rect = range.getBoundingClientRect();
    const tbW = 84;
    const tbH = 44;
    const gap = 8;

    // Default: BELOW the selection
    let top = rect.bottom + gap;
    let left = rect.left + (rect.width / 2) - (tbW / 2);

    // Flip above only if there's no room below
    if (top + tbH > window.innerHeight - 4) {
        top = rect.top - tbH - gap;
    }
    // Final clamp to viewport
    if (top < 4) top = 4;
    if (top + tbH > window.innerHeight - 4) top = window.innerHeight - tbH - 4;

    if (left < 4) left = 4;
    if (left + tbW > window.innerWidth - 4) left = window.innerWidth - tbW - 4;

    $toolbar.css({ top: `${top}px`, left: `${left}px` });
}

function hideToolbar() {
    if ($toolbar) $toolbar.hide();
    hideEditPopup();
    savedRange = null;
    currentMesEl = null;
}

/* =============================================================
   EDIT & DELETE ACTIONS
   ============================================================= */

function onEditClick() {
    if (!savedRange) return;

    const $textarea = $("#qe-edit-textarea");
    $textarea.val(savedRange.toString());

    positionEditPopup();
    $editPopup.show();

    // Focus WITHOUT `.select()` — `.select()` highlighted the entire
    // textarea contents, which the user reported as "it selects all
    // the text". Instead, place the caret at the end so the user can
    // append, re-select, or use Ctrl+A themselves.
    const ta = $textarea[0];
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
}

function onEditSave() {
    if (!savedRange || !currentMesEl) return;

    const newText = $("#qe-edit-textarea").val();
    applyRangeEdit(savedRange, newText);
    saveMessageChanges();
    hideToolbar();
    clearSelection();
}

function onDeleteClick() {
    if (!savedRange || !currentMesEl) return;

    applyRangeEdit(savedRange, "");
    saveMessageChanges();
    hideToolbar();
    clearSelection();
}

function clearSelection() {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
}

/**
 * Replace the contents of a Range with new text (or "" to delete).
 * Handles cross-node selections natively via the Range API.
 */
function applyRangeEdit(range, newText) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    range.deleteContents();
    if (newText.length > 0) {
        range.insertNode(document.createTextNode(newText));
    }

    // Merge adjacent text nodes so innerHTML stays clean
    const common = range.commonAncestorContainer;
    if (common && typeof common.normalize === "function") {
        common.normalize();
    }
}

/* =============================================================
   PERSIST TO SILLYTAVERN CHAT DATA
   ============================================================= */

function saveMessageChanges() {
    if (!currentMesEl) return;

    const mesId = $(currentMesEl).attr("mesid");
    if (mesId === undefined) {
        console.error(`[${extensionName}] No mesid found on element`, currentMesEl);
        return;
    }

    const context = getContext();
    if (!context || !Array.isArray(context.chat)) {
        console.error(`[${extensionName}] getContext() or chat array unavailable`);
        return;
    }

    const idx = context.chat.findIndex(m => String(m.mesid) === String(mesId));
    if (idx === -1) {
        console.error(`[${extensionName}] Message not found in chat array, mesid=${mesId}`);
        return;
    }

    const $mesText = $(currentMesEl).find(".mes_text");
    if ($mesText.length === 0) {
        console.error(`[${extensionName}] .mes_text not found inside message element`);
        return;
    }

    const newHtml = $mesText.html();

    // SillyTavern stores the message body in `mes` (HTML).
    // The previous version wrote only to `mes_text`, which is not a
    // real property on the chat object — edits appeared in the DOM
    // but were lost on reload. We now write to `mes` and also mirror
    // to `mes_text` for any third-party code that may read it.
    context.chat[idx].mes = newHtml;
    context.chat[idx].mes_text = newHtml;

    if (typeof saveChatDebounced === "function") {
        saveChatDebounced();
        console.log(`[${extensionName}] Message ${idx} updated & saved`);
    } else {
        console.warn(
            `[${extensionName}] saveChatDebounced not available — ` +
            `edit applied to DOM but NOT persisted to disk`
        );
    }
}

/* =============================================================
   EDIT POPUP
   ============================================================= */

function positionEditPopup() {
    if (!$toolbar || !$editPopup) return;
    const tbRect = $toolbar[0].getBoundingClientRect();
    const popW = 320;
    const popH = 180;
    const gap = 8;

    let top = tbRect.bottom + gap;
    let left = tbRect.left;

    if (top + popH > window.innerHeight - 4) top = tbRect.top - popH - gap;
    if (top < 4) top = 4;
    if (left + popW > window.innerWidth - 4) left = window.innerWidth - popW - 4;
    if (left < 4) left = 4;

    $editPopup.css({ top: `${top}px`, left: `${left}px` });
}

function hideEditPopup() {
    if ($editPopup) $editPopup.hide();
}

/* =============================================================
   EVENT LISTENERS
   ============================================================= */

function onSelectionChangeHandler() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(handleSelection, SELECTION_DEBOUNCE_MS);
}

/**
 * Scroll handler — hides the toolbar when the page scrolls, unless
 * the edit popup is open (in which case we don't disrupt editing).
 */
function onScrollHide() {
    if ($toolbar && $toolbar.is(":visible") && $editPopup && !$editPopup.is(":visible")) {
        hideToolbar();
    }
}

function startListening() {
    // Desktop: mouseup → finalize selection then check
    $(document).on("mouseup.qe", function (e) {
        if ($(e.target).closest("#qe-toolbar, #qe-edit-popup").length) return;
        setTimeout(handleSelection, 10);
    });

    // Mobile / keyboard / accessibility: selectionchange (debounced)
    document.addEventListener("selectionchange", onSelectionChangeHandler);

    // Click outside toolbar / popup / chat → dismiss
    $(document).on("mousedown.qe", function (e) {
        if (!$(e.target).closest("#qe-toolbar, #qe-edit-popup, #chat .mes_text").length) {
            hideToolbar();
        }
    });

    // Escape → dismiss
    $(document).on("keydown.qe", function (e) {
        if (e.key === "Escape") hideToolbar();
    });

    // Scroll → hide. Use capture phase so we catch scrolls on inner
    // containers (e.g. #chat) which don't bubble to document.
    window.addEventListener("scroll", onScrollHide, true);
}

function stopListening() {
    $(document).off(".qe");
    $("#qe-edit-btn, #qe-delete-btn, #qe-cancel-btn, #qe-save-btn").off(".qe-btn");
    $toolbar && $toolbar.off(".qe-internal");
    $editPopup && $editPopup.off(".qe-internal");
    window.removeEventListener("scroll", onScrollHide, true);
    document.removeEventListener("selectionchange", onSelectionChangeHandler);
    clearTimeout(selectionTimer);
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
