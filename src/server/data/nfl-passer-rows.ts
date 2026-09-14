// Two deliberately separate layers for NFL passing box-score data:
//
//   ESPN response -> extractPasserRows() -> ALL PasserRow records
//                                              |
//                              +---------------+---------------+
//                              |                                |
//                        persistNflPasserRows()          selectQbPasserRow()
//                        (database storage,                (policy: which row
//                         every row, no selection)           counts as "the QB")
//
// extractPasserRows is intentionally "dumb": it parses ESPN's passing
// category faithfully and keeps every row ESPN reports, with no notion of
// "starter" or "the QB" - a team can and does show up with more than one
// row per game (backup mop-up reps, an injury replacement, a gadget-play
// pass, even a punter throwing a trick-play pass - all real, all seen in
// Week 1 2026 box scores; see the multi-passer fixtures under __fixtures__
// and the passing/rushing/receiving extraction this file sits alongside in
// getNflPlayerTdStats, odds.ts). It never calls selectQbPasserRow, and
// persistNflPasserRows never drops a row because selectQbPasserRow wouldn't
// have picked it - which row "counts" as the QB is a separate, later
// decision, made only by callers that need one (a passing-prop grader, once
// that schema work happens - not this file).
import { prisma } from "@/lib/prisma";

export type PasserRow = {
  externalId: string; // ESPN NFL event id - matches GameResult.externalId
  team: string; // ESPN's own team displayName, e.g. "Buffalo Bills" - matches GameResult.homeTeam/awayTeam
  espnPlayerId: string | null; // ESPN athlete.id - every real response seen so far has one, but not assumed
  playerName: string;
  completions: number;
  attempts: number;
  passingYards: number;
  yardsPerAttempt: number;
  touchdowns: number;
  interceptions: number;
  sacks: number;
  sackYardsLost: number;
  qbr: number | null; // null when ESPN reports "--" (too few plays to compute one)
  rating: number;
};

function parseIntOrZero(v: string | undefined): number {
  return parseInt(v ?? "0", 10) || 0;
}

function parseFloatOrZero(v: string | undefined): number {
  const n = parseFloat(v ?? "0");
  return Number.isNaN(n) ? 0 : n;
}

function parseFloatOrNull(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

// ESPN's "C/ATT" column is one combined string ("20/29"), not separate
// completions/attempts columns.
function parseCompletionsAttempts(v: string | undefined): { completions: number; attempts: number } {
  const [c, a] = String(v ?? "0/0").split("/");
  return { completions: parseInt(c, 10) || 0, attempts: parseInt(a, 10) || 0 };
}

// Same combined-column shape as C/ATT: ESPN's "SACKS" column is "2-11"
// (sacks taken - yards lost), not two separate columns.
function parseSacks(v: string | undefined): { sacks: number; sackYardsLost: number } {
  const [s, y] = String(v ?? "0-0").split("-");
  return { sacks: parseInt(s, 10) || 0, sackYardsLost: parseInt(y, 10) || 0 };
}

// Pure transform: an already-fetched ESPN NFL summary response (the same
// `{ boxscore: { players: [...] } }` shape getNflPlayerTdStats reads in
// odds.ts) -> every passer row for the game, unfiltered and unselected. No
// network call here - see fetchNflPasserRows below for the fetch wrapper.
export function extractPasserRows(externalId: string, espnSummaryResponse: unknown): PasserRow[] {
  const teams = (espnSummaryResponse as { boxscore?: { players?: unknown[] } })?.boxscore?.players ?? [];
  const rows: PasserRow[] = [];

  for (const team of teams as any[]) {
    const teamName: string | undefined = team.team?.displayName;
    if (!teamName) continue;

    const passing = (team.statistics ?? []).find((c: any) => c.name === "passing");
    if (!passing) continue;

    const labels: string[] = passing.labels ?? [];
    const cAttIndex = labels.indexOf("C/ATT");
    const ydsIndex = labels.indexOf("YDS");
    const avgIndex = labels.indexOf("AVG");
    const tdIndex = labels.indexOf("TD");
    const intIndex = labels.indexOf("INT");
    const sacksIndex = labels.indexOf("SACKS");
    const qbrIndex = labels.indexOf("QBR");
    const rtgIndex = labels.indexOf("RTG");

    for (const athlete of passing.athletes ?? []) {
      const playerName: string | undefined = athlete.athlete?.displayName;
      if (!playerName) continue;

      const stats: string[] = athlete.stats ?? [];
      const { completions, attempts } = parseCompletionsAttempts(cAttIndex !== -1 ? stats[cAttIndex] : undefined);
      const { sacks, sackYardsLost } = parseSacks(sacksIndex !== -1 ? stats[sacksIndex] : undefined);

      rows.push({
        externalId,
        team: teamName,
        espnPlayerId: athlete.athlete?.id ?? null,
        playerName,
        completions,
        attempts,
        passingYards: ydsIndex !== -1 ? parseIntOrZero(stats[ydsIndex]) : 0,
        yardsPerAttempt: avgIndex !== -1 ? parseFloatOrZero(stats[avgIndex]) : 0,
        touchdowns: tdIndex !== -1 ? parseIntOrZero(stats[tdIndex]) : 0,
        interceptions: intIndex !== -1 ? parseIntOrZero(stats[intIndex]) : 0,
        sacks,
        sackYardsLost,
        qbr: qbrIndex !== -1 ? parseFloatOrNull(stats[qbrIndex]) : null,
        rating: rtgIndex !== -1 ? parseFloatOrZero(stats[rtgIndex]) : 0,
      });
    }
  }

  return rows;
}

// Fetch wrapper - same ESPN NFL summary endpoint getNflPlayerTdStats already
// calls in odds.ts for a different slice of the same response (rushing/
// receiving TDs there, passing rows here). Kept as its own fetch rather than
// threading the parsed response through getNflPlayerTdStats, matching how
// getEspnGameSegments/getNflGameFacts already each fetch this same endpoint
// independently for their own slice.
export async function fetchNflPasserRows(eventId: string): Promise<PasserRow[] | null> {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=" + eventId, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = await res.json();
  return extractPasserRows(eventId, data);
}

// Writes every row as-is to nfl_passer_rows - no selection applied. Upserted
// on (externalId, team, playerName) so re-running this for an already-
// captured game updates rows in place instead of duplicating them.
export async function persistNflPasserRows(rows: PasserRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  await Promise.all(
    rows.map((row) =>
      prisma.nflPasserRow.upsert({
        where: { externalId_team_playerName: { externalId: row.externalId, team: row.team, playerName: row.playerName } },
        update: row,
        create: row,
      })
    )
  );

  return rows.length;
}

// The ONLY place "which passer row counts as the QB" is decided. Operates
// entirely on already-extracted rows (raw extraction never calls this, and
// persistNflPasserRows never uses its result to decide what to keep) - see
// this file's header. Current policy: highest attempts wins.
//
// Deterministic tie-break, applied in order, for when attempts alone
// doesn't produce a unique winner:
//   1. attempts, descending (the policy itself)
//   2. passingYards, descending (a domain-specific signal: among passers
//      with the same attempt count, the one who produced more yards is the
//      more central passing option, not an arbitrary second sort key)
//   3. playerName, ascending (plain lexical order - a final, always-total
//      tie-break so the result never depends on the input array's or a DB
//      query's incidental ordering, even in the degenerate case where two
//      rows also tie on passingYards)
//
// Future policy changes (a minimum-attempts floor, depth-chart lookups,
// market-specific selection, rotation handling) belong here and only here -
// never in extractPasserRows or the persistence path.
export function selectQbPasserRow<T extends { playerName: string; attempts: number; passingYards: number }>(
  rows: T[]
): T | undefined {
  if (rows.length === 0) return undefined;

  return [...rows].sort((a, b) => {
    if (b.attempts !== a.attempts) return b.attempts - a.attempts;
    if (b.passingYards !== a.passingYards) return b.passingYards - a.passingYards;
    return a.playerName.localeCompare(b.playerName);
  })[0];
}
