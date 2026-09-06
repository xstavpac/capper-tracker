// The condensed three-number record line shown under each pick on a /live
// game card, replacing the verbose
//   "12-3 (80%) all-time | 4-1 (80%) last 20 on underdog spread picks"
// with:
//   "Team +3.5 · All 12-3 80% | NCAAF 8-2 80% | L20 4-1 80%"
//
// Format (final, per PR #25 review):
//  - "All" (not "Ovr" - avoids reading as "Over"), the game's league, "L20"
//  - "|" between the three segments; "·" separates them from the bet detail
//  - record then win% space-separated, NO parentheses
//  - every segment is green/red by its OWN record's win rate
//  - the league segment additionally gets bold weight (it's the number the
//    viewer is deciding on)
//  - L20 (segment + its "|" divider) is dropped entirely below the 20-graded
//    threshold - no placeholder text
//
// Pure (no React, no DB) so game-picks-expander.tsx renders it and the tests
// check the exact text plus the mobile-width guard - a game card stacks 8+
// picks and this line must stay the same one-row footprint it replaces. The
// numbers come from computeLeagueRecordCards (stats.ts) via
// getLeagueRecordsAction; this file only formats them.

export type GameCardRecordColumn = { wins: number; losses: number; pushes: number; winPct: number };

export type GameCardRecordSegment = {
  label: string;
  record: string; // "12-3" or "12-3-1"
  pct: string; // "80%"
  winPct: number; // for the segment's own green/red color
  emphasized: boolean; // the current-league segment - bold on top of color
};

function recordText(c: GameCardRecordColumn): string {
  return c.wins + "-" + c.losses + (c.pushes > 0 ? "-" + c.pushes : "");
}

export function gameCardRecordSegments(
  card: {
    overall: GameCardRecordColumn;
    league: GameCardRecordColumn;
    last20: GameCardRecordColumn | null;
  },
  leagueName: string,
  lastN: number
): GameCardRecordSegment[] {
  const seg = (label: string, c: GameCardRecordColumn, emphasized: boolean): GameCardRecordSegment => ({
    label,
    record: recordText(c),
    pct: Math.round(c.winPct) + "%",
    winPct: c.winPct,
    emphasized,
  });
  const segments = [seg("All", card.overall, false), seg(leagueName, card.league, true)];
  if (card.last20) segments.push(seg("L" + lastN, card.last20, false));
  return segments;
}

// The record portion ("All 12-3 80% | NCAAF 8-2 80% | L20 4-1 80%") - what's
// appended after the bet detail. Character content matches what the component
// renders (it only adds per-segment color / weight).
export function gameCardRecordPortionText(segments: GameCardRecordSegment[]): string {
  return segments.map((s) => s.label + " " + s.record + " " + s.pct).join(" | ");
}

// The full line, for the width guard / a plain-text fallback.
export function gameCardRecordLineText(betDetail: string, segments: GameCardRecordSegment[]): string {
  const portion = gameCardRecordPortionText(segments);
  return portion ? betDetail + " · " + portion : betDetail;
}

// Single-line width estimate at the game card's text-[10px]. ~5.2px per
// character for the app's system sans stack at that size, digit-heavy - a
// guard, not a layout measurement.
export const GAME_CARD_LINE_PX_PER_CHAR = 5.2;

export function estimateGameCardLineWidthPx(text: string): number {
  return Math.ceil(text.length * GAME_CARD_LINE_PX_PER_CHAR);
}

// Usable run for this line before it wraps: it sits at pl-[23px] inside the
// expander's px-2.5 pick card, inside the game card's padding. On a 390px
// viewport (iPhone 12/13/14/15 and up - the current mainstream) that's ~300px;
// the record PORTION alone is budgeted 260px so it shares a row with a normal
// bet detail. Genuinely long college team names ("Washington State -7") wrap
// the full line to a second row - still strictly better than the verbose line
// it replaces, which wrapped to 2-3 rows for EVERY pick.
export const GAME_CARD_LINE_MOBILE_BUDGET_PX = 300;
export const GAME_CARD_RECORD_PORTION_BUDGET_PX = 260;
