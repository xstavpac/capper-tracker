// Canonical per-game facts, read straight from GameResult - deliberately a
// separate access path from resolveVariable(). favTeam/totalLine/
// lineSource/scores/team names/gameDate are persisted historical facts
// about one specific game, not point-in-time snapshot variables - there is
// no "as of" question to ask about who the favorite was in a game that has
// already happened and whose GameResult row was written once, at grading
// time. No snapshot lookup, no findLatestAtOrBefore - a direct id read is
// the whole mechanism.
import { prisma } from "@/lib/prisma";

export type EvaluationEventFacts = {
  gameResultId: string;
  sportKey: string;
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  gameDate: Date;
  favTeam: string | null;
  totalLine: number | null;
  lineSource: string | null;
};

export async function getEvaluationEventFacts(gameResultId: string): Promise<EvaluationEventFacts | null> {
  const row = await prisma.gameResult.findUnique({ where: { id: gameResultId } });
  if (!row) return null;
  return {
    gameResultId: row.id,
    sportKey: row.sportKey,
    externalId: row.externalId,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    homeScore: row.homeScore,
    awayScore: row.awayScore,
    gameDate: row.gameDate,
    favTeam: row.favTeam,
    totalLine: row.totalLine,
    lineSource: row.lineSource,
  };
}
