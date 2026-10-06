// Pure data shaping for Grid Live's game-detail panel - filters an
// already-classified ExpanderPick[] (teamGroup computed upstream in
// live/page.tsx via classifyPickTeamGroup, exactly as Standard Live already
// does) into both sides of the matchup plus the OTHER group (totals, NRFI,
// player props, and any team-tied bet whose betDetail didn't text-match
// either side), mirroring GamePicksExpander's AWAY/HOME/OTHER grouping
// (game-picks-expander.tsx's TEAM_GROUP_ORDER) so Grid shows the same set of
// picks Standard does. No team classification happens here - that would be a
// second, parallel run of the same classification Standard Live already paid
// for per pick; this only reads the field that classification already
// produced.
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { OTHER_GROUP_LABEL, TOTALS_GROUP_LABEL, shortTeamName, sortTotalsPicks } from "@/lib/pick-team-group";
import { getTeamColor } from "@/lib/team-colors";

export type GridLiveTeamSideData = {
  teamLabel: string;
  teamColor: string | null;
  picks: ExpanderPick[];
  // Header accent for the non-team groups: undefined = the team color (or
  // neutral gray when teamColor is null), "violet" = the Other markets accent.
  tone?: "violet";
};

export type GridLiveGamePanelData = {
  away: GridLiveTeamSideData;
  home: GridLiveTeamSideData;
  totals: GridLiveTeamSideData;
  other: GridLiveTeamSideData;
};

export function buildGridLiveGamePanelData(
  game: { homeTeam: string; awayTeam: string },
  sportKey: string,
  sportName: string,
  picks: ExpanderPick[]
): GridLiveGamePanelData {
  return {
    away: {
      teamLabel: shortTeamName(game.awayTeam, sportName),
      teamColor: getTeamColor(sportKey, game.awayTeam),
      picks: picks.filter((p) => p.teamGroup === "AWAY"),
    },
    home: {
      teamLabel: shortTeamName(game.homeTeam, sportName),
      teamColor: getTeamColor(sportKey, game.homeTeam),
      picks: picks.filter((p) => p.teamGroup === "HOME"),
    },
    // Not a real team - always the neutral-gray dot (teamColor: null), same
    // as GamePicksExpander's TOTALS group. Full-game totals, then period
    // totals, then team totals.
    totals: {
      teamLabel: TOTALS_GROUP_LABEL,
      teamColor: null,
      picks: sortTotalsPicks(picks.filter((p) => p.teamGroup === "TOTALS")),
    },
    // Not a real team either - violet accent, same as GamePicksExpander's
    // OTHER group.
    other: {
      teamLabel: OTHER_GROUP_LABEL,
      teamColor: null,
      tone: "violet",
      picks: picks.filter((p) => p.teamGroup === "OTHER"),
    },
  };
}

// Which team section leads in the panel: the team WITH picks should show
// first rather than a fixed away-then-home order, since an empty section
// leading into a populated one reads oddly. Only swaps when exactly one
// side has 0 picks and the other has 1+ - if both have picks, or both are
// empty, the away/home order is left alone rather than inventing a new rule
// for a case nobody complained about. The OTHER section is not part of
// this - GameDetailPanel always renders it after these two.
export function orderTeamSections(
  away: GridLiveTeamSideData,
  home: GridLiveTeamSideData
): [GridLiveTeamSideData, GridLiveTeamSideData] {
  if (away.picks.length === 0 && home.picks.length > 0) return [home, away];
  return [away, home];
}

// Which desktop column each non-team group (Totals, Other markets) sits in:
// GameDetailPanel's two columns stack independently, each headed by a team,
// and these groups go under whichever column is shorter so they fill the gap
// beneath a short team instead of waiting for the taller one to end. Placed
// one at a time, Totals first, each into the column that is shorter at that
// point - so a lopsided game gets both under the short team (Totals, then
// Other markets), and a balanced one gets one each. A tie goes left. Height
// is pick count, with an empty section counting as one (its empty-state line
// is about a card tall); every pick card in this panel is the same shape, so
// a measured height would say the same thing and need a layout pass to say it.
// Empty groups are not placed (GameDetailPanel hides them).
export type NonTeamSectionColumn = "left" | "right" | null;

export function placeNonTeamSections(
  leftPickCount: number,
  rightPickCount: number,
  totalsPickCount: number,
  otherPickCount: number
): { totals: NonTeamSectionColumn; other: NonTeamSectionColumn } {
  let left = Math.max(leftPickCount, 1);
  let right = Math.max(rightPickCount, 1);
  const place = (pickCount: number): NonTeamSectionColumn => {
    if (pickCount === 0) return null;
    if (left <= right) {
      left += pickCount;
      return "left";
    }
    right += pickCount;
    return "right";
  };
  const totals = place(totalsPickCount);
  const other = place(otherPickCount);
  return { totals, other };
}
