// Same two-layer split as nfl-passer-rows.ts, for the "rushing" and
// "receiving" boxscore categories instead of "passing":
//
//   ESPN response -> extractRushingRows()/extractReceivingRows() -> ALL rows
//                                              |
//                                    persistNflRushingRows()/
//                                    persistNflReceivingRows()
//                                    (database storage, every row, no
//                                     selection)
//
// Unlike passing, there is no "pick one player" selection step here and none
// is planned: a game has one clear starting QB, but many players carry the
// ball or catch a pass in a single game, and every one of them is a real,
// gradable rushing/receiving-prop candidate (RB1, RB2, a WR screen, a TE
// checkdown, a gadget-play carry - all real, all seen in these same Week 1
// 2026 box scores this file's tests use). extractRushingRows/
// extractReceivingRows are intentionally "dumb", same as extractPasserRows:
// they parse ESPN's rushing/receiving categories faithfully and keep every
// row ESPN reports, with no notion of "starter" or "the RB"/"the WR".
//
// A player who both rushes and catches passes (very common - a receiving RB,
// a jet-sweep WR) shows up as one row in extractRushingRows and a separate
// row in extractReceivingRows, exactly mirroring how ESPN itself reports
// that player as two separate athlete entries in two separate statistics
// categories. This file never merges those two rows into one - callers that
// want a single "yards from scrimmage" figure combine them later.
import { prisma } from "@/lib/prisma";

export type RushingRow = {
  externalId: string; // ESPN NFL event id - matches GameResult.externalId
  team: string; // ESPN's own team displayName, e.g. "Buffalo Bills" - matches GameResult.homeTeam/awayTeam
  espnPlayerId: string | null; // ESPN athlete.id - every real response seen so far has one, but not assumed
  playerName: string;
  carries: number; // ESPN's "CAR" column
  rushingYards: number; // ESPN's "YDS" column - can be negative (a team's net rushing loss on a player's carries)
  yardsPerCarry: number; // ESPN's "AVG" column
  touchdowns: number;
  long: number; // ESPN's "LONG" column - can be negative if every carry lost yards
};

export type ReceivingRow = {
  externalId: string;
  team: string;
  espnPlayerId: string | null;
  playerName: string;
  receptions: number; // ESPN's "REC" column
  receivingYards: number; // ESPN's "YDS" column - can be negative (e.g. a screen pass tackled for a loss)
  yardsPerReception: number; // ESPN's "AVG" column
  touchdowns: number;
  long: number;
  targets: number; // ESPN's "TGTS" column - can exceed receptions (targeted but didn't catch it), including 0-reception rows
};

function parseIntOrZero(v: string | undefined): number {
  return parseInt(v ?? "0", 10) || 0;
}

function parseFloatOrZero(v: string | undefined): number {
  const n = parseFloat(v ?? "0");
  return Number.isNaN(n) ? 0 : n;
}

// Pure transform: an already-fetched ESPN NFL summary response (the same
// `{ boxscore: { players: [...] } }` shape extractPasserRows/
// getNflPlayerTdStats read) -> every rushing row for the game, unfiltered
// and unselected. No network call here - see fetchNflRushingReceivingRows
// below for the fetch wrapper.
export function extractRushingRows(externalId: string, espnSummaryResponse: unknown): RushingRow[] {
  const teams = (espnSummaryResponse as { boxscore?: { players?: unknown[] } })?.boxscore?.players ?? [];
  const rows: RushingRow[] = [];

  for (const team of teams as any[]) {
    const teamName: string | undefined = team.team?.displayName;
    if (!teamName) continue;

    const rushing = (team.statistics ?? []).find((c: any) => c.name === "rushing");
    if (!rushing) continue;

    const labels: string[] = rushing.labels ?? [];
    const carIndex = labels.indexOf("CAR");
    const ydsIndex = labels.indexOf("YDS");
    const avgIndex = labels.indexOf("AVG");
    const tdIndex = labels.indexOf("TD");
    const longIndex = labels.indexOf("LONG");

    for (const athlete of rushing.athletes ?? []) {
      const playerName: string | undefined = athlete.athlete?.displayName;
      if (!playerName) continue;

      const stats: string[] = athlete.stats ?? [];

      rows.push({
        externalId,
        team: teamName,
        espnPlayerId: athlete.athlete?.id ?? null,
        playerName,
        carries: carIndex !== -1 ? parseIntOrZero(stats[carIndex]) : 0,
        rushingYards: ydsIndex !== -1 ? parseIntOrZero(stats[ydsIndex]) : 0,
        yardsPerCarry: avgIndex !== -1 ? parseFloatOrZero(stats[avgIndex]) : 0,
        touchdowns: tdIndex !== -1 ? parseIntOrZero(stats[tdIndex]) : 0,
        long: longIndex !== -1 ? parseIntOrZero(stats[longIndex]) : 0,
      });
    }
  }

  return rows;
}

// Same shape as extractRushingRows, for the "receiving" category.
export function extractReceivingRows(externalId: string, espnSummaryResponse: unknown): ReceivingRow[] {
  const teams = (espnSummaryResponse as { boxscore?: { players?: unknown[] } })?.boxscore?.players ?? [];
  const rows: ReceivingRow[] = [];

  for (const team of teams as any[]) {
    const teamName: string | undefined = team.team?.displayName;
    if (!teamName) continue;

    const receiving = (team.statistics ?? []).find((c: any) => c.name === "receiving");
    if (!receiving) continue;

    const labels: string[] = receiving.labels ?? [];
    const recIndex = labels.indexOf("REC");
    const ydsIndex = labels.indexOf("YDS");
    const avgIndex = labels.indexOf("AVG");
    const tdIndex = labels.indexOf("TD");
    const longIndex = labels.indexOf("LONG");
    const tgtsIndex = labels.indexOf("TGTS");

    for (const athlete of receiving.athletes ?? []) {
      const playerName: string | undefined = athlete.athlete?.displayName;
      if (!playerName) continue;

      const stats: string[] = athlete.stats ?? [];

      rows.push({
        externalId,
        team: teamName,
        espnPlayerId: athlete.athlete?.id ?? null,
        playerName,
        receptions: recIndex !== -1 ? parseIntOrZero(stats[recIndex]) : 0,
        receivingYards: ydsIndex !== -1 ? parseIntOrZero(stats[ydsIndex]) : 0,
        yardsPerReception: avgIndex !== -1 ? parseFloatOrZero(stats[avgIndex]) : 0,
        touchdowns: tdIndex !== -1 ? parseIntOrZero(stats[tdIndex]) : 0,
        long: longIndex !== -1 ? parseIntOrZero(stats[longIndex]) : 0,
        targets: tgtsIndex !== -1 ? parseIntOrZero(stats[tgtsIndex]) : 0,
      });
    }
  }

  return rows;
}

// Fetch wrapper - same ESPN NFL summary endpoint extractPasserRows/
// getNflPlayerTdStats already call for a different slice of the same
// response. One fetch, both categories extracted from the single parsed
// response (rushing and receiving live in the same boxscore.players[]
// payload, so there is no reason to fetch twice).
export async function fetchNflRushingReceivingRows(
  eventId: string
): Promise<{ rushing: RushingRow[]; receiving: ReceivingRow[] } | null> {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=" + eventId, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = await res.json();
  return {
    rushing: extractRushingRows(eventId, data),
    receiving: extractReceivingRows(eventId, data),
  };
}

// Writes every rushing row as-is to nfl_rushing_rows - no selection applied.
// Upserted on (externalId, team, playerName), same key shape as
// persistNflPasserRows.
export async function persistNflRushingRows(rows: RushingRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  await Promise.all(
    rows.map((row) =>
      prisma.nflRushingRow.upsert({
        where: { externalId_team_playerName: { externalId: row.externalId, team: row.team, playerName: row.playerName } },
        update: row,
        create: row,
      })
    )
  );

  return rows.length;
}

// Same as persistNflRushingRows, for nfl_receiving_rows.
export async function persistNflReceivingRows(rows: ReceivingRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  await Promise.all(
    rows.map((row) =>
      prisma.nflReceivingRow.upsert({
        where: { externalId_team_playerName: { externalId: row.externalId, team: row.team, playerName: row.playerName } },
        update: row,
        create: row,
      })
    )
  );

  return rows.length;
}
