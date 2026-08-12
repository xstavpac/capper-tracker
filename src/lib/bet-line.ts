type BetTypeLike = "SPREAD" | "MONEYLINE" | "TOTAL" | "PLAYER_PROP" | "NRFI";

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
  if (betType === "TOTAL") {
    const match = text.match(/(\d+(\.\d+)?)/);
    if (match) return parseFloat(match[1]);
    return extractSpelledOutNumber(text);
  }
  return null;
}

// Favorite/underdog for Moneyline comes straight from the odds sign. For Spread it
// comes from the line's sign (negative = laying points = favorite). Not derivable
// for Total/Player Prop bets, which don't have a favored side.
export function favoriteOrUnderdog(pick: {
  betType: BetTypeLike;
  odds: number;
  line: number | null;
}): "FAVORITE" | "UNDERDOG" | null {
  if (pick.betType === "MONEYLINE") {
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
