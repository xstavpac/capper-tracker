// The capper record block shown under each pick on a /live game card. It
// started as a compact one-liner (PR #25) and went through a natural-phrasing
// inline sentence (PR #33-35); live use surfaced problems with the single-line
// form, so it is now a small stack of rows:
//
//   Twins Moneyline
//   40% (2-3) overall on Underdog Moneyline Picks
//   55% (11-9) in MLB Underdog Moneyline Picks
//   67% (14-6) over the last 20 picks
//   🔥 4 game win streak
//
// Rows, in order:
//  - Overall - the capper's all-time record in this pick's exact category:
//    "<win%> (<W-L[-P]>) overall on <Side> <Market> Picks". The win% and the
//    parenthesised record stay together as one unit (an earlier form split
//    them across the sentence, which read badly). The category wording keeps
//    the favorite/underdog side ("Underdog Moneyline", not just "Moneyline") -
//    the record IS side-specific, so the label has to be too. That wording
//    comes from PICK_CATEGORY_MARKET_NOUN (stats.ts), Title-cased here to match
//    the capper's own pick-detail line above the block ("Twins Moneyline").
//  - League - the same record scoped to the game's league, naming the market
//    too so the row stands on its own: "<win%> (<W-L[-P]>) in <LEAGUE> <Side>
//    <Market> Picks". Dropped entirely when the capper has no graded pick in
//    that league yet - never a fake "0% (0-0) in MLB ...". Also dropped when it
//    would be identical to the Overall row (same record, same percentage) -
//    e.g. an MLB-only market like NRFI, where every graded pick is in MLB, so
//    Overall and League are always the same number. That collapse is a general
//    value comparison, not a hardcoded market list, so it self-corrects for any
//    market whose Overall and League records happen to coincide.
//  - Last 20 - the capper's record over their most recent LEAGUE_RECORD_LAST_N
//    graded picks in this category (all leagues). Shown only once the category
//    has at least that many graded picks; below the threshold `last20` arrives
//    null and the row is omitted entirely (never a partial "last N").
//  - Streak - the capper's current OVERALL streak (any sport / any bet type),
//    only when it is 2+ in either direction: "🔥 4 game win streak" /
//    "🧊 5 game losing streak". The glyph carries the pulse animation +
//    reduced-motion handling and the hover tooltip (see the component and
//    gameCardStreakTooltip). Omitted below 2. Appended by the component, after
//    the rows this file builds.
//
// The row layout deliberately trades the old compact line for guaranteed-clean
// breaks on mobile - there is no width guard any more.
//
// Pure (no React, no DB): game-picks-expander.tsx renders these and the tests
// check the exact row text. Numbers come from computeLeagueRecordCards
// (stats.ts) via getLeagueRecordsAction; the streak from
// computeStats().currentStreak - this file only formats them.

export type GameCardRecordColumn = { wins: number; losses: number; pushes: number; winPct: number };

// The capper's current overall streak, any sport / any bet type - the exact
// same { type, count } shape currentStreak() (stats.ts) returns and the
// Leaderboard/Favorites flame badge (StreakBadge) already renders.
export type GameCardStreak = { type: "WIN" | "LOSS" | "NONE"; count: number };

// Same 2+ cutoff StreakBadge uses - a single win or loss isn't a "streak."
export const GAME_CARD_STREAK_MIN = 2;

// The recent-form window for the Last 20 row. Mirrors LEAGUE_RECORD_LAST_N
// (stats.ts), which is what actually decides whether `last20` is populated -
// this file can't import stats.ts (module-level prisma), so the number is
// restated here for the row's wording, the same way GAME_CARD_STREAK_MIN
// mirrors StreakBadge's cutoff.
export const GAME_CARD_LAST_N = 20;

// The component's placeholder when the capper has no graded pick in this
// pick's category - shown in place of the record rows (the streak row can
// still follow it, the streak is capper-level not category-level). Exported so
// the component and the tests share the exact string.
export const GAME_CARD_NO_HISTORY_TEXT = "No history in this category yet";

// The classes on the streak-row glyph: infinite opacity+scale pulse
// (animate-streak-pulse, tailwind.config.ts, PR #34/#35), static for anyone
// with prefers-reduced-motion (motion-reduce:animate-none), inline-block so
// the transform applies without nudging the text beside it. Exported as a
// constant so a test can assert both the animation and the reduced-motion
// guard are present without rendering React.
export const GAME_CARD_STREAK_GLYPH_CLASS = "inline-block animate-streak-pulse motion-reduce:animate-none";

// One record row. `scope` is everything after the "<pct> (<record>)" unit -
// "overall on Underdog Moneyline Picks", "in MLB Underdog Moneyline Picks",
// "over the last 20 picks".
export type GameCardRecordRow = {
  pct: string; // "40%"
  record: string; // "2-3"
  scope: string;
  winPct: number; // for the row's own green/red color
};

function recordText(c: GameCardRecordColumn): string {
  return c.wins + "-" + c.losses + (c.pushes > 0 ? "-" + c.pushes : "");
}

function pctText(c: GameCardRecordColumn): string {
  return Math.round(c.winPct) + "%";
}

// Title-cases a market-noun phrase for a row's scope ("underdog moneyline
// picks" -> "Underdog Moneyline Picks"), matching the Title Case the capper's
// own pick-detail line above the block already uses ("Twins Moneyline",
// "Tigers Over 7.5"). Tokens that are already all-caps are left as-is so
// bettor acronyms keep their form ("NRFI" stays "NRFI", never "Nrfi");
// hyphen groups are cased part-by-part ("first-5" -> "First-5") and leading
// digits are left alone ("1st quarter" -> "1st Quarter").
function titleCaseMarket(phrase: string): string {
  const capPart = (part: string): string => {
    if (part.length === 0) return part;
    if (/^[A-Z0-9]+$/.test(part) && /[A-Z]/.test(part)) return part; // NRFI, YRFI
    return part[0].toUpperCase() + part.slice(1);
  };
  return phrase
    .split(" ")
    .map((word) => word.split("-").map(capPart).join("-"))
    .join(" ");
}

// The record rows from a capper's league-record card. `marketNoun` is
// PICK_CATEGORY_MARKET_NOUN[category] (already includes the favorite/underdog
// side where the category has one). The League row is included only when
// `hasLeagueHistory` is true AND its numbers differ from the Overall row's.
// The Last 20 row is included only when `last20` is non-null (the caller /
// computeLeagueRecordCards nulls it below LEAGUE_RECORD_LAST_N graded picks).
export function gameCardRecordRows(
  card: {
    overall: GameCardRecordColumn;
    league: GameCardRecordColumn;
    last20: GameCardRecordColumn | null;
  },
  opts: { leagueName: string; marketNoun: string; hasLeagueHistory: boolean }
): GameCardRecordRow[] {
  const marketLabel = titleCaseMarket(opts.marketNoun + " picks");
  const leagueLabel = opts.leagueName.toUpperCase();

  const overallRow: GameCardRecordRow = {
    pct: pctText(card.overall),
    record: recordText(card.overall),
    scope: "overall on " + marketLabel,
    winPct: card.overall.winPct,
  };
  const rows: GameCardRecordRow[] = [overallRow];

  // Collapse the League row into Overall whenever the two would show the same
  // record and the same percentage - a general value check, so it self-
  // corrects for NRFI/YRFI and any other market that only ever runs in one
  // league without a hardcoded list to maintain.
  const leagueMatchesOverall =
    recordText(card.league) === overallRow.record && pctText(card.league) === overallRow.pct;
  if (opts.hasLeagueHistory && !leagueMatchesOverall) {
    rows.push({
      pct: pctText(card.league),
      record: recordText(card.league),
      scope: "in " + leagueLabel + " " + marketLabel,
      winPct: card.league.winPct,
    });
  }

  if (card.last20) {
    rows.push({
      pct: pctText(card.last20),
      record: recordText(card.last20),
      scope: "over the last " + GAME_CARD_LAST_N + " picks",
      winPct: card.last20.winPct,
    });
  }

  return rows;
}

// Plain text of one record row: "40% (2-3) overall on Underdog Moneyline Picks".
// The component renders the "<pct> (<record>)" unit as a single colored span
// and this exact string is what the tests check.
export function gameCardRecordRowText(row: GameCardRecordRow): string {
  return row.pct + " (" + row.record + ") " + row.scope;
}

// Just the streak glyph ("🔥" / "🧊"), or "" below the 2+ cutoff. The
// component wraps this in the animated span; the tooltip and spelled-out text
// come from the two functions below.
export function gameCardStreakGlyph(streak: GameCardStreak | null | undefined): string {
  if (!streak || streak.type === "NONE" || streak.count < GAME_CARD_STREAK_MIN) return "";
  return streak.type === "WIN" ? "🔥" : "🧊";
}

// The streak row as plain text: "🔥 4 game win streak" / "🧊 5 game losing
// streak", or "" below the 2+ cutoff (the row is then omitted entirely).
export function gameCardStreakRowText(streak: GameCardStreak | null | undefined): string {
  const glyph = gameCardStreakGlyph(streak);
  if (!glyph) return "";
  const phrase = streak!.type === "WIN" ? " game win streak" : " game losing streak";
  return glyph + " " + streak!.count + phrase;
}

// Plain-text explanation of the streak, shown on hover over the streak row (a
// standard title attribute - the codebase has no tooltip component). Empty
// below the 2+ cutoff. Unchanged from PR #33.
export function gameCardStreakTooltip(streak: GameCardStreak | null | undefined): string {
  if (!streak || streak.type === "NONE" || streak.count < GAME_CARD_STREAK_MIN) return "";
  return (streak.type === "WIN" ? "Won " : "Lost ") + streak.count + " in a row";
}
