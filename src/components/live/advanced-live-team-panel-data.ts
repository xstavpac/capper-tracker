// Pure data shaping for Advanced Live's single-team picks panel - filters an
// already-classified ExpanderPick[] (teamGroup computed upstream in
// live/page.tsx via classifyPickTeamGroup, exactly as Standard Live already
// does) down to one side of the matchup, plus the label/color for both that
// team and the game's other team (for the panel's swap control). No team
// classification happens here - that would be a second, parallel run of the
// same classification Standard Live already paid for per pick; this only
// reads the field that classification already produced.
import { shortTeamName } from "@/lib/pick-team-group";
import { getTeamColor } from "@/lib/team-colors";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { AdvancedLiveTeamSide } from "@/lib/advanced-live-selection";

export type AdvancedLiveTeamPanelData = {
  team: AdvancedLiveTeamSide;
  teamLabel: string;
  teamColor: string | null;
  otherTeam: AdvancedLiveTeamSide;
  otherTeamLabel: string;
  picks: ExpanderPick[];
};

export function buildAdvancedLiveTeamPanelData(
  team: AdvancedLiveTeamSide,
  game: { homeTeam: string; awayTeam: string },
  sportKey: string,
  sportName: string,
  picks: ExpanderPick[]
): AdvancedLiveTeamPanelData {
  const otherTeam: AdvancedLiveTeamSide = team === "home" ? "away" : "home";
  const fullName = team === "home" ? game.homeTeam : game.awayTeam;
  const otherFullName = otherTeam === "home" ? game.homeTeam : game.awayTeam;
  const teamGroup = team === "home" ? "HOME" : "AWAY";

  return {
    team,
    teamLabel: shortTeamName(fullName, sportName),
    teamColor: getTeamColor(sportKey, fullName),
    otherTeam,
    otherTeamLabel: shortTeamName(otherFullName, sportName),
    picks: picks.filter((p) => p.teamGroup === teamGroup),
  };
}
