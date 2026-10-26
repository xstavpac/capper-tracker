// Spelled-out numbers in bet text. Pure (no imports), so every parser can use it.

// Cappers occasionally spell a total out ("under nine" instead of "under 9") -
// one through twenty covers realistic bet totals (MLB/NBA/NFL totals don't
// realistically run higher, and nothing in this app's free-text bet details
// spells out a total as a compound word like "twenty-five" or a half like
// "eight and a half", so those intentionally aren't handled for TOTAL bets).
export const NUMBER_WORDS: Record<string, number> = {
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

// "over six receptions" / "under two and a half shots on goal" -> "over 6
// receptions" / "under 2.5 shots on goal", for the player-prop parsers and the
// line reader every prop grader goes through. Without it the number word is left
// in the player name ("Travis Kelce six"), the roster match fails, and no line is
// read.
//
// Deliberately narrow, so any text it doesn't recognize comes back byte-identical:
//   - only a number word DIRECTLY after the word "over" or "under" ("o six" /
//     "u two" are not a format anyone writes);
//   - one through twenty, plus "and a half" (X.5) - props lines are nearly always
//     a half; no other compound ("six point five");
//   - not when the word is part of a longer number ("one hundred", "twenty-five",
//     "twenty five", "six point five") - those are left exactly as typed;
//     or, for "three", a market name ("three pointers", "three-pt", "three
//     point"): those stay as typed, so a "three pointers" market keeps reading as
//     that market.
const WORDS = Object.keys(NUMBER_WORDS).join("|");
const SPELLED_OUT_PROP_LINE = new RegExp(
  String.raw`\b(over|under)(\s+)(${WORDS})(\s+and\s+a\s+half)?\b(?!-|\s+(?:hundred|thousand|point|${WORDS})\b)`,
  "gi"
);
const THREE_POINTER_MARKET = /^\s*-?\s*(?:point|pointer|pt)s?\b/i;

export function normalizeSpelledOutPropNumber(text: string): string {
  return text.replace(SPELLED_OUT_PROP_LINE, (match: string, side: string, space: string, word: string, half: string | undefined, offset: number) => {
    if (word.toLowerCase() === "three" && !half && THREE_POINTER_MARKET.test(text.slice(offset + match.length))) return match;
    return side + space + (NUMBER_WORDS[word.toLowerCase()] + (half ? 0.5 : 0));
  });
}
