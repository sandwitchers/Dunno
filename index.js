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
 *     `display:flex` and causing the round buttons (which are
 *     themselves `display:flex` = block-level) to stack VERTICALLY.
 *     This was the "ikon vertikal" bug in v0.2.
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
 *     v0.3 (this version) uses `parseInt(mesId, 10)` as the array
 *     index directly, with a `findIndex` fallback for forward
 *     compatibility if ST ever adds a `mesid` field. It also:
 *       • syncs `mes.swipes[swipe_id]` so swipe-aware context works,
 *       • sets `mes.is_edited = true` so the "edited" badge shows,
 *       • calls ST's `updateMessageBlock(id, message)` so the DOM,
 *         token cache, and other extensions all see the edit.
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

/** ignore transient selectionchange events for this long after a
 *  toolbar / popup interaction (ms). */
const UI_GRACE_MS = 500;
/** selectionchange debounce delay (ms). */
const SELECTION_DEBOUNCE_MS = 250;

/* =============================================================
   SETTINGS
   ============================================================= */

/**
 * Load settings, merging defaults with saved values.
 *
 * We use `{ ...defaults, ...saved }` instead of "only apply defaults
 * if empty" so that future-added settings automatically get their
 * default for existing users without wiping their other choices.
 */
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

    // ── Measure toolbar dimensions once (while hidden, via visibility) ──
    // We need real outerWidth/Height for accurate positioning. The
    // toolbar is `display:none` by default, so we toggle a hidden
    // visible state just to measure.
    $toolbar.css("visibility", "hidden").addClass("is-visible");
    toolbarWidth = $toolbar.outerWidth() || 110;
    toolbarHeight = $toolbar.outerHeight() || 52;
    $toolbar.removeClass("is-visible").css("visibility", "");

    // ── Bind button actions to `pointerdown` ──
    // Fires BEFORE the browser clears the text selection on touch,
    // which is the fix for "the edit icon just closes when I tap it".
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
    if ($editPopup && $editPopup.hasClass("is-visible")) return; // don't hide while editing

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
    $toolbar.addClass("is-visible");
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
    const tbW = toolbarWidth;
    const tbH = toolbarHeight;
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
    if ($toolbar) $toolbar.removeClass("is-visible");
    hideEditPopup();
    savedRange = null;
    currentMesEl = null;
}

/* =============================================================
   EDIT & DELETE ACTIONS
   ============================================================= */

function onEditClick() {
    if (!savedRange || !currentMesEl) return;

    // Streaming guard — refuse to edit a message that is currently
    // being generated. The stream writer would overwrite our edit.
    const mesId = $(currentMesEl).attr("mesid");
    const idx = parseInt(mesId, 10);
    const ctx = getContext();
    if (!isNaN(idx) && ctx?.chat?.[idx]?.streaming) {
        notify("Cannot edit a message that is still streaming", "warning");
        return;
    }

    const $textarea = $("#qe-edit-textarea");
    $textarea.val(savedRange.toString());

    positionEditPopup();

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
 * Escape HTML special characters in user-typed text.
 * Prevents `<script>` injection and HTML structure corruption.
 */
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Replace the contents of a Range with new text (or "" to delete).
 *
 * The new text is HTML-escaped (so `<` becomes `&lt;` etc.) and
 * newlines are converted to `<br>` so multi-line edits render as
 * line breaks instead of being collapsed by HTML's default
 * whitespace handling.
 */
function applyRangeEdit(range, newText) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    range.deleteContents();

    if (newText.length > 0) {
        // Escape HTML entities, then convert newlines to <br>.
        const html = escapeHtml(newText).replace(/\n/g, "<br>");

        // Parse into a fragment so we can insert nodes directly
        // (avoids wrapping in an extra <div>).
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = html;
        const fragment = document.createDocumentFragment();
        while (tempDiv.firstChild) {
            fragment.appendChild(tempDiv.firstChild);
        }
        range.insertNode(fragment);
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

/**
 * Resolve a DOM `mesid` attribute to an index into `context.chat`.
 *
 * In SillyTavern, the DOM `mesid` attribute equals the array index
 * (see ST source: `chat[mesElement.attr('mesid')]`). Message objects
 * do NOT have a `mesid` field, so a `findIndex` by `m.mesid` always
 * returns -1 — which is exactly why v0.2 edits never reached the AI.
 *
 * We use `parseInt` as the primary path and fall back to `findIndex`
 * by `m.mesid` only if ST ever introduces such a field in the future.
 */
function resolveMessageIndex(mesIdAttr, chat) {
    const direct = parseInt(mesIdAttr, 10);
    if (!isNaN(direct) && direct >= 0 && direct < chat.length) {
        return direct;
    }
    // Forward-compat fallback: search by `mesid` field if it ever
    // gets introduced.
    return chat.findIndex(m => String(m?.mesid) === String(mesIdAttr));
}

function saveMessageChanges() {
    if (!currentMesEl) return;

    const mesIdAttr = $(currentMesEl).attr("mesid");
    if (mesIdAttr === undefined) {
        console.error(`[${extensionName}] No mesid found on element`, currentMesEl);
        return;
    }

    const context = getContext();
    if (!context || !Array.isArray(context.chat)) {
        console.error(`[${extensionName}] getContext() or chat array unavailable`);
        return;
    }

    const idx = resolveMessageIndex(mesIdAttr, context.chat);
    if (idx === -1) {
        console.error(
            `[${extensionName}] Could not resolve mesid "${mesIdAttr}" to a chat index ` +
            `(chat length: ${context.chat.length})`
        );
        return;
    }

    const message = context.chat[idx];
    if (!message) {
        console.error(`[${extensionName}] chat[${idx}] is null/undefined`);
        return;
    }

    const $mesText = $(currentMesEl).find(".mes_text");
    if ($mesText.length === 0) {
        console.error(`[${extensionName}] .mes_text not found inside message element`);
        return;
    }

    const newHtml = $mesText.html();
    const oldLen = (message.mes || "").length;

    // ── Persist the edit to all the places SillyTavern reads from ──
    // 1. `mes`           — the canonical field; used for AI context,
    //                      reload, and message re-rendering.
    // 2. `swipes[cur]`   — if the message has swipes, the current
    //                      swipe must also be updated, otherwise
    //                      switching swipes would undo our edit.
    // 3. `is_edited`     — so ST shows the "edited" badge.
    // 4. `mes_text`      — mirror for any third-party code that
    //                      reads this (non-standard) field.
    message.mes = newHtml;
    if (Array.isArray(message.swipes) && typeof message.swipe_id === "number") {
        message.swipes[message.swipe_id] = newHtml;
    }
    message.is_edited = true;
    message.mes_text = newHtml;

    // ── Re-render via ST's own API so DOM, token cache, and other
    //    extensions all see the edit. Falls back gracefully if the
    //    function signature changes in a future ST version. ──
    if (typeof context.updateMessageBlock === "function") {
        try {
            context.updateMessageBlock(idx, message);
        } catch (e) {
            console.warn(`[${extensionName}] updateMessageBlock failed (non-fatal):`, e);
        }
    }

    // ── Persist to disk ──
    if (typeof saveChatDebounced === "function") {
        saveChatDebounced();
        console.log(
            `[${extensionName}] Message ${idx} updated & saved ` +
            `(${oldLen} → ${newHtml.length} chars)`
        );
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
    const gap = 8;

    // Show first so we can measure real dimensions (CSS makes the
    // popup `display:none` by default).
    $editPopup.addClass("is-visible");

    const popW = $editPopup.outerWidth() || 320;
    const popH = $editPopup.outerHeight() || 180;

    let top = tbRect.bottom + gap;
    let left = tbRect.left;

    if (top + popH > window.innerHeight - 4) top = tbRect.top - popH - gap;
    if (top < 4) top = 4;
    if (left + popW > window.innerWidth - 4) left = window.innerWidth - popW - 4;
    if (left < 4) left = 4;

    $editPopup.css({ top: `${top}px`, left: `${left}px` });
}

function hideEditPopup() {
    if ($editPopup) $editPopup.removeClass("is-visible");
}

/* =============================================================
   UTILITIES
   ============================================================= */

/**
 * Show a toastr notification if toastr is available (SillyTavern
 * always loads it). Falls back to console.log so the message is
 * never lost.
 */
function notify(message, type = "info") {
    try {
        if (typeof toastr !== "undefined" && typeof toastr[type] === "function") {
            toastr[type](message);
            return;
        }
    } catch (e) { /* fall through */ }
    console.log(`[${extensionName}] ${type}: ${message}`);
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
    if (
        $toolbar && $toolbar.hasClass("is-visible") &&
        $editPopup && !$editPopup.hasClass("is-visible")
    ) {
        hideToolbar();
    }
}

/**
 * Viewport change handler — fires on `window.resize` AND
 * `visualViewport.resize` (the latter fires when the mobile keyboard
 * appears/disappears).
 *
 * CRITICAL: If the edit popup is open, we DO NOT close it. On mobile,
 * the keyboard appearing triggers this handler, and closing the popup
 * mid-edit is the most frustrating bug. We only reposition the popup
 * if it's now off-screen.
 *
 * If only the toolbar is open (no popup), we hide it because the
 * saved Range's bounding rect is stale after a viewport change.
 *
 * The handler is debounced (150ms) because resize/visualViewport
 * events fire many times during a keyboard appear animation.
 */
function onViewportChange() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        // If the popup is open, the user is editing. NEVER close it.
        // Just reposition if off-screen (keyboard may have shrunk viewport).
        if ($editPopup && $editPopup.hasClass("is-visible")) {
            repositionPopupForViewport();
            return;
        }
        // Otherwise, hide the toolbar (saved Range rect is stale).
        if ($toolbar && $toolbar.hasClass("is-visible")) {
            hideToolbar();
        }
    }, 150);
}

/**
 * Reposition the edit popup if it's off-screen after a viewport
 * change (e.g. mobile keyboard appearing). Uses `visualViewport`
 * when available for accurate keyboard-aware positioning.
 *
 * If the popup is already fully visible, this is a no-op (avoids jank).
 */
function repositionPopupForViewport() {
    if (!$editPopup || !$editPopup.hasClass("is-visible")) return;

    // Use visualViewport if available — it accounts for the mobile
    // keyboard, unlike window.innerHeight.
    const vv = window.visualViewport;
    const vh = vv ? vv.height : window.innerHeight;
    const vw = vv ? vv.width : window.innerWidth;

    const rect = $editPopup[0].getBoundingClientRect();

    // If popup is fully visible, don't move it (avoids jank).
    if (rect.top >= 4 && rect.bottom <= vh - 4 &&
        rect.left >= 4 && rect.right <= vw - 4) {
        return;
    }

    // Center it in the visible area.
    const popW = $editPopup.outerWidth() || 320;
    const popH = $editPopup.outerHeight() || 180;

    let top = Math.max(4, (vh - popH) / 2);
    let left = Math.max(4, (vw - popW) / 2);

    $editPopup.css({ top: `${top}px`, left: `${left}px` });
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

    // Viewport changes (resize / keyboard) — see onViewportChange.
    // CRITICAL: must NOT close the popup on these events, because
    // on mobile the keyboard appearing fires resize.
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
