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
