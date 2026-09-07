// The record line shown under each pick on a /live game card. It replaces the
// verbose
//   "12-3 (80%) all-time | 4-1 (80%) last 20 on underdog spread picks"
// with a natural-phrasing sentence fragment:
//   "Team +3.5 · 58% overall on total picks (21-15-2) · 60% in NCAAF (3-2) 🔥4"
//
// Format (natural phrasing, per the game-card mockup):
//  - one clause per record: "<win%> overall on <market> picks (<W-L[-P]>)" for
//    the capper's all-time record in this pick's market, then
//    "<win%> in <league> (<W-L[-P]>)" for their record in the game's league
//  - the market noun is side-dropped ("total", "spread", "moneyline") - the
//    card already shows which side this pick is on; PICK_CATEGORY_MARKET_NOUN
//    (stats.ts) owns that mapping
//  - "·" separates the bet detail from the first clause and the clauses from
//    each other; each clause's win% and (record) are green/red by that
//    clause's own win rate
//  - the "in <league>" clause is dropped entirely when the capper has no
//    graded pick in the game's league yet (no "0% in NCAAF (0-0)")
//  - on dense cards the line is allowed to wrap to a second row - an accepted
//    tradeoff for the plainer wording, and still far better than the verbose
//    line it replaces, which wrapped to 2-3 rows for every pick
//  - a 🔥/🧊 streak indicator is appended at the very end when the capper is on
//    a current OVERALL streak of 2+ - this occupies the slot the old "L20"
//    segment used to; see gameCardStreakSuffix / gameCardStreakTooltip
//
// Pure (no React, no DB) so game-picks-expander.tsx renders it and the tests
// check the exact text plus the mobile-width guard. The numbers come from
// computeLeagueRecordCards (stats.ts) via getLeagueRecordsAction and the
// streak from computeStats().currentStreak - this file only formats them.

export type GameCardRecordColumn = { wins: number; losses: number; pushes: number; winPct: number };

// The capper's current overall streak, any sport / any bet type - the exact
// same { type, count } shape currentStreak() (stats.ts) returns and the
// Leaderboard/Favorites flame badge (StreakBadge) already renders.
export type GameCardStreak = { type: "WIN" | "LOSS" | "NONE"; count: number };

// Same 2+ cutoff StreakBadge uses - a single win or loss isn't a "streak."
export const GAME_CARD_STREAK_MIN = 2;

// The record line's trailing indicator: "🔥" + count on a 2+ win streak,
// "🧊" + count on a 2+ loss streak, "" below that in either direction (the
// slot then simply renders nothing - it does NOT fall back to any other
// number). This is the ONLY streak formatting in this file - it does not
// compute the streak, callers pass currentStreak()'s result straight through.
export function gameCardStreakSuffix(streak: GameCardStreak | null | undefined): string {
  if (!streak || streak.type === "NONE" || streak.count < GAME_CARD_STREAK_MIN) return "";
  return (streak.type === "WIN" ? "🔥" : "🧊") + streak.count;
}

// Plain-text explanation of the streak, shown on hover over the 🔥/🧊 glyph
// (a standard title attribute - the codebase has no tooltip component). Empty
// string below the 2+ cutoff, matching gameCardStreakSuffix - no glyph, no
// tooltip.
export function gameCardStreakTooltip(streak: GameCardStreak | null | undefined): string {
  if (!streak || streak.type === "NONE" || streak.count < GAME_CARD_STREAK_MIN) return "";
  return (streak.type === "WIN" ? "Won " : "Lost ") + streak.count + " in a row";
}

// The component's placeholder when the capper has no graded pick in this
// pick's category. Exported so the component and the width test share the
// exact string (the streak suffix still appends after it - the streak is
// overall, not category-scoped, so it shows whenever the capper's name does).
export const GAME_CARD_NO_HISTORY_TEXT = "No history in this category yet";

// One clause of the natural-phrasing line. `scope` is everything between the
// win% and the parenthesised record ("overall on total picks", "in NCAAF").
export type GameCardRecordClause = {
  pct: string; // "58%"
  scope: string; // "overall on total picks" | "in NCAAF"
  record: string; // "21-15-2"
  winPct: number; // for the clause's own green/red color
};

function recordText(c: GameCardRecordColumn): string {
  return c.wins + "-" + c.losses + (c.pushes > 0 ? "-" + c.pushes : "");
}

function pctText(c: GameCardRecordColumn): string {
  return Math.round(c.winPct) + "%";
}

// Builds the clause list from a capper's league-record card. `marketNoun` is
// PICK_CATEGORY_MARKET_NOUN[category]. The "in <league>" clause is included
// only when hasLeagueHistory is true (the caller checks card.league.count).
export function gameCardRecordClauses(
  card: { overall: GameCardRecordColumn; league: GameCardRecordColumn },
  opts: { leagueName: string; marketNoun: string; hasLeagueHistory: boolean }
): GameCardRecordClause[] {
  const clauses: GameCardRecordClause[] = [
    {
      pct: pctText(card.overall),
      scope: "overall on " + opts.marketNoun + " picks",
      record: recordText(card.overall),
      winPct: card.overall.winPct,
    },
  ];
  if (opts.hasLeagueHistory) {
    clauses.push({
      pct: pctText(card.league),
      scope: "in " + opts.leagueName,
      record: recordText(card.league),
      winPct: card.league.winPct,
    });
  }
  return clauses;
}

function clauseText(c: GameCardRecordClause): string {
  return c.pct + " " + c.scope + " (" + c.record + ")";
}

// The record portion ("58% overall on total picks (21-15-2) · 60% in NCAAF
// (3-2) 🔥4") - what's appended after the bet detail. Character content
// matches what the component renders (it only adds per-clause color). The
// optional streak suffix is appended after the last clause; if there are no
// clauses (no category history) the suffix stands alone.
export function gameCardRecordPortionText(
  clauses: GameCardRecordClause[],
  streak?: GameCardStreak | null
): string {
  const base = clauses.map(clauseText).join(" · ");
  const suffix = gameCardStreakSuffix(streak);
  if (!suffix) return base;
  return base ? base + " " + suffix : suffix;
}

// The full line, for the width guard / a plain-text fallback.
export function gameCardRecordLineText(
  betDetail: string,
  clauses: GameCardRecordClause[],
  streak?: GameCardStreak | null
): string {
  const portion = gameCardRecordPortionText(clauses, streak);
  return portion ? betDetail + " · " + portion : betDetail;
}

// The plain-text form of the "no category history" line the component shows
// in place of the record portion - placeholder text plus the same overall
// streak suffix. For the mobile-width guard.
export function gameCardNoHistoryLineText(betDetail: string, streak?: GameCardStreak | null): string {
  const suffix = gameCardStreakSuffix(streak);
  return betDetail + " · " + GAME_CARD_NO_HISTORY_TEXT + (suffix ? " " + suffix : "");
}

// Single-line width estimate at the game card's text-[10px]. ~5.2px per
// character for the app's system sans stack at that size, digit-heavy - a
// guard, not a layout measurement.
export const GAME_CARD_LINE_PX_PER_CHAR = 5.2;

// Counted by Unicode code point, not UTF-16 unit, so the streak emoji (🔥/🧊,
// a surrogate pair - String length 2) is treated as the single ~1-char glyph
// it renders as, not two. Pure-ASCII lines are unaffected.
export function estimateGameCardLineWidthPx(text: string): number {
  return Math.ceil([...text].length * GAME_CARD_LINE_PX_PER_CHAR);
}

// Usable run for this line before it wraps: it sits at pl-[23px] inside the
// expander's px-2.5 pick card, inside the game card's padding. On a 390px
// viewport (iPhone 12/13/14/15 and up - the current mainstream) that's ~300px.
// The natural-phrasing line is longer than the compact format it replaces and
// is EXPECTED to wrap to a second row on dense cards - an accepted tradeoff.
// The guard now only asserts the line never balloons past two rows (and that a
// short, common pick still fits one); it is no longer a one-row contract.
export const GAME_CARD_LINE_MOBILE_BUDGET_PX = 300;
export const GAME_CARD_LINE_MAX_ROWS = 2;
