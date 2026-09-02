type BetTypeLike = "SPREAD" | "MONEYLINE" | "TOTAL" | "TEAM_TOTAL" | "PLAYER_PROP" | "NRFI";
type SideLike = "HOME" | "AWAY";

// Cappers occasionally spell a total out ("under nine" instead of "under 9") -
// one through twenty covers realistic bet totals (MLB/NBA/NFL totals don't
// realistically run higher, and nothing in this app's free-text bet details
// spells out a total as a compound word like "twenty-five" or a half like
// "eight and a half", so those intentionally aren't handled here).
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const NUMBER_WORD_PATTERN = new RegExp("\\b(" + Object.keys(NUMBER_WORDS).join("|") + ")\\b", "i");

function extractSpelledOutNumber(text: string): number | null {
  const match = text.match(NUMBER_WORD_PATTERN);
  return match ? NUMBER_WORDS[match[1].toLowerCase()] : null;
}

// Pulls the spread/total number out of free text, e.g. "Diamondbacks -1.5" -> -1.5,
// "Over 8.5" -> 8.5. Shared by the catalog parser (to store a real `line` at import
// time) and grading (as a fallback for older picks that predate the `line` column).
export function extractLine(betType: BetTypeLike, text: string): number | null {
  if (betType === "SPREAD") {
    const match = text.match(/([+-]\d+(\.\d+)?)/);
    return match ? parseFloat(match[1]) : null;
  }
  if (betType === "TOTAL" || betType === "TEAM_TOTAL") {
    // Prefer the number that actually follows "over"/"under" (or the o5.5/
    // u45.5 shorthand) - the real total line - over a bare "first number
    // anywhere in the text" scan. The old bare scan silently grabbed a
    // period marker's own digit instead: "First 5 Under 4.5" extracted 5
    // (from "First 5"), not 4.5; "1st Half Over 19.5" extracted 1 (from
    // "1st"). Confirmed against real logged picks during the Team Total
    // investigation - this corrupted the stored line on 17 real rows.
    const afterOverUnder =
      text.match(/\b(?:over|under)\s+(\d+(?:\.\d+)?)\b/i) ?? text.match(/\b[ou](\d+(?:\.\d+)?)\b/i);
    if (afterOverUnder) return parseFloat(afterOverUnder[1]);
    const match = text.match(/(\d+(\.\d+)?)/);
    if (match) return parseFloat(match[1]);
    return extractSpelledOutNumber(text);
  }
  return null;
}

// Favorite/underdog for Spread comes from the line's sign (negative = laying
// points = favorite). Not derivable for Total/Player Prop bets, which don't have
// a favored side.
//
// Moneyline prefers Pick.mlFavoredSide - the side that was actually favored per
// the real h2h market, captured at bulk-import time. The odds sign alone can't
// tell favorite from underdog in a juiced near-pick'em where BOTH sides are
// priced negative (e.g. -112 / -104), and every no-explicit-odds pick defaults
// to -110 and would read as a favorite regardless of side. Using mlFavoredSide
// needs pickedSide too (which side this pick is on); when either is missing - as
// it is for every pick predating that column, every manually entered pick, and
// any import where the market couldn't be resolved - it falls back to the
// original odds-sign heuristic, no better and no worse than before.
export function favoriteOrUnderdog(pick: {
  betType: BetTypeLike;
  odds: number;
  line: number | null;
  pickedSide?: SideLike | null;
  mlFavoredSide?: SideLike | null;
}): "FAVORITE" | "UNDERDOG" | null {
  if (pick.betType === "MONEYLINE") {
    if (pick.mlFavoredSide && pick.pickedSide) {
      return pick.pickedSide === pick.mlFavoredSide ? "FAVORITE" : "UNDERDOG";
    }
    if (pick.odds < 0) return "FAVORITE";
    if (pick.odds > 0) return "UNDERDOG";
    return null;
  }
  if (pick.betType === "SPREAD" && pick.line !== null) {
    if (pick.line < 0) return "FAVORITE";
    if (pick.line > 0) return "UNDERDOG";
    return null;
  }
  return null;
}

// The short label shown for a pick on every pick list (/picks, /cappers,
// /live, dashboard, ...). `betDetail` is the capper's own text ("Athletics
// Under"). When that text carries no line of its own but a `line` value was
// captured separately - the total-line confirmation flow at catalog import,
// or the manual pick form's dedicated line field - the number is appended so
// "Under" reads as "Under 7.5". Text that already expresses its line is
// returned untouched: "already expressed" is `extractLine` finding a number,
// the same check grading and import already trust, so "Over 8.5", "u220" and
// "under nine" are all left alone rather than getting a duplicate appended.
// Returns null when betDetail is empty, so each caller keeps its own betType-
// label fallback.
export function formatPickLabel(
  betDetail: string | null | undefined,
  betType: string,
  line: number | null | undefined
): string | null {
  if (!betDetail) return null;
  if (line === null || line === undefined) return betDetail;
  if (extractLine(betType as BetTypeLike, betDetail) !== null) return betDetail;
  const suffix = betType === "SPREAD" && line > 0 ? `+${line}` : `${line}`;
  return `${betDetail} ${suffix}`;
}

export type NrfiSide = "NO_RUN" | "YES_RUN";

// The NRFI/YRFI side of an NRFI-betType pick, derived from betDetail free
// text - same "never stored, always re-read" pattern as favoriteOrUnderdog's
// spread line and TOTAL's over/under side (see parseTouchdownProp's comment
// below). Shared by grading (win/loss against combined first-inning runs)
// and the category/scorecard classifiers, so a pick's side can never drift
// between "how it graded" and "which tile it counts toward". Returns null
// for text that matches neither phrasing (shouldn't happen for a real
// NRFI-betType pick); callers fall back to treating it as NRFI rather than
// dropping it, matching this function's pre-split behavior.
export function nrfiSide(betDetail: string | null): NrfiSide | null {
  const detail = (betDetail ?? "").toLowerCase();
  if (detail.includes("nrfi") || detail.includes("no run")) return "NO_RUN";
  if (detail.includes("yrfi") || detail.includes("yes run") || detail.includes("run 1st")) return "YES_RUN";
  return null;
}

export type TdPropType = "RUSHING" | "RECEIVING" | "ANY";

// Extracts the player and TD type from an NFL touchdown-prop pick's free
// text, e.g. "Puka Nacua Anytime TD" -> { playerName: "Puka Nacua", propType:
// "ANY" }. Deliberately not stored as structured Pick columns - same "derive
// from betDetail text every time" pattern this file already uses for
// SPREAD/TOTAL's line (see extractLine) and the same pattern grading.ts uses
// for TOTAL's over/under side and NRFI's yes/no side (never stored, always
// re-read from betDetail). Called once at catalog-import time (to classify
// the pick's betType) and again at grading time (to know who to look up in
// the box score) - both calls read the same stored betDetail, so they always
// agree with no separate schema to keep in sync.
//
// Returns null if the text has no touchdown-prop signal at all. Player-name
// extraction is a best-effort strip of TD-related words, not a full NLP
// parse - it assumes the player's name is the part of the text that ISN'T
// TD terminology (a reasonable assumption for how these are typically
// written: name first, prop description after, same convention team-based
// picks already use - "Cubs -1.5", not "-1.5 Cubs"). A capper who also
// includes the player's team name (needed for game resolution, e.g. "Rams
// Puka Nacua Anytime TD") will leave that team name in the extracted
// "player name" here - callers that know the pick's real matched team names
// (grading.ts does, via the resolved game) should strip those separately
// before fuzzy-matching against a real roster; this function has no team
// knowledge of its own; unresolved names beyond a Levenshtein tolerance
// safely fail to match rather than grading incorrectly.
export function parseTouchdownProp(text: string): { playerName: string; propType: TdPropType } | null {
  if (!/\btouchdowns?\b/i.test(text) && !/\btds?\b/i.test(text)) return null;

  const isRushing = /\brush(?:ing|er)?\b/i.test(text);
  const isReceiving = /\b(receiving|reception|receptions|receiver|catches|catch|rec)\b/i.test(text);
  const propType: TdPropType = isRushing ? "RUSHING" : isReceiving ? "RECEIVING" : "ANY";

  const playerName = text
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bany\s*time\b/gi, " ")
    .replace(/\bor\s+more\b/gi, " ")
    .replace(/\b\d+\+?/g, " ")
    .replace(/\b(rushing|rusher|rush|receiving|reception|receptions|rec|receiver|catches|catch|scorer|anytime)\b/gi, " ")
    .replace(/\btouchdowns?\b/gi, " ")
    .replace(/\btds?\b/gi, " ")
    .replace(/[+-]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!playerName) return null;

  return { playerName, propType };
}

// Coarse, fixed odds bands - no precedent for this anywhere else in the app
// (odds is a raw Int on Pick), and MLB/NFL/NBA all use roughly the same
// American-odds shape, so one universal set of bands works across sports.
// Deliberately broad rather than tight (e.g. the classic -110/-120/-130
// splits) - narrower bands would leave most cappers without a real sample in
// more than one bucket to compare, defeating the point of "which range are
// they best in." Lives here (not server/data/stats.ts, its only consumer
// until the capper comparison tool) specifically because it's pure and
// needs to be importable from a "use client" component - stats.ts has a
// module-level prisma import, which taints anything defined there for
// client-bundle purposes even if the function itself never touches prisma.
export type OddsBucketKey = "HEAVY_FAV" | "FAV" | "EVEN" | "DOG" | "HEAVY_DOG";

export const ODDS_BUCKET_LABELS: Record<OddsBucketKey, string> = {
  HEAVY_FAV: "-200 or shorter",
  FAV: "-199 to -110",
  EVEN: "-109 to +109",
  DOG: "+110 to +199",
  HEAVY_DOG: "+200 or longer",
};

export function oddsBucket(odds: number): OddsBucketKey {
  if (odds <= -200) return "HEAVY_FAV";
  if (odds <= -110) return "FAV";
  if (odds <= 109) return "EVEN";
  if (odds <= 199) return "DOG";
  return "HEAVY_DOG";
}
