// The frozen-diff tests (contrarian, NBA same-game, long-shot) hash a whole parlay to prove
// that nothing moved. PR C changed only what a leg SHOWS for its record (shownRecord,
// pick-record.ts): the record, its basis, the in-league slice, the Wilson number shown with
// it, and the prop market the label names. These hashes leave exactly those keys out
// (at any depth), so they compare everything the engine chose and nothing it displays.
// The *NoRecord values in the before JSONs were computed with this function on
// origin/main 922f086, where the full hashes still matched every stored before.
import { createHash } from "node:crypto";

export const SHOWN_RECORD_KEYS: ReadonlySet<string> = new Set(["record", "basis", "leagueSlice", "wilsonLowerBound", "propMarket"]);

export function withoutShownRecord(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(withoutShownRecord);
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (!SHOWN_RECORD_KEYS.has(k)) out[k] = withoutShownRecord(v);
    return out;
  }
  return x;
}

export const shaNoRecord = (x: unknown) => createHash("sha256").update(JSON.stringify(withoutShownRecord(x))).digest("hex").slice(0, 16);
