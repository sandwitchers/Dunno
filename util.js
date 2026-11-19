/**
 * Replace `find` in `source` with `replacement`, but only when `find`
 * occurs exactly once. Returns the new string, or null when there is no
 * match, more than one match, or `find` is empty.
 *
 * ponytail: exact unique match only. Selections that span markdown or
 * paragraph boundaries are refused rather than guessed. Upgrade path:
 * map DOM offsets back to source offsets.
 */
export function replaceOnce(source, find, replacement) {
    if (!find) return null;
    const i = source.indexOf(find);
    if (i === -1 || source.indexOf(find, i + 1) !== -1) return null;
    return source.slice(0, i) + replacement + source.slice(i + find.length);
}

/**
 * Regions of raw `mes` that are never shown on screen: MVU / RPG cards
 * hide <UpdateVariable> blocks and status-panel placeholders with regex,
 * but the words inside them are still in the source. A selected story
 * word that also appears in one of these blocks must not count as
 * ambiguous — the user can only select rendered (visible) text.
 */
const HIDDEN_REGION_RE = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>|<StatusPlaceHolderImpl[^>]*\/?>/g;

function hiddenRanges(source) {
    const ranges = [];
    HIDDEN_REGION_RE.lastIndex = 0;
    let m;
    while ((m = HIDDEN_REGION_RE.exec(source)) !== null) {
        if (m[0].length === 0) {
            HIDDEN_REGION_RE.lastIndex++;
            continue;
        }
        ranges.push([m.index, m.index + m[0].length]);
    }
    return ranges;
}

function overlapsHidden(ranges, start, end) {
    return ranges.some(([s, e]) => start < e && end > s);
}

/**
 * Start offsets of `needle` in `source`, skipping matches whose SELECTED
 * part (not the context around it) falls inside a hidden region.
 */
function findOccurrences(source, needle, selectedStart, selectedLength, hidden) {
    if (!needle) return [];
    const out = [];
    let i = source.indexOf(needle);
    while (i !== -1) {
        const selStart = i + selectedStart;
        if (!overlapsHidden(hidden, selStart, selStart + selectedLength)) {
            out.push(i);
        }
        i = source.indexOf(needle, i + 1);
    }
    return out;
}

/**
 * Locate `selected` inside raw `source` using rendered text around it.
 *
 * `before` / `after` are the rendered text before / after the selection
 * (from the DOM, within the selection's nearest block element). The
 * needle grows context in steps: 40, 20, 10, 5, then 0 chars each side.
 *
 * Returns `{ start, end }` — offsets of the SELECTED part in `source` —
 * or `{ error: "ambiguous" }` / `{ error: "notfound" }`.
 *
 * Why the steps: a shorter needle is a substring of a longer one, so
 * shrinking can only add matches. That means more than one match at
 * some length is final (ambiguous), while zero matches may just mean
 * formatting broke the match, so we shrink and retry.
 */
export function locateEdit(source, selected, before = "", after = "") {
    if (!selected) return { error: "notfound" };
    const hidden = hiddenRanges(source);
    for (const L of [40, 20, 10, 5, 0]) {
        const pre = L === 0 ? "" : before.slice(-L);
        const post = L === 0 ? "" : after.slice(0, L);
        const needle = pre + selected + post;
        const hits = findOccurrences(source, needle, pre.length, selected.length, hidden);
        if (hits.length === 1) {
            const start = hits[0] + pre.length;
            return { start, end: start + selected.length };
        }
        if (hits.length > 1) return { error: "ambiguous" };
        // 0 hits: shrink L and retry.
    }
    return { error: "notfound" };
}

/** True when `swipe_id` is a usable index into `swipes`. */
export function isValidSwipeIndex(swipes, swipe_id) {
    return (
        Array.isArray(swipes) &&
        typeof swipe_id === "number" &&
        swipe_id >= 0 &&
        swipe_id < swipes.length
    );
}

/**
 * Write `nextMes` into the currently shown swipe, if there is one.
 * A stale `swipe_id` (-1, past the end, wrong type) writes nothing:
 * assigning it would create a "-1" property or extend the array with
 * empty holes and corrupt the saved swipe list.
 */
export function writeCurrentSwipe(message, nextMes) {
    if (!message) return;
    if (isValidSwipeIndex(message.swipes, message.swipe_id)) {
        message.swipes[message.swipe_id] = nextMes;
    }
}

/** Snapshot of a message for rollback / delete-undo. */
export function captureMessageState(message) {
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

/**
 * Restore a snapshot taken by captureMessageState. Restores `swipe_id`
 * first (in range only), then `mes` and the swipe text, so `mes` —
 * which mirrors the currently shown swipe — and `swipes[swipe_id]`
 * agree again after a swipe flip.
 */
export function restoreMessageState(message, snapshot) {
    if (!message || !snapshot) return;

    if (
        isValidSwipeIndex(message.swipes, snapshot.swipe_id) &&
        snapshot.swipe_html !== null &&
        snapshot.swipe_html !== undefined
    ) {
        message.swipe_id = snapshot.swipe_id;
        message.swipes[snapshot.swipe_id] = snapshot.swipe_html;
    }

    message.mes = snapshot.mes;
    message.is_edited = snapshot.is_edited;
}

/**
 * True when an undo may still restore `snapshot` into `message`.
 * `expectedMes` is the message text right after the delete; if the
 * message changed since (another edit, a new swipe, a re-render),
 * undo must refuse instead of overwriting the new text.
 */
export function isUndoValid(snapshot, message) {
    return !!snapshot && !!message && message.mes === snapshot.expectedMes;
}
