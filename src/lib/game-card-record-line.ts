// The condensed three-number record line shown under each pick on a /live
// game card, replacing the old
//   "12-3 (80%) all-time | 4-1 (80%) last 20 on underdog spread picks"
// with a tighter three-way split:
//   "Team +3.5 · Ovr 12-3 · NCAAF 8-2 (80%) · L20 4-1"
//
// Pure (no React, no DB) so game-picks-expander.tsx renders it and the tests
// check the exact text - including the mobile-width guard, since a game card
// stacks 8+ picks and this line must stay ONE visual line (same vertical
// footprint as the record line it replaces, which itself sits on one row).
//
// Only the current-league segment keeps its win% - Ovr's rate is carried by
// the segment's green/red color, and dropping the two extra "(xx%)" strings
// is what keeps the line from wrapping on a phone. Last 20 shows a bare
// record (the spec: no % on L20), and is omitted entirely below the 20-graded
// threshold (never shown as "Need 20 picks" inline - too long; its absence is
// the signal).
//
// The numbers come from computeLeagueRecordCards (stats.ts) via
// getLeagueRecordsAction - this file only formats them.

export type GameCardRecordColumn = { wins: number; losses: number; pushes: number; winPct: number };

export type GameCardRecordSegment = {
  label: string;
  record: string; // "12-3" or "12-3-1"
  pct: string | null; // "80%" on the current-league segment only
  winPct: number; // for the segment's own green/red color in the component
  emphasized: boolean; // the current-league segment
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
  const segments: GameCardRecordSegment[] = [
    {
      label: "Ovr",
      record: recordText(card.overall),
      pct: null,
      winPct: card.overall.winPct,
      emphasized: false,
    },
    {
      label: leagueName,
      record: recordText(card.league),
      pct: Math.round(card.league.winPct) + "%",
      winPct: card.league.winPct,
      emphasized: true,
    },
  ];
  if (card.last20) {
    segments.push({
      label: "L" + lastN,
      record: recordText(card.last20),
      pct: null,
      winPct: card.last20.winPct,
      emphasized: false,
    });
  }
  return segments;
}

// The record portion alone ("Ovr 12-3 · NCAAF 8-2 (80%) · L20 4-1") - the
// part appended after the bet detail. The component renders these segments
// with per-segment color; the character content is identical.
export function gameCardRecordPortionText(segments: GameCardRecordSegment[]): string {
  return segments.map((s) => s.label + " " + s.record + (s.pct ? " (" + s.pct + ")" : "")).join(" · ");
}

// The full line, for the width guard / a plain-text fallback.
export function gameCardRecordLineText(betDetail: string, segments: GameCardRecordSegment[]): string {
  const portion = gameCardRecordPortionText(segments);
  return portion ? betDetail + " · " + portion : betDetail;
}

// Deliberately conservative single-line width estimate at the game card's
// text-[10px]. ~5.6px per character for the app's system sans stack at that
// size, rounded up. A guard, not a layout measurement.
export const GAME_CARD_LINE_PX_PER_CHAR = 5.6;

export function estimateGameCardLineWidthPx(text: string): number {
  return Math.ceil(text.length * GAME_CARD_LINE_PX_PER_CHAR);
}

// The line sits at pl-[23px] inside the expander's px-2.5 pick card, inside
// the game card's own padding. On a 375px viewport (iPhone SE and up - the
// large majority of phones) ~295px is the usable run before wrap.
//
// The record PORTION alone is budgeted tighter (~215px) so it always shares
// one line with a normal bet detail. The FULL line fits for a short-to-medium
// bet detail (the common case: "Team +3.5", "Over 55.5", "UNLV 1H +3.5"); a
// long college team name ("Washington State -7", "Michigan State ML") wraps
// it to a second row - which is still strictly better than the verbose line
// it replaces, which wrapped to 2-3 rows for EVERY pick.
export const GAME_CARD_LINE_MOBILE_BUDGET_PX = 295;
export const GAME_CARD_RECORD_PORTION_BUDGET_PX = 215;
