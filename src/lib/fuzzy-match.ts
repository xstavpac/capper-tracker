// Shared name-matching logic for cappers - exact-normalized matching (used
// throughout catalog parsing/import) plus fuzzy matching for catching likely
// typos and singular/plural mismatches (e.g. "Bullies PICK" vs "Bullies
// PICKS") before they silently create a duplicate Capper record. Pure
// functions only, no prisma import - safe for both client components
// (bulk-import-form.tsx) and server code.

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Standard Levenshtein (edit) distance - minimum single-character
// insertions/substitutions/deletions to turn `a` into `b`. Deliberately not
// a separate "strip trailing s" pass on top of this: a missing/extra "s"
// anywhere in the normalized name (including mid-string, e.g. "PICKS
// Office" vs "Pick Office" -> "picksoffice"/"pickoffice") is already exactly
// a single-character edit, so plain Levenshtein distance 1 already covers
// it, along with single added/dropped/swapped-character typos generally -
// confirmed against this app's real capper data before picking a threshold
// (see isLikelyDuplicateName).
export function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[rows - 1][cols - 1];
}

// How many edits apart two normalized names can be and still count as a
// likely typo of each other, scaled by length. Below 5 characters, only an
// exact match counts - this app has real cappers with short handles/
// initialisms (e.g. "AFS", "TBS", "YDC", "P4D"), and at that length a
// distance-1 or 2 edit routinely lands on a completely different real name
// ("AFS" -> "TBS" is distance 2). Validated against every real pairwise
// capper-name comparison in this app's production data before picking these
// numbers: this threshold caught genuine duplicates ("PICKS Office"/"Pick
// Office", "Dorm Room Degenerates"/"Dorm room degenerate") without flagging
// any of the many short-handle pairs, though it does still flag some
// longer near-misses that are plausibly two different real cappers (e.g.
// "SHARP"/"Shark") - expected, and exactly why a match is always a
// suggestion to confirm, never an automatic merge.
function fuzzyThreshold(minLength: number): number {
  if (minLength < 5) return 0;
  if (minLength <= 8) return 1;
  return 2;
}

// True if `a` and `b` are the same name (case/punctuation-insensitive) or a
// likely typo/singular-plural variant of each other.
export function isLikelyDuplicateName(a: string, b: string): boolean {
  return duplicateNameDistance(a, b) !== null;
}

// 0 for an exact (case/punctuation-insensitive) match, the edit distance for
// a within-threshold fuzzy match, or null if neither - lets callers that
// need the actual distance (e.g. sorting/display in a duplicate-scan list)
// get it without re-implementing the threshold logic above.
export function duplicateNameDistance(a: string, b: string): number | null {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.length === 0 || nb.length === 0) return na === nb ? 0 : null;
  if (na === nb) return 0;
  const distance = levenshteinDistance(na, nb);
  return distance <= fuzzyThreshold(Math.min(na.length, nb.length)) ? distance : null;
}

export type FuzzyNameMatch<T> = { item: T; distance: number };

// Among `candidates`, the closest fuzzy (non-exact) match to `name`, if any
// is within threshold - lowest edit distance wins; ties keep the first
// candidate encountered. Callers should check for an exact match separately
// first (this only reports genuine fuzzy - i.e. non-identical - matches).
export function findClosestFuzzyMatch<T>(name: string, candidates: T[], getName: (item: T) => string): FuzzyNameMatch<T> | null {
  const normalized = normalizeName(name);
  let best: FuzzyNameMatch<T> | null = null;

  for (const candidate of candidates) {
    const candidateName = normalizeName(getName(candidate));
    if (candidateName === normalized || candidateName.length === 0) continue;
    const distance = levenshteinDistance(normalized, candidateName);
    if (distance <= fuzzyThreshold(Math.min(normalized.length, candidateName.length))) {
      if (!best || distance < best.distance) best = { item: candidate, distance };
    }
  }

  return best;
}
