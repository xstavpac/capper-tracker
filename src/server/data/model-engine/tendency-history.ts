// One team_tendency_snapshots read for a whole sync pass, instead of one per
// (event x team input). resolveTeamTendency (resolver.ts) used to query a
// team's full snapshot history every time a decay-delta event resolved its
// favorite or underdog - two queries per game, each re-reading the same
// teams. A pass that knows its teams up front (the graded pass's pending games,
// the pregame pass's unstarted games) builds one of these and hands it down
// through runModelDefinition's options; the first lookup runs the single batch
// read and every later lookup is served from it.
//
// This only changes where the rows come from: findLatestAtOrBefore still
// decides which row is "as of" the event, over rows in the same snapshotDate-
// ascending order resolveTeamTendency's own per-team query returns. A team the
// pass didn't name, or an asOf outside the pass's span (rowsFor returns null),
// falls back to that per-team query.
//
// Bounded to the pass's asOf span: given the dates the pass will resolve at
// (asOfs), each team's read keeps only the rows from its latest snapshot at or
// before the EARLIEST asOf day through the LATEST asOf day. That can't change
// which row findLatestAtOrBefore picks for any asOf in the pass: it picks the
// last row dated at or before the asOf's Eastern day, which is never after the
// latest asOf day, and never before the earliest day's pick (every older row is
// superseded by it). So the read stops growing with the team's whole history.
import { Prisma, type TeamTendencySnapshot } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";

export type TendencyHistorySource = {
  sportKey: string;
  // The team's snapshots for resolving at asOf, ascending by snapshotDate - or
  // null when this source wasn't built for that team, or asOf's day is outside
  // the asOf span the read was bounded to (the caller then reads it itself).
  rowsFor(teamName: string, asOf: Date): Promise<TeamTendencySnapshot[]> | null;
};

// The one read: every listed team's rows, ascending by snapshotDate, bounded
// as described above when the pass's asOf day keys (sorted; the same
// easternDateKey days findLatestAtOrBefore compares against) are known.
function readSnapshots(sportKey: string, teams: string[], dayKeys: string[]): Promise<TeamTendencySnapshot[]> {
  if (dayKeys.length === 0) {
    return prisma.teamTendencySnapshot.findMany({ where: { sportKey, teamName: { in: teams } }, orderBy: { snapshotDate: "asc" } });
  }
  const [earliest, latest] = [dayKeys[0], dayKeys[dayKeys.length - 1]];
  return prisma.$queryRaw<TeamTendencySnapshot[]>(Prisma.sql`
    SELECT t.* FROM team_tendency_snapshots t
    WHERE t."sportKey" = ${sportKey}
      AND t."teamName" = ANY(${teams}::text[])
      AND t."snapshotDate" <= ${latest}
      AND t."snapshotDate" >= COALESCE((
        SELECT max(s."snapshotDate") FROM team_tendency_snapshots s
        WHERE s."sportKey" = t."sportKey" AND s."teamName" = t."teamName" AND s."snapshotDate" <= ${earliest}
      ), '')
    ORDER BY t."snapshotDate" ASC`);
}

// asOfs: every date the pass will resolve at (bounds the read); omit for the
// team's whole history.
export function createTendencyHistorySource(sportKey: string, teamNames: Iterable<string>, asOfs: Date[] = []): TendencyHistorySource {
  const teams = new Set(teamNames);
  const keys = asOfs.map(easternDateKey).sort();
  let batch: Promise<Map<string, TeamTendencySnapshot[]>> | null = null;
  const load = () =>
    (batch ??= readSnapshots(sportKey, [...teams], keys)
      .then((rows) => {
        const byTeam = new Map<string, TeamTendencySnapshot[]>([...teams].map((t) => [t, []]));
        for (const r of rows) byTeam.get(r.teamName)?.push(r);
        return byTeam;
      }));
  return {
    sportKey,
    rowsFor(teamName, asOf) {
      if (!teams.has(teamName)) return null;
      if (keys.length > 0) {
        const key = easternDateKey(asOf);
        if (key < keys[0] || key > keys[keys.length - 1]) return null;
      }
      return load().then((byTeam) => byTeam.get(teamName) ?? []);
    },
  };
}
