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

// Strips a trailing "(G1)"/"(G2)" doubleheader marker (see parse-catalog.ts's
// withGameNumberSuffix) before any number extraction runs below - otherwise
// TOTAL's bare-number fallback would misread the "2" in "Cubs Total (G2)" as
// the total line itself. Every other extractLine caller passes text with no
// such suffix, so this is a no-op for them.
function stripGameNumberSuffix(text: string): string {
  return text.replace(/\s*\(G[12]\)\s*$/i, "");
}

// Pulls the spread/total number out of free text, e.g. "Diamondbacks -1.5" -> -1.5,
// "Over 8.5" -> 8.5. Shared by the catalog parser (to store a real `line` at import
// time) and grading (as a fallback for older picks that predate the `line` column).
export function extractLine(betType: BetTypeLike, rawText: string): number | null {
  const text = stripGameNumberSuffix(rawText);
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

// Human-readable label for a raw BetType enum value, for anywhere one is
// shown to the user (catalog-import review, Live tab pick cards, etc.) -
// the enum itself (PLAYER_PROP, MONEYLINE, ...) must never leak into the UI
// as-is. Client-safe (no prisma import) so client components can call it
// directly instead of pulling in server/data/stats.ts's module-level prisma
// import just for this.
export function betTypeLabel(betType: string): string {
  switch (betType) {
    case "SPREAD":
      return "Spread";
    case "MONEYLINE":
      return "Moneyline";
    case "TOTAL":
      return "Total";
    case "TEAM_TOTAL":
      return "Team Total";
    case "PLAYER_PROP":
      return "Player Prop";
    case "NRFI":
      return "NRFI";
    default:
      return betType;
  }
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

export type TotalSide = "OVER" | "UNDER";

// The Over/Under side of a TOTAL or TEAM_TOTAL pick, derived from betDetail
// free text - same "never stored, always re-read" pattern as nrfiSide above.
// Extracted out of gradePick (grading.ts), which previously inlined this same
// detail.includes("over")/detail.includes("under") check independently at
// its TOTAL and TEAM_TOTAL branches - one shared function means grading and
// any other caller (e.g. the pick display-label generator) can never
// disagree on which side a pick's text names. "Over" wins when text somehow
// names both (matches the original inline behavior, where the TOTAL/
// TEAM_TOTAL branches checked isOver before isUnder and returned early).
export function totalSideFromText(betDetail: string | null): TotalSide | null {
  const detail = (betDetail ?? "").toLowerCase();
  if (detail.includes("over")) return "OVER";
  if (detail.includes("under")) return "UNDER";
  return null;
}

// Which slice of a game a pick's free text scopes it to, re-derived from
// betDetail every time - the same "never stored, always re-read from
// betDetail" pattern this file already uses for TOTAL's over/under side and
// NRFI's yes/no side. Also the single source of truth for the pick's
// Period: parse-catalog.ts maps this onto Period at import time, and
// grading.ts re-runs it as a cross-check so an old / mis-tagged pick can
// still grade (or safely decline) off its own text.
//
// The string values line up 1:1 with Prisma's Period enum, plus one extra:
//   FULL_GAME      -> GameResult.homeScore / awayScore
//   FIRST_HALF     -> GameResult.firstFive{Home,Away}Score  (F5 for MLB,
//                     Q1+Q2 for NFL/NBA/WNBA/NCAAF - see persistFinalScores)
//   SECOND_HALF    -> final minus first half (includes OT, as books grade it)
//   FIRST_QUARTER..FOURTH_QUARTER   -> GameResult.linescoreJson[0..3]
//                     (NFL, NBA, WNBA, NCAAF)
//   FIRST_PERIOD..THIRD_PERIOD      -> GameResult.linescoreJson[0..2]  (NHL)
//   UNSUPPORTED_SEGMENT -> a segment with no score source at all (a single
//                     inning outside MLB's F5 path, etc.) - grading returns
//                     null so the pick stays PENDING for manual grading
//                     rather than being graded against the full-game score.
//
// A segment that IS a known Period but has no data for a specific game (the
// linescore array came back short, first-half score never captured) also
// ends up PENDING - that check lives in grading.ts, not here.
export type SegmentPeriod =
  | "FULL_GAME"
  | "FIRST_HALF"
  | "SECOND_HALF"
  | "FIRST_QUARTER"
  | "SECOND_QUARTER"
  | "THIRD_QUARTER"
  | "FOURTH_QUARTER"
  | "FIRST_PERIOD"
  | "SECOND_PERIOD"
  | "THIRD_PERIOD";

export type BetScope = SegmentPeriod | "UNSUPPORTED_SEGMENT";

// First match wins, so order matters: quarters and hockey periods (the most
// specific phrasings) are tested before the broader half patterns, and the
// inning fallback is last. Every pattern is word-boundaried and lower-cased.
const BET_SCOPE_RULES: [RegExp, BetScope][] = [
  // ---- Quarters (NFL / NBA / WNBA / NCAAF) ----
  [/\b(1st|first)[\s.-]*(quarter|qtr)\b/, "FIRST_QUARTER"],
  [/\b(2nd|second)[\s.-]*(quarter|qtr)\b/, "SECOND_QUARTER"],
  [/\b(3rd|third)[\s.-]*(quarter|qtr)\b/, "THIRD_QUARTER"],
  [/\b(4th|fourth)[\s.-]*(quarter|qtr)\b/, "FOURTH_QUARTER"],
  [/\b(quarter|qtr)\s*1\b/, "FIRST_QUARTER"],
  [/\b(quarter|qtr)\s*2\b/, "SECOND_QUARTER"],
  [/\b(quarter|qtr)\s*3\b/, "THIRD_QUARTER"],
  [/\b(quarter|qtr)\s*4\b/, "FOURTH_QUARTER"],
  [/\bq1\b/, "FIRST_QUARTER"],
  [/\bq2\b/, "SECOND_QUARTER"],
  [/\bq3\b/, "THIRD_QUARTER"],
  [/\bq4\b/, "FOURTH_QUARTER"],
  [/\b1q\b/, "FIRST_QUARTER"],
  [/\b2q\b/, "SECOND_QUARTER"],
  [/\b3q\b/, "THIRD_QUARTER"],
  [/\b4q\b/, "FOURTH_QUARTER"],
  // ---- Hockey periods (NHL) ----
  // Spelled forms only for the "Nth period" phrasing; "P1/P2/P3" solid is
  // safe, but the reverse "1P/2P/3P" is deliberately NOT matched - "3P" is
  // an NBA three-pointers prop.
  [/\b(1st|first)[\s.-]*period\b/, "FIRST_PERIOD"],
  [/\b(2nd|second)[\s.-]*period\b/, "SECOND_PERIOD"],
  [/\b(3rd|third)[\s.-]*period\b/, "THIRD_PERIOD"],
  [/\bperiod\s*1\b/, "FIRST_PERIOD"],
  [/\bperiod\s*2\b/, "SECOND_PERIOD"],
  [/\bperiod\s*3\b/, "THIRD_PERIOD"],
  [/\bp1\b/, "FIRST_PERIOD"],
  [/\bp2\b/, "SECOND_PERIOD"],
  [/\bp3\b/, "THIRD_PERIOD"],
  // ---- Second half ----
  [/\b(2nd|second)[\s.-]*half\b/, "SECOND_HALF"],
  [/\b2h\b/, "SECOND_HALF"],
  // ---- First half / first five innings (unchanged from PR #19) ----
  [/\bf5\b/, "FIRST_HALF"],
  [/\b1st\s*5\b/, "FIRST_HALF"],
  [/\bfirst\s*5\b/, "FIRST_HALF"],
  [/\b1st\s+five\b/, "FIRST_HALF"],
  [/\bfirst\s+five\b/, "FIRST_HALF"],
  [/\b1st[\s.-]*half\b/, "FIRST_HALF"],
  [/\bfirst[\s.-]*half\b/, "FIRST_HALF"],
  [/\b1h\b/, "FIRST_HALF"],
  // ---- A single inning outside MLB's own F5/NRFI paths: no score source ----
  [
    /\b(1st|2nd|3rd|4th|5th|6th|7th|8th|9th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\s+inning\b/,
    "UNSUPPORTED_SEGMENT",
  ],
];

export function betScope(betDetail: string | null): BetScope {
  const t = (betDetail ?? "").toLowerCase();
  for (const [re, scope] of BET_SCOPE_RULES) {
    if (re.test(t)) return scope;
  }
  return "FULL_GAME";
}

// The Period a freshly-imported pick with this text should be stored as -
// betScope, but with the ungradeable UNSUPPORTED_SEGMENT collapsed to
// FULL_GAME (there's no Period value for it, and grading re-derives the real
// scope from the text anyway and declines it there).
export function pickPeriodFromText(betDetail: string | null): SegmentPeriod {
  const scope = betScope(betDetail);
  return scope === "UNSUPPORTED_SEGMENT" ? "FULL_GAME" : scope;
}

// Human-readable label for a Period / BetScope value, for pick-list badges
// and the pending-picks triage reasons. Accepts a plain string so callers can
// pass a Prisma Period without a cast.
export function periodLabel(period: string): string {
  switch (period) {
    case "FIRST_HALF":
      return "1st half / F5";
    case "SECOND_HALF":
      return "2nd half";
    case "FIRST_QUARTER":
      return "1st quarter";
    case "SECOND_QUARTER":
      return "2nd quarter";
    case "THIRD_QUARTER":
      return "3rd quarter";
    case "FOURTH_QUARTER":
      return "4th quarter";
    case "FIRST_PERIOD":
      return "1st period";
    case "SECOND_PERIOD":
      return "2nd period";
    case "THIRD_PERIOD":
      return "3rd period";
    default:
      return "full game";
  }
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
export function parseTouchdownProp(
  text: string
): { playerName: string; propType: TdPropType; unsupported?: string } | null {
  if (!/\btouchdowns?\b/i.test(text) && !/\btds?\b/i.test(text) && !/\batd\b/i.test(text)) return null;

  // First-TD ("who scores first in the game") and multi-TD ("2+ TDs") are a
  // different bet shape than the anytime-TD market this app actually grades
  // (resolveTouchdownProp only ever asks "did this player score at least
  // once") - first-TD needs scoring-play sequence data this app doesn't
  // fetch, and multi-TD needs a count threshold this app doesn't store
  // anywhere. Still matched here (not left to fall through to null) so
  // catalog import classifies these as PLAYER_PROP same as any other TD
  // pick, not the wrong MONEYLINE/TOTAL default a `null` return would risk
  // - but `unsupported` tells resolveTouchdownProp (grading.ts) to decline
  // grading instead of silently computing anytime-TD's WIN/LOSS for a bet
  // that isn't actually anytime-TD. Matched narrowly (the qualifier must sit
  // directly next to the TD word) so it can't misfire on unrelated text that
  // happens to contain "first"/"1st" elsewhere, e.g. a first-half-scoped
  // anytime-TD pick ("Anytime TD 1st Half").
  const isFirstTd = /\b(?:first|1st)\s+(?:touchdown|td)s?\b/i.test(text);
  const isMultiTd = /\d\s*\+\s*(?:touchdown|td)s?\b/i.test(text);
  // Over/Under N.5 TDs ("Kelce Over 1.5 TDs") is a TD-count threshold market,
  // not the anytime-TD ("scored at least once") market resolveTouchdownProp
  // actually grades - same reason multi-TD above is declined rather than
  // graded wrong. Detected via parsePlayerPropLine's own over/under-plus-number
  // shape (reused, not reimplemented) rather than a bespoke regex here; gated
  // behind isFirstTd/isMultiTd being false so those two keep their own,
  // more specific unsupported reasons.
  const isOverUnderTd = !isFirstTd && !isMultiTd && parsePlayerPropLine(text) !== null;
  const unsupported = isFirstTd
    ? "this bet is a first-touchdown prop, which this app doesn't grade automatically yet - needs manual grading"
    : isMultiTd
      ? "this bet is a multi-touchdown (2+/3+) prop, which this app doesn't grade automatically yet - needs manual grading"
      : isOverUnderTd
        ? "this bet is an Over/Under touchdown-count prop, which this app doesn't grade automatically yet - needs manual grading"
        : undefined;

  const isRushing = /\brush(?:ing|er)?\b/i.test(text);
  const isReceiving = /\b(receiving|reception|receptions|receiver|catches|catch|rec)\b/i.test(text);
  const propType: TdPropType = isRushing ? "RUSHING" : isReceiving ? "RECEIVING" : "ANY";

  const playerName = text
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bany\s*time\b/gi, " ")
    .replace(/\batd\b/gi, " ")
    .replace(/\bor\s+more\b/gi, " ")
    .replace(/\b(?:first|1st)\b/gi, " ")
    .replace(/\b\d+\+?/g, " ")
    .replace(/\b(rushing|rusher|rush|receiving|reception|receptions|rec|receiver|catches|catch|scorer|anytime)\b/gi, " ")
    .replace(/\btouchdowns?\b/gi, " ")
    .replace(/\btds?\b/gi, " ")
    .replace(/[+-]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!playerName) return null;

  return { playerName, propType, unsupported };
}

// The full set of structured player-prop markets this app recognizes -
// mirrors the PropMarket enum in schema.prisma exactly (kept as a local
// string-literal union, not a `@prisma/client` import, for the same
// client-bundle-safety reason ParsedPick/BetTypeLike above re-declare their
// own unions instead of importing BetType).
export type PlayerPropMarket =
  | "PASS_YDS"
  | "RUSH_YDS"
  | "REC_YDS"
  | "RECEPTIONS"
  | "TD"
  | "RUSH_REC_YDS"
  | "PASS_RUSH_YDS";

// The stat-category word ALONE is enough to identify PASS_YDS/RUSH_YDS - "65.5
// rushing", "245.5 passing" - a real capper catalog import gap found testing
// against the actual UI: requiring the "yards"/"yard" qualifier too rejected
// text that was otherwise completely unambiguous (neither "passing" nor
// "rushing" means anything else in a player-prop line). The yards qualifier,
// when present, is still matched and stripped as part of the same phrase (so
// playerName extraction below removes "Rushing Yards" as one unit, not just
// "Rushing" leaving "Yards" stuck to the name) - it's just no longer
// *required* for the market to be recognized. "y(?:ar|r)?ds?" tolerates every
// common spelling/abbreviation of "yards" seen in real pasted text: yard,
// yards, yd, yds, yrd, yrds (the old pattern only recognized yds/yards/yard).
//
// REC_YDS ("Receiving Yards") vs RECEPTIONS ("Receptions") still must stay
// distinguishable, same as before, but "rec" alone is now ambiguous between
// them without a qualifier - resolved by treating bare "rec" as the
// RECEPTIONS count (the real-world convention: a stat sheet's "REC" column is
// receptions, not yards), and only promoting it to REC_YDS when a yards
// qualifier is actually attached ("rec yds", "rec yards"). "receiving" (the
// adjective form) has no such ambiguity - it's never used as receptions
// shorthand - so it resolves to REC_YDS bare, same as "rushing"/"passing"
// above. Order matters: REC_YDS is checked before RECEPTIONS so "rec" +
// yards is claimed there first, leaving bare "rec" (no yards) to fall through
// to RECEPTIONS; "receptions?" itself never matches inside REC_YDS's patterns
// (no "rec"+yards or "receiving" substring in "receptions").
const YARDS_UNIT = /y(?:ar|r)?ds?/.source;

// Combined-category markets (2026-09, RUSH_REC_YDS/PASS_RUSH_YDS - see
// PropMarket's own comment in schema.prisma for the upstream-market
// confirmation these are built against). Each is two single-category stat
// words joined by a connector ("and", "&", "+", or "/", in either order -
// "rush and rec", "rec + rush" are both real capper phrasings) - matched and
// checked BEFORE the plain single-category patterns below, since e.g. bare
// "rushing" would otherwise claim "rushing and receiving yards" for RUSH_YDS
// first, stripping only "rushing" and leaving "and receiving yards" stuck in
// the extracted player name.
//
// PASS_RUSH_YDS's pattern also matches "passing" + connector + "rec(eiving)"
// - NOT a typo for a real combined market (there is no such market, at this
// or seemingly any provider - see PropMarket's comment), but a known typo
// FOR "passing and rushing" that real capper text uses. Folded directly into
// this one pattern rather than a separate PASS_REC_YDS market/code path,
// since the corrected meaning (pass+rush) is exactly what this pattern
// already produces - no player-position/roster lookup needed to make this
// call: "passing and receiving" cannot be a genuine distinct market for
// ANY player, QB or otherwise, so the typo-correction is safe unconditionally.
const PROP_MARKET_CONNECTOR = /\s*(?:and|&|\+|\/)\s*/.source;
const PLAYER_PROP_STAT_PATTERNS: [Exclude<PlayerPropMarket, "TD">, RegExp][] = [
  [
    "RUSH_REC_YDS",
    new RegExp(
      `\\b(?:rush(?:ing)?${PROP_MARKET_CONNECTOR}rec(?:eiving)?|rec(?:eiving)?${PROP_MARKET_CONNECTOR}rush(?:ing)?)\\b(?:\\s*${YARDS_UNIT}\\b)?`,
      "i"
    ),
  ],
  [
    "PASS_RUSH_YDS",
    new RegExp(
      `\\b(?:pass(?:ing)?${PROP_MARKET_CONNECTOR}(?:rush(?:ing)?|rec(?:eiving)?)|(?:rush(?:ing)?|rec(?:eiving)?)${PROP_MARKET_CONNECTOR}pass(?:ing)?)\\b(?:\\s*${YARDS_UNIT}\\b)?`,
      "i"
    ),
  ],
  ["PASS_YDS", new RegExp(`\\bpass(?:ing)?\\b(?:\\s*${YARDS_UNIT}\\b)?`, "i")],
  ["RUSH_YDS", new RegExp(`\\brush(?:ing)?\\b(?:\\s*${YARDS_UNIT}\\b)?`, "i")],
  ["REC_YDS", new RegExp(`\\brec\\s*${YARDS_UNIT}\\b|\\breceiving\\b(?:\\s*${YARDS_UNIT}\\b)?`, "i")],
  ["RECEPTIONS", /\breceptions?\b|\brec\b/i],
];

// Generalizes parseTouchdownProp to every structured player-prop market this
// app recognizes (PropMarket in schema.prisma) - passing/rushing/receiving
// yards, receptions, and touchdowns - so any caller that needs to know WHICH
// market a pick's free text describes (catalog import, to populate the
// Pick.playerName/propMarket columns at create time; categorization, as its
// propMarket-null fallback for legacy or manually-entered rows) has exactly
// one place to ask. Same "derive from betDetail text every time" pattern as
// extractLine/parseTouchdownProp above - never stored as its own parse
// result, always re-read from the same text every caller already has.
//
// Checks TD first via parseTouchdownProp itself, completely unchanged - its
// player-name extraction and RUSHING/RECEIVING/ANY sub-typing (used by
// resolveTouchdownProp for grading) are untouched by this function's
// existence. The four new markets don't need that sub-typing - their
// propMarket value alone already says which stat they're about - so they
// share one simpler player-name strip (remove the matched stat phrase,
// over/under, numbers, parens) instead of parseTouchdownProp's own.
//
// Returns null when text matches none of the five known markets (a
// malformed or genuinely non-prop betDetail on a manually-entered
// PLAYER_PROP pick) - callers treat that the same as "not a recognized
// player prop", not as a TD prop by default.
export function parsePlayerProp(text: string): { playerName: string; propMarket: PlayerPropMarket } | null {
  const td = parseTouchdownProp(text);
  if (td) return { playerName: td.playerName, propMarket: "TD" };

  const match = PLAYER_PROP_STAT_PATTERNS.find(([, pattern]) => pattern.test(text));
  if (!match) return null;
  const [propMarket, statPattern] = match;

  const playerName = text
    .replace(/\([^)]*\)/g, " ")
    .replace(statPattern, " ")
    .replace(/\b(over|under)\b/gi, " ")
    // The "o"/"u" shorthand for over/under ("Mike Evans o56.5", "...o 56.5")
    // is a first-class format alongside the spelled-out word above, not an
    // edge case - stripped the same way, but ONLY when it's actually acting
    // as that shorthand: a standalone "o"/"u" token sitting directly in
    // front of a number (optional whitespace between them, matching the
    // same o/u-shorthand recognized elsewhere - see looksLikePick/
    // parsePickText in parse-catalog.ts and parsePlayerPropLine below). The
    // digit itself isn't consumed here (lookahead only) - the next replace
    // strips it. Never touches a bare "o"/"u" anywhere else in the name
    // (an initial, a name fragment before a non-numeric word), so a real
    // name is never corrupted by this.
    .replace(/\b[ou]\s*(?=\d)/gi, " ")
    .replace(/[+-]?\d+(?:\.\d+)?\+?/g, " ")
    .replace(/[+-]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!playerName) return null;

  return { playerName, propMarket };
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

export type PlayerPropLineInfo = { line: number; direction: "OVER" | "UNDER" };

// The numeric line + Over/Under side for a PASS_YDS/RUSH_YDS/REC_YDS/
// RECEPTIONS pick, e.g. "Josh Allen Over 275.5 Passing Yards" -> { line:
// 275.5, direction: "OVER" }. Unlike propMarket/playerName (Pick columns
// populated at import since #73), NEITHER of these is ever stored
// structurally for a PLAYER_PROP pick: extractLine above only recognizes
// SPREAD/TEAM_TOTAL/TOTAL betTypes (PLAYER_PROP falls through its final
// `return null`), and the bulk-import flow that lets a client confirm an
// `inferredLine` only runs for TOTAL. So grading re-derives the line/side
// from betDetail free text every time, for a propMarket-populated pick
// exactly the same as for a legacy propMarket-null one - there is no
// structured path to prefer here the way there is for market/playerName.
// Same "over/under followed by a number, or the o/u shorthand" shape
// extractLine's TOTAL branch already matches, reused here for consistency.
// Over and Under are matched independently (not "whichever comes first in
// the string") so that text naming both sides - each with its own number,
// e.g. leftover/duplicated text in a manually-entered pick - returns null
// (can't tell which side this pick actually is) rather than silently
// grading against whichever side happened to appear first.
export function parsePlayerPropLine(text: string): PlayerPropLineInfo | null {
  const overMatch = text.match(/\bover\s+(\d+(?:\.\d+)?)\b/i) ?? text.match(/\bo\s*(\d+(?:\.\d+)?)\b/i);
  const underMatch = text.match(/\bunder\s+(\d+(?:\.\d+)?)\b/i) ?? text.match(/\bu\s*(\d+(?:\.\d+)?)\b/i);
  if (overMatch && !underMatch) return { direction: "OVER", line: parseFloat(overMatch[1]) };
  if (underMatch && !overMatch) return { direction: "UNDER", line: parseFloat(underMatch[1]) };
  return null;
}
