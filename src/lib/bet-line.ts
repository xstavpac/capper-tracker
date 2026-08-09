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
