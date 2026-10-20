// One team_tendency_snapshots read for a whole sync pass, instead of one per
// (event x team input). resolveTeamTendency (resolver.ts) used to query a
// team's full snapshot history every time a decay-delta event resolved its
// favorite or underdog - two queries per game, each re-reading the same
// teams. A pass that knows its teams up front (the graded pass's pending games,
// the pregame pass's unstarted games) builds one of these and hands it down
// through runModelDefinition's options; the first lookup runs the single batch
// read and every later lookup is served from it.
//
// This only changes where the rows come from. Each team's rows are the same
// rows, in the same snapshotDate-ascending order, that resolveTeamTendency's
// own per-team query returns, and findLatestAtOrBefore still decides which one
// is "as of" the event. A team the pass didn't name (rowsFor returns null)
// falls back to that per-team query.
import type { TeamTendencySnapshot } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type TendencyHistorySource = {
  sportKey: string;
  // The team's snapshots, ascending by snapshotDate - or null when this source
  // wasn't built for that team (the caller then reads it itself).
  rowsFor(teamName: string): Promise<TeamTendencySnapshot[]> | null;
};

export function createTendencyHistorySource(sportKey: string, teamNames: Iterable<string>): TendencyHistorySource {
  const teams = new Set(teamNames);
  let batch: Promise<Map<string, TeamTendencySnapshot[]>> | null = null;
  const load = () =>
    (batch ??= prisma.teamTendencySnapshot
      .findMany({ where: { sportKey, teamName: { in: [...teams] } }, orderBy: { snapshotDate: "asc" } })
      .then((rows) => {
        const byTeam = new Map<string, TeamTendencySnapshot[]>([...teams].map((t) => [t, []]));
        for (const r of rows) byTeam.get(r.teamName)?.push(r);
        return byTeam;
      }));
  return {
    sportKey,
    rowsFor(teamName) {
      if (!teams.has(teamName)) return null;
      return load().then((byTeam) => byTeam.get(teamName) ?? []);
    },
  };
}
