// The two views every roster cache reader (nfl/nhl/nba/mlb-roster-cache.ts)
// serves from one memoized table read. Pure - no prisma - so the split is
// testable on its own.
//
//   matching  active players only. Import name matching (the roster
//             fallbacks, the bulk-import name list) must never resolve a line
//             to a player no longer on any roster.
//   grading   every row, active or not. A pending prop on a player who has
//             since been released or traded still has to grade - the box-score
//             fallback and the did-not-play checks need his id.
//
// Both arrays are built once per table read and memoized with it, so repeat
// calls inside the memo TTL hand back the same arrays (read-only).
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type RosterViews = { matching: RosterPlayer[]; grading: RosterPlayer[] };

type CachedRow = { fullName: string; firstName: string; lastName: string; team: string; position: string; active: boolean };

// The columns a cache read selects - the RosterPlayer fields plus active (the
// caller adds its own player-id column).
export const ROSTER_CACHE_SELECT = { fullName: true, firstName: true, lastName: true, team: true, position: true, active: true } as const;

export function buildRosterViews<R extends CachedRow>(rows: R[], externalPlayerId: (r: R) => string): RosterViews {
  const grading: RosterPlayer[] = [];
  const matching: RosterPlayer[] = [];
  for (const r of rows) {
    const player = { playerName: r.fullName, firstName: r.firstName, lastName: r.lastName, team: r.team, position: r.position, externalPlayerId: externalPlayerId(r) };
    grading.push(player);
    if (r.active) matching.push(player);
  }
  return { matching, grading };
}
