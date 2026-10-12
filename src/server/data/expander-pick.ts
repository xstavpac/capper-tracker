// Builds the ExpanderPick the Live board and the Parlay Generator show for one
// pick under one game. Split out of live-board-picks.ts so the Parlay slip's
// server-side rebuild (parlay-slip-picks.ts) produces the identical object
// from a pick row, rather than keeping a second copy of this mapping.
//
// homeTeam/awayTeam/gameTime/gameId are the GAME's, not the pick row's: a
// pick's own stored teams and time are whatever the import resolved (for an
// import that matched no game, the time is the import time).
import type { Capper, Pick } from "@prisma/client";
import { pickCategory, betTypeLabel } from "@/server/data/stats";
import { classifyPickTeamGroup, shortTeamName } from "@/lib/pick-team-group";
import { getTeamColor } from "@/lib/team-colors";
import { formatPickLabel } from "@/lib/bet-line";
import { type ExpanderPick } from "@/components/live/game-picks-expander";

export type ExpanderPickGame = { id: string; homeTeam: string; awayTeam: string; commenceTime: string };

export function toExpanderPick(
  p: Pick & { capper: Capper },
  game: ExpanderPickGame,
  activeSport: string,
  sportLabel: string
): ExpanderPick & { datePosted: string } {
  const teamGroup = classifyPickTeamGroup(p, game, sportLabel);
  return {
    pickId: p.id,
    capperId: p.capperId,
    capperName: p.capper.name,
    capperColorTag: p.capper.colorTag,
    capperIsFavorite: p.capper.isFavorite,
    category: pickCategory({ ...p, sportName: sportLabel }),
    leagueName: sportLabel,
    gameId: game.id,
    // "Away @ Home" using the same short names the pick card's team-group
    // header already shows - the Parlay Pool's only use for this is a
    // human-readable label next to a pooled pick, not a lookup key (pickId
    // already is one).
    gameLabel: shortTeamName(game.awayTeam, sportLabel) + " @ " + shortTeamName(game.homeTeam, sportLabel),
    betDetail: formatPickLabel(p.betDetail, p.betType, p.line) ?? betTypeLabel(p.betType),
    odds: p.odds,
    units: p.units,
    status: p.status,
    betType: p.betType,
    period: p.period,
    rawBetDetail: p.betDetail,
    line: p.line,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    gameTime: game.commenceTime,
    teamGroup,
    teamLabel:
      teamGroup === "AWAY"
        ? shortTeamName(game.awayTeam, sportLabel)
        : teamGroup === "HOME"
          ? shortTeamName(game.homeTeam, sportLabel)
          : "",
    teamColor:
      teamGroup === "AWAY"
        ? getTeamColor(activeSport, game.awayTeam)
        : teamGroup === "HOME"
          ? getTeamColor(activeSport, game.homeTeam)
          : null,
    datePosted: p.datePosted.toISOString(),
  };
}
