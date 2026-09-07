// The capper record block shown under each pick on a /live game card. It
// started as a compact one-liner (PR #25) and went through a natural-phrasing
// inline sentence (PR #33-35); live use surfaced three problems with the
// single-line form, so it is now a small stack of rows:
//
//   Team +3.5
//   40% (2-3) overall on underdog moneyline picks
//   55% (11-9) in NCAAF
//   🔥 4 game win streak
//
// Rows:
//  - Row 1 - the capper's all-time record in this pick's exact category:
//    "<win%> (<W-L[-P]>) overall on <side> <market> picks". The win% and the
//    parenthesised record stay together as one unit (an earlier form split
//    them across the sentence, which read badly). The category wording keeps
//    the favorite/underdog side ("underdog moneyline", not just "moneyline") -
//    the record IS side-specific, so the label has to be too. That wording
//    comes from PICK_CATEGORY_MARKET_NOUN (stats.ts).
//  - Row 2 - the same record scoped to the game's league:
//    "<win%> (<W-L[-P]>) in <league>". Dropped entirely when the capper has no
//    graded pick in that league yet - never a fake "0% (0-0) in NCAAF".
//  - Row 3 - the capper's current OVERALL streak (any sport / any bet type),
//    only when it is 2+ in either direction: "🔥 4 game win streak" /
//    "🧊 5 game losing streak". The glyph carries the pulse animation +
//    reduced-motion handling and the hover tooltip (see the component and
//    gameCardStreakTooltip). Omitted below 2.
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

// The component's placeholder when the capper has no graded pick in this
// pick's category - shown in place of rows 1 and 2 (row 3 can still follow it,
// the streak is capper-level not category-level). Exported so the component
// and the tests share the exact string.
export const GAME_CARD_NO_HISTORY_TEXT = "No history in this category yet";

// The classes on the row-3 streak glyph: infinite opacity+scale pulse
// (animate-streak-pulse, tailwind.config.ts, PR #34/#35), static for anyone
// with prefers-reduced-motion (motion-reduce:animate-none), inline-block so
// the transform applies without nudging the text beside it. Exported as a
// constant so a test can assert both the animation and the reduced-motion
// guard are present without rendering React.
export const GAME_CARD_STREAK_GLYPH_CLASS = "inline-block animate-streak-pulse motion-reduce:animate-none";

// One record row (row 1 or row 2). `scope` is everything after the
// "<pct> (<record>)" unit - "overall on underdog moneyline picks", "in NCAAF".
export type GameCardRecordRow = {
  pct: string; // "40%"
  record: string; // "2-3"
  scope: string; // "overall on underdog moneyline picks" | "in NCAAF"
  winPct: number; // for the row's own green/red color
};

function recordText(c: GameCardRecordColumn): string {
  return c.wins + "-" + c.losses + (c.pushes > 0 ? "-" + c.pushes : "");
}

function pctText(c: GameCardRecordColumn): string {
  return Math.round(c.winPct) + "%";
}

// Rows 1 and 2 from a capper's league-record card. `marketNoun` is
// PICK_CATEGORY_MARKET_NOUN[category] (already includes the favorite/underdog
// side where the category has one). Row 2 is included only when
// hasLeagueHistory is true (the caller checks card.league.count).
export function gameCardRecordRows(
  card: { overall: GameCardRecordColumn; league: GameCardRecordColumn },
  opts: { leagueName: string; marketNoun: string; hasLeagueHistory: boolean }
): GameCardRecordRow[] {
  const rows: GameCardRecordRow[] = [
    {
      pct: pctText(card.overall),
      record: recordText(card.overall),
      scope: "overall on " + opts.marketNoun + " picks",
      winPct: card.overall.winPct,
    },
  ];
  if (opts.hasLeagueHistory) {
    rows.push({
      pct: pctText(card.league),
      record: recordText(card.league),
      scope: "in " + opts.leagueName,
      winPct: card.league.winPct,
    });
  }
  return rows;
}

// Plain text of one record row: "40% (2-3) overall on underdog moneyline picks".
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

// Row 3 as plain text: "🔥 4 game win streak" / "🧊 5 game losing streak", or
// "" below the 2+ cutoff (the row is then omitted entirely).
export function gameCardStreakRowText(streak: GameCardStreak | null | undefined): string {
  const glyph = gameCardStreakGlyph(streak);
  if (!glyph) return "";
  const phrase = streak!.type === "WIN" ? " game win streak" : " game losing streak";
  return glyph + " " + streak!.count + phrase;
}

// Plain-text explanation of the streak, shown on hover over row 3 (a standard
// title attribute - the codebase has no tooltip component). Empty below the
// 2+ cutoff. Unchanged from PR #33.
export function gameCardStreakTooltip(streak: GameCardStreak | null | undefined): string {
  if (!streak || streak.type === "NONE" || streak.count < GAME_CARD_STREAK_MIN) return "";
  return (streak.type === "WIN" ? "Won " : "Lost ") + streak.count + " in a row";
}
