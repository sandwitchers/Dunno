// Run: node test.mjs
import assert from "node:assert/strict";
import { replaceOnce } from "./util.js";

assert.equal(replaceOnce("a b c", "b", "X"), "a X c");
assert.equal(replaceOnce("a b b", "b", "X"), null);      // ambiguous
assert.equal(replaceOnce("a b", "z", "X"), null);        // not found
assert.equal(replaceOnce("*b* c", "b", "X"), "*X* c");   // markdown kept
assert.equal(replaceOnce("abc", "b", ""), "ac");         // delete
assert.equal(replaceOnce("abc", "", "X"), null);         // empty selection
console.log("util ok");
