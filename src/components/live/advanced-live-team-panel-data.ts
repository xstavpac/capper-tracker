// Pure data shaping for Advanced Live's game-detail panel - filters an
// already-classified ExpanderPick[] (teamGroup computed upstream in
// live/page.tsx via classifyPickTeamGroup, exactly as Standard Live already
// does) into both sides of the matchup at once, plus each side's label/color.
// No team classification happens here - that would be a second, parallel run
// of the same classification Standard Live already paid for per pick; this
// only reads the field that classification already produced.
import { shortTeamName } from "@/lib/pick-team-group";
import { getTeamColor } from "@/lib/team-colors";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

export type AdvancedLiveTeamSideData = {
  teamLabel: string;
  teamColor: string | null;
  picks: ExpanderPick[];
};

export type AdvancedLiveGamePanelData = {
  away: AdvancedLiveTeamSideData;
  home: AdvancedLiveTeamSideData;
};

export function buildAdvancedLiveGamePanelData(
  game: { homeTeam: string; awayTeam: string },
  sportKey: string,
  sportName: string,
  picks: ExpanderPick[]
): AdvancedLiveGamePanelData {
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
  };
}
