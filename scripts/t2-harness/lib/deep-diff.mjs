// Generic structural diff over plain JSON-shaped values (objects, arrays,
// primitives - the output of JSON.parse(JSON.stringify(...)), which is what
// capture-output.ts produces). Deliberately NOT a string/text diff: comparing
// serialized JSON text would make key order a false-positive source, and
// comparing raw DB rows or internal Maps would compare the wrong layer (see
// the T2 build task's diff-mechanism requirement - old output === new output
// for the same underlying data, not "same internal representation"). This
// walks both values in parallel and reports every path that differs, so a
// mismatch is reported as e.g. `entries[2].stats.winPct: 55 -> 50`, not just
// "objects differ".
//
// Arrays are compared index-for-index (order-sensitive) rather than sorted
// or set-compared first - the T2 audit confirmed no current /cappers query
// relies on a SQL-level ORDER BY (every order-sensitive computation re-sorts
// internally in JS), but the arrays THEMSELVES are still meaningful in the
// order they're returned to the page, so an order difference is a real
// difference, not noise to normalize away.
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepDiff(oldVal, newVal, path = "$") {
  const diffs = [];

  if (oldVal === newVal) return diffs;

  const oldIsArr = Array.isArray(oldVal);
  const newIsArr = Array.isArray(newVal);
  const oldIsObj = isPlainObject(oldVal);
  const newIsObj = isPlainObject(newVal);

  if (oldIsArr && newIsArr) {
    const len = Math.max(oldVal.length, newVal.length);
    if (oldVal.length !== newVal.length) {
      diffs.push({ path: `${path}.length`, old: oldVal.length, new: newVal.length });
    }
    for (let i = 0; i < len; i++) {
      diffs.push(...deepDiff(oldVal[i], newVal[i], `${path}[${i}]`));
    }
    return diffs;
  }

  if (oldIsObj && newIsObj) {
    const keys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
    for (const key of keys) {
      diffs.push(...deepDiff(oldVal[key], newVal[key], `${path}.${key}`));
    }
    return diffs;
  }

  // Type mismatch (e.g. array vs object, or one side undefined/null the
  // other isn't) or a differing primitive - either way, a leaf-level diff.
  diffs.push({ path, old: oldVal, new: newVal });
  return diffs;
}

// Pretty-prints a diff list for terminal output - the "actionable" report
// the T2 build task requires (which rows/fields/ordering differ, not just
// pass/fail).
export function formatDiffReport(diffs) {
  if (diffs.length === 0) return "no differences";
  return diffs.map((d) => `  ${d.path}: ${JSON.stringify(d.old)} -> ${JSON.stringify(d.new)}`).join("\n");
}
