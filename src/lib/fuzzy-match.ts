// Shared name-matching logic for cappers - exact-normalized matching (used
// throughout catalog parsing/import) plus fuzzy matching for catching likely
// typos and singular/plural mismatches (e.g. "Bullies PICK" vs "Bullies
// PICKS") before they silently create a duplicate Capper record. Pure
// functions only, no prisma import - safe for both client components
// (bulk-import-form.tsx) and server code.

// "Jokić" -> "Jokic", "Porziņģis" -> "Porzingis", "Şengün" -> "Sengun": the
// letters without their accent marks. normalizeName below drops every non a-z
// character, so an accented name has to be folded first or its accented
// letters vanish ("jokić" -> "joki") instead of matching the plain spelling
// ESPN's rosters use.
export function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

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

// Plural-insensitive identity for capper names, used to widen the "did you mean"
// prompt to a name that differs from a saved capper only by plural "s", which
// plain Levenshtein misses when the "s" is mid-string. It only ever produces a
// SUGGESTION: nothing is merged until a person answers the prompt.
//
// Two keys per name, matched if EITHER agrees:
//   - whole: normalizeName with one trailing "s" dropped
//     ("codycoversspreads" -> "codycoversspread").
//   - perWord: one trailing "s" dropped from EACH whitespace-separated word,
//     then joined ("Cody covers spreads" -> "codycoverspread"). This catches a
//     mid-string "s" ("Codycoverspreads" vs "Cody covers spreads").
// Names under 5 normalized characters get no plural stripping (same floor as
// fuzzyThreshold): short handles like "AFS" / "TBS" stay exact-only.
const MIN_PLURAL_KEY_LENGTH = 5;

export function capperKeys(name: string): string[] {
  const exact = normalizeName(name);
  if (exact.length < MIN_PLURAL_KEY_LENGTH) return [exact];
  const stripS = (s: string) => (s.length > 1 && s.endsWith("s") ? s.slice(0, -1) : s);
  const whole = stripS(exact);
  const perWord = name
    .split(/\s+/)
    .map((w) => stripS(normalizeName(w)))
    .join("");
  return [exact, whole, perWord];
}

export function findCanonicalCapperMatch(name: string, candidates: readonly string[]): string | null {
  const mine = capperKeys(name).filter((k) => k !== "");
  if (mine.length === 0) return null;
  for (const c of candidates) {
    if (normalizeName(c).length < MIN_PLURAL_KEY_LENGTH) continue;
    if (normalizeName(c) === normalizeName(name)) continue;
    if (capperKeys(c).some((k) => k !== "" && mine.includes(k))) return c;
  }
  return null;
}

// True when `a` and `b` (already normalized) differ by exactly one inserted/removed "s" and nothing else.
function differsByOneS(a: string, b: string): boolean {
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (long.length !== short.length + 1) return false;
  for (let i = 0; i < long.length; i++) {
    if (long[i] === "s" && long.slice(0, i) + long.slice(i + 1) === short) return true;
  }
  return false;
}

// The ONE saved capper `name` is, apart from a single added/dropped "s" (anywhere in the squashed name).
// Narrow on purpose: both names must be at least MIN_PLURAL_KEY_LENGTH normalized characters (short handles
// stay a question), exactly one saved capper may qualify, and no OTHER saved capper may be a suggestion-level
// match either (any ambiguity stays a question). Null otherwise.
export function findPluralOnlyMatch(name: string, candidates: readonly string[]): string | null {
  const n = normalizeName(name);
  if (n.length < MIN_PLURAL_KEY_LENGTH) return null;
  const hits = candidates.filter((c) => {
    const m = normalizeName(c);
    return m.length >= MIN_PLURAL_KEY_LENGTH && differsByOneS(n, m);
  });
  if (hits.length === 0) return null;
  if (new Set(hits.map(normalizeName)).size !== 1) return null;
  const hit = hits[0];
  const others = candidates.filter((c) => normalizeName(c) !== normalizeName(hit));
  if (findCanonicalCapperMatch(name, others) !== null) return null;
  if (findClosestFuzzyMatch(name, others as string[], (x) => x) !== null) return null;
  return hit;
}

// A person's answer to one "did you mean" prompt, keyed by the NAME PAIR: the
// normalized name as typed and the normalized saved name it was compared to.
export type CapperNameDecisionKind = "SAME" | "DIFFERENT";
export type StoredCapperNameDecision = { rawKey: string; suggestedKey: string; decision: CapperNameDecisionKind };

export function capperPairKeys(raw: string, suggestion: string): { rawKey: string; suggestedKey: string } {
  return { rawKey: normalizeName(raw), suggestedKey: normalizeName(suggestion) };
}

// What an import should do with a parsed capper name:
//   - suggestion null: exact match or nothing close - no prompt.
//   - suggestion set, remembered null: a new pair - ask.
//   - remembered SAME / DIFFERENT: this exact pair was answered before - reuse it, no prompt.
// An unanswered pair is never resolved either way.
export function resolveCapperNameSuggestion(
  name: string,
  existing: readonly string[],
  decisions: readonly StoredCapperNameDecision[]
): { suggestion: string | null; remembered: CapperNameDecisionKind | null; auto?: boolean } {
  const normalized = normalizeName(name);
  if (existing.some((n) => normalizeName(n) === normalized && normalized !== "")) return { suggestion: null, remembered: null };
  const suggestion =
    findCanonicalCapperMatch(name, existing) ?? findClosestFuzzyMatch(name, existing as string[], (n) => n)?.item ?? null;
  if (!suggestion) return { suggestion: null, remembered: null };
  const { rawKey, suggestedKey } = capperPairKeys(name, suggestion);
  const hit = decisions.find((d) => d.rawKey === rawKey && d.suggestedKey === suggestedKey);
  if (hit) return { suggestion, remembered: hit.decision };
  // Never answered, and the only difference is one "s" from exactly one saved capper: file it there without
  // asking (reported as a remembered SAME so every caller rewrites the name the same way). A stored
  // DIFFERENT answer above always wins; anything else stays a question.
  const plural = findPluralOnlyMatch(name, existing);
  if (plural) return { suggestion: plural, remembered: "SAME", auto: true };
  return { suggestion, remembered: null };
}
