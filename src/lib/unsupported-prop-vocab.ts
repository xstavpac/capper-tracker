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
// Basketball stats (points/rebounds/assists/threes/PRA/steals/blocks) are here
// too: "Lakers over 45.5 rebounds" is a team stat, so they need a person
// subject exactly like "runs" does.
const AMBIGUOUS_WORDS = [
  String.raw`pts\s*\+\s*reb\s*\+\s*ast`,
  String.raw`runs?`,
  String.raw`points?`,
  String.raw`pts`,
  String.raw`rebounds?`,
  String.raw`rebs?`,
  String.raw`assists?`,
  String.raw`threes`,
  String.raw`3-?pointers?`,
  String.raw`pra`,
  String.raw`steals?`,
  String.raw`blocks?`,
  String.raw`turnovers?`,
  String.raw`fouls?`,
  String.raw`corners?`,
  String.raw`penalt(?:y|ies)`,
].join("|");

// The scoring words among the above (plus runs): a TEAM subject with one of
// these is an ordinary game/team total and is never touched. Every other
// stat word with a team subject ("Lakers over 45.5 rebounds") is a team STAT
// total, which this app has no market or grader for.
const SCORING_WORDS = /^(?:runs?|points?|pts)$/i;

// NFL stats that only exist as N+ props this app can't grade. Deliberately
// excludes the supported yardage/receptions markets and TDs - those are
// handled by normalizeNPlusPlayerProp / parseTouchdownProp (bet-line.ts).
const NFL_UNSUPPORTED_WORDS = [
  String.raw`(?:(?:pass(?:ing)?|rush(?:ing)?|rec(?:eiving)?)\s+)?(?:completions?|attempts?|carries|targets?)`,
  String.raw`sacks?`,
  String.raw`(?:solo\s+)?tackles?`,
  String.raw`interceptions?`,
  String.raw`ints?`,
  String.raw`field\s+goals?`,
  String.raw`fgs?`,
  String.raw`extra\s+points?`,
].join("|");
// Both threshold spellings: "3+ sacks" and "over 22.5 passing completions" /
// "u34.5 pass attempts".
const NFL_UNSUPPORTED_STAT = new RegExp(
  `(?:(?<![\\w.-])\\d+\\+|(?<![\\w.])(?:over|under|o|u)\\s*\\d+(?:\\.\\d+)?)\\s*(?:${NFL_UNSUPPORTED_WORDS})\\b`,
  "i"
);

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

// A trailing "over 30.5" / "30+" left on a subject sliced off just before a stat phrase.
const TRAILING_NUMBER = new RegExp(String.raw`\s*(?:(?:over|under|o|u)\s*)?${NUM}\+?\s*$`, "i");

// A subject that reads like a person's name: 1-4 capitalized words, no digits.
const PERSON_SHAPE = /^[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3}$/;

const NHL_WORDS = /\b(?:shots?\s+on\s+goal|sogs?|goal\s*scorers?|saves)\b/i;
const MLB_WORDS = /\b(?:strike\s?outs?|ks?|outs|total\s+bases|stolen\s+bases|rbis?|hits|home\s?runs?|hrs?|runs?)\b/i;

export const UNSUPPORTED_PROP_REASONS = {
  MLB: "MLB player props aren't supported yet",
  NHL: "NHL player props aren't supported yet",
  NBA: "NBA player props aren't supported yet",
  WNBA: "WNBA player props aren't supported yet",
  NFL: "This NFL prop market isn't supported yet",
  TEAM_STAT: "Team stat totals aren't supported yet",
  GAME_STAT: "Game stat totals aren't supported yet",
  GENERIC: "Player prop not supported yet",
} as const;

export type UnsupportedPropInfo = { sport: "MLB" | "NHL" | "NBA" | "WNBA" | "NFL" | null; reason: string };

// Everything before `index`, with sport codes / parentheticals / a leading
// emoji removed - what's left is the "who is this bet on" text.
function subjectBefore(text: string, index: number): string {
  return text
    .slice(0, index)
    .replace(/\([^)]*\)/g, " ")
    .replace(/^[^\w]+/, "")
    .replace(/\b(?:MLB|NHL|NBA|WNBA)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function reasonFor(text: string, matchedWord: string): UnsupportedPropInfo {
  // An explicit sport code wins - but only when exactly one of the four is
  // present (two on one line is ambiguous, so it falls back to vocabulary).
  const codes = (["MLB", "NHL", "NBA", "WNBA"] as const).filter((c) => new RegExp("\\b" + c + "\\b", "i").test(text));
  let sport: "MLB" | "NHL" | "NBA" | "WNBA" | null = codes.length === 1 ? codes[0] : null;
  if (codes.length === 0) {
    // No explicit code: infer from the stat vocabulary. "points"/"assists"
    // and the basketball-only words stay unknown (NBA and WNBA share them,
    // NHL uses points/assists) - the generic reason is honest there.
    if (NHL_WORDS.test(matchedWord) || NHL_WORDS.test(text)) sport = "NHL";
    else if (MLB_WORDS.test(matchedWord)) sport = "MLB";
  }
  return { sport, reason: sport ? UNSUPPORTED_PROP_REASONS[sport] : UNSUPPORTED_PROP_REASONS.GENERIC };
}

// "3+ sacks" / "over 22.5 passing completions": an NFL prop, in either
// threshold spelling, for a stat this app doesn't grade. Separate from
// detectUnsupportedProp because the caller must check it BEFORE its "an NFL
// prop parsePlayerProp recognizes is never flagged" early return -
// parsePlayerProp reads "passing completions" as PASS_YDS (bare "passing"
// matches), which would otherwise import it as a yardage pick.
export function detectUnsupportedNflStat(text: string): UnsupportedPropInfo | null {
  return NFL_UNSUPPORTED_STAT.test(text) ? { sport: "NFL", reason: UNSUPPORTED_PROP_REASONS.NFL } : null;
}

// How a "who is this bet on" subject reads. "matchup-game": both sides of an
// "X vs Y" / "X @ Y" are nothing but teams. "matchup-player": the second side
// is a recognized team PLUS extra words (a pitcher/skater's name after the
// matchup: "Yankees vs Red Sox Schlittler"). "matchup-unknown": a matchup shape
// whose sides the team lists can't classify.
type SubjectKind = "team" | "person" | "matchup-game" | "matchup-player" | "matchup-unknown" | "other";

// `classifyTeamSide(side)`: "team" when the whole side is a team name, "team+extra" when
// it contains a team name and other words, "none" when it has no recognized team.
export type TeamSideClass = "team" | "team+extra" | "none";

function subjectKind(
  subject: string,
  isTeamSubject: (s: string) => boolean,
  classifyTeamSide: (side: string) => TeamSideClass
): SubjectKind {
  if (!subject) return "other";
  const matchup = /^(.+?)\s+(?:vs\.?|@)\s+(.+)$/i.exec(subject);
  if (matchup) {
    const a = classifyTeamSide(matchup[1]);
    const b = classifyTeamSide(matchup[2]);
    if (a === "team" && b === "team") return "matchup-game";
    if (b === "team+extra") return "matchup-player";
    return "matchup-unknown";
  }
  if (!PERSON_SHAPE.test(subject)) return "other";
  return isTeamSubject(subject) ? "team" : "person";
}

// Returns non-null when `text` is an MLB/NHL/NBA-style player-prop (or
// team/game stat total) line this app can't import. `isTeamSubject(subject)`
// must return true when the text before the stat number names a team/sport
// (so "Yankees over 4.5 runs" and "NBA Lakers over 220.5 points" are left to
// the normal resolvers); `classifyTeamSide` does the same for each side of an
// "X vs Y" matchup.
export function detectUnsupportedProp(
  text: string,
  isTeamSubject: (subject: string) => boolean = () => false,
  classifyTeamSide: (side: string) => TeamSideClass = () => "none"
): UnsupportedPropInfo | null {
  const teamStat = { sport: null, reason: UNSUPPORTED_PROP_REASONS.TEAM_STAT } as const;
  const gameStat = { sport: null, reason: UNSUPPORTED_PROP_REASONS.GAME_STAT } as const;

  for (const phrase of PHRASES) {
    const m = phrase.exec(text);
    if (!m) continue;
    // "Oilers over 30.5 shots on goal" / "Oilers vs Flames over 60.5 shots on
    // goal" - a team's or a game's shots total, not a skater's prop.
    if (/shots?\s+on\s+goal/i.test(m[0])) {
      const subject = subjectBefore(text, m.index).replace(TRAILING_NUMBER, "");
      const kind = subjectKind(subject, isTeamSubject, classifyTeamSide);
      if (kind === "team") return teamStat;
      if (kind === "matchup-game") return gameStat;
    }
    return reasonFor(text, m[0]);
  }

  for (const re of [OVER_UNDER_THEN_WORD, WORD_THEN_OVER_UNDER, N_PLUS_THEN_WORD, BARE_NUM_THEN_STRONG]) {
    const m = re.exec(text);
    if (!m) continue;
    const word = m[1];
    const strong = new RegExp(`^(?:${STRONG_WORDS})$`, "i").test(word);
    const nonScoring = !SCORING_WORDS.test(word);
    const kind = subjectKind(subjectBefore(text, m.index), isTeamSubject, classifyTeamSide);

    if (nonScoring) {
      // A stat total for a whole team / a whole game ("Lakers over 45.5
      // rebounds", "Yankees vs Red Sox over 20.5 hits") - not a scoring total
      // (left untouched) and not a player prop. Never a TOTAL.
      if (kind === "team") return teamStat;
      if (kind === "matchup-game") return gameStat;
      // A matchup we can't classify + a word that is only a stat in some
      // sports: treat as a game stat total. (A strong word keeps the
      // player-prop reason below, as before.)
      if (kind === "matchup-unknown" && !strong) return gameStat;
    }
    if (!strong) {
      // Ambiguous word: a prop only for a person subject - or, for a
      // non-scoring stat, a matchup followed by the player's name. Scoring
      // words (runs/points/pts) on a matchup or team stay ordinary totals.
      const personLike = kind === "person" || (nonScoring && kind === "matchup-player");
      if (!personLike) continue;
    }
    return reasonFor(text, word);
  }
  return null;
}
