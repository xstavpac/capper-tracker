// Pure logic for catalog-import duplicate handling, split out so it's
// testable under tsx (the server action checkDuplicatePicksAction and the
// React form both transitively pull things - @/server/auth's React cache(),
// prisma - that can't load in the test runner).
//
// Two concerns, both dependency-free:
//   1. computeDuplicateFlags - the server's "is this pick a duplicate?"
//      decision: each resolved item is checked against BOTH the user's
//      already-logged picks (dbDuplicateLabel, decided by the caller) AND the
//      EARLIER items in the same paste. The DB-only check that this replaced
//      let a paste duplicate itself silently ("Clemson +6.5" / "Clemson +7"
//      pasted together are the same side-aware category, so neither one was
//      in the DB to match the other against).
//   2. isSkippedAsDuplicate / importButtonLabel - the form's rule that a
//      flagged duplicate is EXCLUDED by default (never silently imported),
//      and the button copy that surfaces the skip count instead of burying
//      it.

export type DuplicateFlag = { message: string };

// A batch item already resolved to a real scheduled game + a comparable
// side-aware category. Items that couldn't be resolved that far are simply
// absent from the array passed in.
export type ResolvedDupCandidate = {
  index: number; // position in the original input array
  // An existing capper's id, or a stable "new:<normalized>" token for a
  // capper not yet saved - a brand-new capper can't have a DB duplicate but
  // CAN post the same pick twice in one paste.
  capperKey: string;
  capperName: string; // for the message
  homeTeam: string;
  awayTeam: string;
  gameTimeMs: number;
  category: string; // pickCategory key - SPREAD_PLUS, FAV_ML, OVER, ...
  description: string; // the pick's own text, for naming the earlier copy
  // Non-null only when the caller found this pick already logged for the
  // user (the DB check). Its value is the label of the existing pick.
  dbDuplicateLabel: string | null;
};

// One flag per item that duplicates either a logged pick or an earlier item
// in the same paste. Keyed by `index`. "First one wins": a DB match flags
// immediately; otherwise the item is matched against the earlier RESOLVED
// items (same capper + game + side-aware category, game times within
// `maxGameTimeDriftMs`). Every resolved item joins the running set whether or
// not it was flagged, so a third copy still matches the first.
export function computeDuplicateFlags(
  resolved: ResolvedDupCandidate[],
  maxGameTimeDriftMs: number
): Record<number, DuplicateFlag> {
  const flags: Record<number, DuplicateFlag> = {};
  const seen: ResolvedDupCandidate[] = [];

  for (const r of resolved) {
    if (r.dbDuplicateLabel) {
      flags[r.index] = {
        message: r.capperName + " already has a " + r.dbDuplicateLabel + " pick logged for this game.",
      };
    } else {
      const earlier = seen.find(
        (e) =>
          e.capperKey === r.capperKey &&
          e.category === r.category &&
          e.homeTeam === r.homeTeam &&
          e.awayTeam === r.awayTeam &&
          Math.abs(e.gameTimeMs - r.gameTimeMs) <= maxGameTimeDriftMs
      );
      if (earlier) {
        flags[r.index] = {
          message: r.capperName + ' already has "' + earlier.description + '" earlier in this paste - same game, same bet.',
        };
      }
    }
    seen.push(r);
  }

  return flags;
}

export type DuplicateChoice = "import" | "skip";

// A flagged duplicate is left OUT of the import unless the user explicitly
// chose "Import anyway". "Skip" and never-answered both mean skip - the
// default is safe, and the never-answered case is exactly the one the
// end-of-import summary now names.
export function isSkippedAsDuplicate(hasFlag: boolean, choice: DuplicateChoice | undefined): boolean {
  return hasFlag && choice !== "import";
}

// Button copy: the count of picks that WILL import, plus - when there are any
// - how many are being skipped as duplicates, so that exclusion isn't
// silent at the point of clicking.
export function importButtonLabel(includedCount: number, skippedDuplicateCount: number): string {
  const base = "Import " + includedCount + " pick" + (includedCount === 1 ? "" : "s");
  if (skippedDuplicateCount <= 0) return base;
  return (
    base +
    " - " +
    skippedDuplicateCount +
    " skipped as duplicate" +
    (skippedDuplicateCount === 1 ? "" : "s")
  );
}
