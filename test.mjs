// Run: node test.mjs
import assert from "node:assert/strict";
import {
    replaceOnce,
    locateEdit,
    collapseNewlines,
    preserveNewlineRuns,
    isValidSwipeIndex,
    writeCurrentSwipe,
    captureMessageState,
    restoreMessageState,
    isUndoValid,
} from "./util.js";

// --- replaceOnce (kept: exact unique match only) ---
assert.equal(replaceOnce("a b c", "b", "X"), "a X c");
assert.equal(replaceOnce("a b b", "b", "X"), null);      // ambiguous
assert.equal(replaceOnce("a b", "z", "X"), null);        // not found
assert.equal(replaceOnce("*b* c", "b", "X"), "*X* c");   // markdown kept
assert.equal(replaceOnce("abc", "b", ""), "ac");         // delete
assert.equal(replaceOnce("abc", "", "X"), null);         // empty selection

// --- locateEdit: repeated word in dialogue + hidden <UpdateVariable> block ---
{
    const src = "Dia bilang pemalas sekali.\n<UpdateVariable>pemalas: true, malas: 1</UpdateVariable>\nDia pergi.";
    const loc = locateEdit(src, "pemalas", "Dia bilang ", " sekali.");
    assert.deepEqual(loc, { start: 11, end: 18 });
    const replaced = src.slice(0, loc.start) + "rajin" + src.slice(loc.end);
    assert.equal(replaced, "Dia bilang rajin sekali.\n<UpdateVariable>pemalas: true, malas: 1</UpdateVariable>\nDia pergi.");
}
// Same word, no context at all: the hidden copy must not count as ambiguous.
{
    const src = "Dia pemalas.\n<UpdateVariable>pemalas: true</UpdateVariable>";
    const loc = locateEdit(src, "pemalas", "", "");
    assert.deepEqual(loc, { start: 4, end: 11 });
}
// --- locateEdit: two identical sentences with identical context -> ambiguous ---
{
    const src = "Dia pemalas. Dia pemalas.";
    assert.deepEqual(locateEdit(src, "pemalas", "Dia ", ""), { error: "ambiguous" });
}
// --- locateEdit: selection inside *italic*, asterisks kept ---
{
    const src = "*Srek* pergi";
    const loc = locateEdit(src, "Srek", "", " pergi");
    assert.deepEqual(loc, { start: 1, end: 5 });
    assert.equal(src.slice(0, loc.start) + "Diam" + src.slice(loc.end), "*Diam* pergi");
}
// --- locateEdit: selection straddling markdown -> notfound ---
{
    const src = "*masih* terduduk";
    assert.deepEqual(locateEdit(src, "masih terduduk", "", ""), { error: "notfound" });
}
// --- locateEdit: empty selection -> notfound ---
assert.deepEqual(locateEdit("abc", "", "", ""), { error: "notfound" });
// --- locateEdit: context shrink recovers a match broken by formatting ---
{
    // Rendered before-text has no asterisk, raw does: long context fails,
    // short context (L=0) matches the word alone.
    const src = "Dia *pemalas* sekali.";
    const loc = locateEdit(src, "pemalas", "Dia *", " sekali.");
    assert.deepEqual(loc, { start: 5, end: 12 });
}
// --- collapseNewlines: runs map back to raw offsets ---
{
    const { text, map } = collapseNewlines("a\n\nb\r\n\r\nc\rd");
    assert.equal(text, "a\nb\nc\nd");
    assert.deepEqual(map, [0, 1, 3, 4, 8, 9, 10, 11]);
    assert.equal("a\n\nb\r\n\r\nc\nd".slice(map[2], map[3]), "b");
}
// --- locateEdit v0.8.1: the screenshot bug. Selection spans two rendered
// paragraphs, so it has ONE \n at the break; raw has \n\n. ---
{
    const raw = "\"Oi, John! Kau tidur lagi di sini? Dasar bocah ngentot!\"\n\nLi Wei menendang kerikil kecil ke arah kakimu. Ia mendengus, lalu meludah ke samping.\n\nIa menunggumu bereaksi, tampak senang melihatmu dalam kondisi linglung.";
    const selected = "Dasar bocah ngentot!\"\nLi Wei menendang kerikil kecil ke arah kakimu. Ia mendengus, lalu meludah ke samping.";
    const loc = locateEdit(raw, selected, "\"Oi, John! Kau tidur lagi di sini? ", "");
    // Span starts at "Dasar" (offset 35) and ends after "samping." — the
    // raw span INCLUDES the \n\n break, so replacing it keeps the gap.
    assert.equal(raw.slice(loc.start, loc.end), "Dasar bocah ngentot!\"\n\nLi Wei menendang kerikil kecil ke arah kakimu. Ia mendengus, lalu meludah ke samping.");
    assert.equal(loc.start, 35);
    // The user's edit: same lines, one line appended. Line count differs
    // (3 breaks vs 1 run), so preserveNewlineRuns falls back to the
    // user's text as-is and the \n\n gap becomes a single \n — ST still
    // renders it as a line break (simpleLineBreaks), just no blank gap.
    const edited = "Dasar bocah ngentot!\"\nLi Wei menendang kerikil kecil ke arah kakimu.\nIa mendengus, lalu meludah ke samping\n*hoeek cuihh*";
    const next = raw.slice(0, loc.start) + preserveNewlineRuns(raw.slice(loc.start, loc.end), edited) + raw.slice(loc.end);
    assert.equal(next, "\"Oi, John! Kau tidur lagi di sini? Dasar bocah ngentot!\"\nLi Wei menendang kerikil kecil ke arah kakimu.\nIa mendengus, lalu meludah ke samping\n*hoeek cuihh*\n\nIa menunggumu bereaksi, tampak senang melihatmu dalam kondisi linglung.");
}
// Same screenshot case, but with NO context at all (the old
// getSelectionContext threw both halves away on cross-block selections).
{
    const raw = "Satu.\n\nDua kalimat sama.\n\nTiga.";
    assert.deepEqual(locateEdit(raw, "Satu.\nDua kalimat sama.", "", ""), { start: 0, end: 24 });
}
// --- locateEdit: ambiguous across paragraphs, context disambiguates ---
{
    const raw = "Dia bilang pemalas sekali.\n\nDia bilang pemalas sekali.\n\nAkhir.";
    // before from the FIRST paragraph's start -> first copy.
    assert.deepEqual(locateEdit(raw, "pemalas", "Dia bilang ", " sekali.\n\nDia bilang"), { start: 11, end: 18 });
    // after from the SECOND paragraph's tail -> second copy.
    assert.deepEqual(locateEdit(raw, "pemalas", "Dia bilang pemalas sekali.\n\nDia bilang ", " sekali.\n\nAkhir."), { start: 39, end: 46 });
}
// --- locateEdit: \r\n raw (imported chat) matches a \n selection ---
{
    const raw = "Satu.\r\n\r\nDua.";
    assert.deepEqual(locateEdit(raw, "Satu.\nDua.", "", ""), { start: 0, end: 13 });
}
// --- preserveNewlineRuns ---
{
    // Same line count: the \n\n gap survives the edit.
    assert.equal(preserveNewlineRuns("a\n\nb", "a\nB"), "a\n\nB");
    // Different line count (user added a line): their text wins as-is.
    assert.equal(preserveNewlineRuns("a\n\nb", "a\nB\nc"), "a\nB\nc");
    // No breaks in the span: unchanged.
    assert.equal(preserveNewlineRuns("abc", "aXc"), "aXc");
    // \r\n run preserved.
    assert.equal(preserveNewlineRuns("a\r\n\r\nb", "a\nB"), "a\r\n\r\nB");
}

// --- swipe helpers: stale swipe_id must not create properties or holes ---
{
    const msg = { swipes: ["a", "b"], swipe_id: -1 };
    writeCurrentSwipe(msg, "X");
    assert.deepEqual(msg.swipes, ["a", "b"]);
    assert.equal("-1" in msg.swipes, false);
}
{
    const msg = { swipes: ["a", "b"], swipe_id: 5 };
    writeCurrentSwipe(msg, "X");
    assert.deepEqual(msg.swipes, ["a", "b"]);
    assert.equal(msg.swipes.length, 2);
}
{
    const msg = { swipes: ["a", "b"], swipe_id: "0" };
    writeCurrentSwipe(msg, "X");
    assert.deepEqual(msg.swipes, ["a", "b"]);
}
{
    const msg = { swipes: ["a", "b"], swipe_id: 1 };
    writeCurrentSwipe(msg, "X");
    assert.deepEqual(msg.swipes, ["a", "X"]);
}
assert.equal(isValidSwipeIndex(["a"], 0), true);
assert.equal(isValidSwipeIndex(["a"], -1), false);
assert.equal(isValidSwipeIndex(["a"], 1), false);
assert.equal(isValidSwipeIndex(null, 0), false);

// --- capture/restore: swipe flip then undo restores swipe_id too ---
{
    const msg = { mes: "old0", swipes: ["old0", "old1"], swipe_id: 0, is_edited: false };
    const snap = captureMessageState(msg);
    // User flips to swipe 1 and edits it.
    msg.swipe_id = 1;
    msg.mes = "old1";
    msg.swipes[1] = "changed1";
    restoreMessageState(msg, snap);
    assert.equal(msg.swipe_id, 0);
    assert.equal(msg.mes, "old0");
    assert.equal(msg.swipes[0], "old0");
    assert.equal(msg.swipes[1], "changed1"); // the other swipe is untouched
}
// --- capture/restore: out-of-range swipe_id at capture time ---
{
    const msg = { mes: "a", swipes: ["a"], swipe_id: 5, is_edited: true };
    const snap = captureMessageState(msg);
    assert.equal(snap.swipe_html, null);
    msg.mes = "b";
    restoreMessageState(msg, snap);
    assert.equal(msg.mes, "a");
    assert.equal(msg.swipe_id, 5); // untouched: nothing valid to restore to
}

// --- undo identity: refuse when the message changed after the delete ---
{
    const snap = { expectedMes: "Dia pergi." };
    assert.equal(isUndoValid(snap, { mes: "Dia pergi." }), true);
    assert.equal(isUndoValid(snap, { mes: "Dia pergi. Tambahan." }), false);
    assert.equal(isUndoValid(snap, null), false);
    assert.equal(isUndoValid(null, { mes: "Dia pergi." }), false);
}

console.log("util ok");
