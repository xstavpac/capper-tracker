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
import { OTHER_GROUP_LABEL, shortTeamName } from "@/lib/pick-team-group";
import { getTeamColor } from "@/lib/team-colors";

export type GridLiveTeamSideData = {
  teamLabel: string;
  teamColor: string | null;
  picks: ExpanderPick[];
};

export type GridLiveGamePanelData = {
  away: GridLiveTeamSideData;
  home: GridLiveTeamSideData;
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
    // as GamePicksExpander's OTHER group.
    other: {
      teamLabel: OTHER_GROUP_LABEL,
      teamColor: null,
      picks: picks.filter((p) => p.teamGroup === "OTHER"),
    },
  };
}
