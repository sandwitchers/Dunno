import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, saveChatDebounced } from "../../../../script.js";

const extensionName = "Dunno";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const defaultSettings = {
    enabled: true
};

// ── State ──────────────────────────────────────────────────
let $toolbar = null;
let $editPopup = null;
let savedRange = null;
let currentMesEl = null;
let selectionTimer = null;

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
        <div id="qe-toolbar">
            <button id="qe-edit-btn" class="qe-btn" title="Edit selected text">
                <i class="fa-solid fa-pen"></i>
            </button>
            <button id="qe-delete-btn" class="qe-btn" title="Delete selected text">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `);

    $editPopup = $(`
        <div id="qe-edit-popup">
            <textarea id="qe-edit-textarea" placeholder="Edit selected text..."></textarea>
            <div id="qe-popup-buttons">
                <button id="qe-cancel-btn">Cancel</button>
                <button id="qe-save-btn">Save</button>
            </div>
        </div>
    `);

    $("body").append($toolbar);
    $("body").append($editPopup);

    $("#qe-edit-btn").on("click", onEditClick);
    $("#qe-delete-btn").on("click", onDeleteClick);
    $("#qe-cancel-btn").on("click", hideEditPopup);
    $("#qe-save-btn").on("click", onEditSave);
    $("#qe-edit-textarea").on("keydown", function (e) {
        if (e.key === "Escape") hideEditPopup();
        if (e.key === "Enter" && e.ctrlKey) onEditSave();
    });
}

/* =============================================================
   SELECTION DETECTION
   ============================================================= */

function handleSelection() {
    if (!extension_settings[extensionName]?.enabled) return;
    if ($editPopup && $editPopup.is(":visible")) return; // don't hide while editing

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
        hideToolbar();
        return;
    }

    const anchorNode = sel.anchorNode;
    if (!anchorNode) { hideToolbar(); return; }

    const anchorEl = anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode;
    if (!anchorEl) { hideToolbar(); return; }

    // Must be inside #chat .mes_text
    const mesText = $(anchorEl).closest("#chat .mes_text");
    if (mesText.length === 0) { hideToolbar(); return; }

    // Must be within a SINGLE message (no cross-message selection)
    const anchorMes = $(anchorEl).closest(".mes");
    if (!anchorMes.length) { hideToolbar(); return; }

    const focusNode = sel.focusNode;
    if (focusNode) {
        const focusEl = focusNode.nodeType === 3 ? focusNode.parentElement : focusNode;
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

function positionToolbar(range) {
    const rect = range.getBoundingClientRect();
    const tbW = 84;
    const tbH = 44;
    const gap = 8;

    let top = rect.top - tbH - gap;
    let left = rect.left + (rect.width / 2) - (tbW / 2);

    // Flip below if not enough space above
    if (top < 4) top = rect.bottom + gap;
    // Horizontal clamp
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
    $("#qe-edit-textarea").val(savedRange.toString());
    positionEditPopup();
    $editPopup.show();
    $("#qe-edit-textarea").focus().select();
}

function onEditSave() {
    if (!savedRange || !currentMesEl) return;

    const newText = $("#qe-edit-textarea").val();
    applyRangeEdit(savedRange, newText);
    saveMessageChanges();
    hideToolbar();
    window.getSelection().removeAllRanges();
}

function onDeleteClick() {
    if (!savedRange || !currentMesEl) return;

    applyRangeEdit(savedRange, "");
    saveMessageChanges();
    hideToolbar();
    window.getSelection().removeAllRanges();
}

/**
 * Replace content inside a Range with new text (or empty string to delete).
 * Handles cross-node selections natively via Range API.
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
    if (range.commonAncestorContainer && typeof range.commonAncestorContainer.normalize === "function") {
        range.commonAncestorContainer.normalize();
    }
}

/* =============================================================
   SAVE TO SILLYTAVERN CHAT DATA
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

    context.chat[idx].mes_text = $mesText.html();

    if (typeof saveChatDebounced === "function") {
        saveChatDebounced();
        console.log(`[${extensionName}] Message ${idx} updated & saved`);
    } else {
        console.warn(`[${extensionName}] saveChatDebounced not available — edit applied to DOM but NOT persisted to disk`);
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
    selectionTimer = setTimeout(handleSelection, 250);
}

function startListening() {
    // Desktop: mouseup → finalize selection then check
    $(document).on("mouseup.qe", function (e) {
        if ($(e.target).closest("#qe-toolbar, #qe-edit-popup").length) return;
        setTimeout(handleSelection, 10);
    });

    // Mobile / keyboard / accessibility: selectionchange (debounced)
    document.addEventListener("selectionchange", onSelectionChangeHandler);

    // Click outside toolbar/popup/chat → dismiss
    $(document).on("mousedown.qe", function (e) {
        if (!$(e.target).closest("#qe-toolbar, #qe-edit-popup, #chat .mes_text").length) {
            hideToolbar();
        }
    });

    // Escape → dismiss
    $(document).on("keydown.qe", function (e) {
        if (e.key === "Escape") hideToolbar();
    });

    // Scroll → reposition or hide
    $(document).on("scroll.qe", function () {
        if ($toolbar && $toolbar.is(":visible") && !$editPopup.is(":visible")) {
            hideToolbar();
        }
    });
}

function stopListening() {
    $(document).off(".qe");
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