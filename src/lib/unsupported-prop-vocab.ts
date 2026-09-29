// Detection of MLB/NHL (and other not-yet-supported) player-prop vocabulary in
// a pasted catalog line. This app has no MLB/NHL prop markets yet (PropMarket
// is NFL-only - see schema.prisma), so a line like "Chris Sale over 5.5 K" or
// "Ivan Demidov 2+ shots on goal" can't be imported. What it must NEVER do is
// what it used to: get read as a capper-name header (silent drop), get
// classified as a game TOTAL/MONEYLINE (wrong data), or be claimed by the
// tennis-surname fallback (wrong sport). parse-catalog.ts uses this to route
// such lines to `unresolved` with an honest reason.
//
// Pure (no imports from parse-catalog.ts, which imports this). The one thing
// it can't decide alone is "is the words before the number a TEAM?", needed
// for words that are also ordinary game-total vocabulary ("Yankees over 4.5
// runs", "Lakers over 220.5 points") - callers pass that in as `isTeamSubject`.
//
// Deliberately number-adjacent: every pattern needs the stat word to sit next
// to an over/under number, an "N+" threshold, or be an unmistakable phrase
// ("goal scorer", "shots on goal"), so a capper HEADER that merely contains a
// word like "Hits", "HR" or "Points" ("HR Kings", "Hits Only 12-2") is never
// mistaken for a pick.

const NUM = String.raw`\d+(?:\.\d+)?`;

// Stat words that are only ever a player/goalie/pitcher stat, never a game
// total: safe to flag no matter who the subject is.
const STRONG_WORDS = [
  String.raw`shots?\s+on\s+goal`,
  String.raw`sogs?`,
  String.raw`strike\s?outs?`,
  String.raw`ks?`,
  String.raw`outs(?:\s+recorded)?`,
  String.raw`total\s+bases`,
  String.raw`stolen\s+bases`,
  String.raw`rbis?`,
  String.raw`hits`,
  String.raw`saves`,
  String.raw`home\s?runs?`,
  String.raw`hrs?`,
].join("|");

// Words that are ALSO ordinary game/team-total vocabulary - only a prop when
// the subject before the number is a person, not a team.
const AMBIGUOUS_WORDS = [String.raw`runs?`, String.raw`points?`, String.raw`pts`, String.raw`assists?`].join("|");

const ANY_WORDS = STRONG_WORDS + "|" + AMBIGUOUS_WORDS;

const BOUNDARY_BEFORE = String.raw`(?<![\w.])`;

// "over 5.5 K", "u4.5 Ks", "o 17.5 outs"
const OVER_UNDER_THEN_WORD = new RegExp(`${BOUNDARY_BEFORE}(?:over|under|o|u)\\s*${NUM}\\s*(${ANY_WORDS})\\b`, "i");
// "Ks over 5.5", "shots on goal o2.5"
const WORD_THEN_OVER_UNDER = new RegExp(`\\b(${STRONG_WORDS})\\s+(?:over|under|o|u)\\s*${NUM}\\b`, "i");
// "2+ shots on goal", "3+ Ks", "2+ points" - N+ threshold format. The lookbehind
// keeps a won-loss record ("8-1") from being read as a threshold.
const N_PLUS_THEN_WORD = new RegExp(`(?<![\\w.-])\\d+\\+\\s*(${ANY_WORDS})\\b`, "i");
// "6 Ks", "5.5 strikeouts" with no over/under - restricted to the words that
// are unambiguous even bare, and to a number that isn't part of a record.
const BARE_NUM_THEN_STRONG = new RegExp(
  `(?<![\\w.-])${NUM}\\s*(strike\\s?outs?|ks|total\\s+bases|shots?\\s+on\\s+goal)\\b`,
  "i"
);
// Unmistakable phrases that need no number at all.
const PHRASES: RegExp[] = [
  /\bgoal\s*scorers?\b/i,
  /\bshots?\s+on\s+goal\b/i,
  /\bto\s+hit\s+a\s+(?:home\s?run|hr)\b/i,
  /\b(?:anytime|any\s*time|first|1st|last)\s+(?:home\s?run|hr)\b/i,
];

// A subject that reads like a person's name: 1-4 capitalized words, no digits.
const PERSON_SHAPE = /^[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3}$/;

const NHL_WORDS = /\b(?:shots?\s+on\s+goal|sogs?|goal\s*scorers?|saves)\b/i;
const MLB_WORDS = /\b(?:strike\s?outs?|ks?|outs|total\s+bases|stolen\s+bases|rbis?|hits|home\s?runs?|hrs?|runs?)\b/i;

export const UNSUPPORTED_PROP_REASONS = {
  MLB: "MLB player props aren't supported yet",
  NHL: "NHL player props aren't supported yet",
  GENERIC: "Player prop not supported yet",
} as const;

export type UnsupportedPropInfo = { sport: "MLB" | "NHL" | null; reason: string };

// Everything before `index`, with sport codes / parentheticals / a leading
// emoji removed - what's left is the "who is this bet on" text.
function subjectBefore(text: string, index: number): string {
  return text
    .slice(0, index)
    .replace(/\([^)]*\)/g, " ")
    .replace(/^[^\w]+/, "")
    .replace(/\b(?:MLB|NHL)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function reasonFor(text: string, matchedWord: string): UnsupportedPropInfo {
  const hasMlb = /\bMLB\b/i.test(text);
  const hasNhl = /\bNHL\b/i.test(text);
  let sport: "MLB" | "NHL" | null = null;
  if (hasMlb && !hasNhl) sport = "MLB";
  else if (hasNhl && !hasMlb) sport = "NHL";
  else if (!hasMlb && !hasNhl) {
    // No explicit code: infer from the stat vocabulary. "points"/"assists"
    // alone stay unknown (NBA/WNBA use them too).
    if (NHL_WORDS.test(matchedWord) || NHL_WORDS.test(text)) sport = "NHL";
    else if (MLB_WORDS.test(matchedWord)) sport = "MLB";
  }
  return { sport, reason: sport ? UNSUPPORTED_PROP_REASONS[sport] : UNSUPPORTED_PROP_REASONS.GENERIC };
}

// Returns non-null when `text` is an MLB/NHL-style player-prop line this app
// can't import. `isTeamSubject(subject)` must return true when the text
// before the stat number names a team/sport (so "Yankees over 4.5 runs" and
// "NBA LeBron James over 25.5 points" are left to the normal resolvers).
export function detectUnsupportedProp(
  text: string,
  isTeamSubject: (subject: string) => boolean = () => false
): UnsupportedPropInfo | null {
  for (const phrase of PHRASES) {
    const m = phrase.exec(text);
    if (m) return reasonFor(text, m[0]);
  }

  for (const re of [OVER_UNDER_THEN_WORD, WORD_THEN_OVER_UNDER, N_PLUS_THEN_WORD, BARE_NUM_THEN_STRONG]) {
    const m = re.exec(text);
    if (!m) continue;
    const word = m[1];
    const strong = new RegExp(`^(?:${STRONG_WORDS})$`, "i").test(word);
    if (!strong) {
      // Ambiguous word (runs/points/assists): a prop only when the subject is
      // a person. An empty subject ("Over 8.5 runs") or a team is a game total.
      const subject = subjectBefore(text, m.index);
      if (!subject || !PERSON_SHAPE.test(subject) || isTeamSubject(subject)) continue;
    }
    return reasonFor(text, word);
  }
  return null;
}
