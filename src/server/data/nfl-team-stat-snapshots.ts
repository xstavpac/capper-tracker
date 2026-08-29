// Pure transform for NFL team-stat ingestion: two nflverse CSVs in, one
// upsert-ready row per team per game out. No prisma, no fetch - so it's
// directly testable with small fixture strings (see
// nfl-team-stat-snapshots-acceptance-test.ts). captureNflTeamStatSnapshots
// in stat-snapshots.ts does the fetch + persist around this.
//
// Inputs:
//   - stats_team_week_{season}.csv - one row per team per game, box-score
//     stats, from `nflfastR::calculate_stats()`
//     (github.com/nflverse/nflverse-data releases/tag/stats_team)
//   - games.csv - schedule + final scores + game_id, from Lee Sharpe's
//     nfldata (releases/tag/schedules)
//
// Allowed-side stats (yards/points allowed) are taken from the OPPONENT's
// own-side row for the same game_id - a self-join within stats_team_week -
// rather than a separate play-by-play fetch.
//
// NOT AVAILABLE from stats_team_week (verified against the live 138-column
// file, not assumed): third-down attempts/conversions and time of
// possession. Both would need a play-by-play aggregation pipeline this
// module deliberately does not build - they come back null on every row and
// the schema column is nullable so a future PBP source can backfill them.
//
// nflverse has NO preseason data in this dataset and does not create
// stats_team_week_{season}.csv until Week 1 - an empty/absent stats file is
// handled as "zero rows, no error" (the 404 is caught upstream; an empty
// string here parses to zero rows).
import { parseCsv } from "@/lib/csv-metric-import";
import { normalizeNflTeamName } from "@/server/data/nfl-team-stats";

// Exactly the scalar columns of the NflTeamStatSnapshot model (minus the
// defaulted id/sourceId/scope/createdAt/updatedAt) - so a row can be passed
// straight to prisma.nflTeamStatSnapshot.upsert as both `create` and
// `update` with no field remapping.
export type NflTeamStatRow = {
  gameId: string;
  season: number;
  week: number;
  gameType: string; // games.csv game_type: REG | WC | DIV | CON | SB
  gameDate: string; // "YYYY-MM-DD"
  team: string; // normalized full "City Nickname"
  opponent: string; // normalized full "City Nickname"
  homeAway: "home" | "away";
  completed: boolean;

  // Scoring - from games.csv, oriented by homeAway. null until the game is final.
  points: number | null;
  pointsAllowed: number | null;

  // Yardage. totalYards / totalYardsAllowed are NET (passing + rushing -
  // sack yards lost), matching how NFL box scores report "total yards".
  // passingYards / rushingYards (and their *Allowed twins) are the raw feed
  // figures - passing is gross of sacks; subtract sackYardsLost for net.
  totalYards: number;
  totalYardsAllowed: number;
  passingYards: number;
  passingYardsAllowed: number;
  rushingYards: number;
  rushingYardsAllowed: number;
  offensivePlays: number; // pass attempts + carries + sacks taken
  yardsPerPlay: number | null; // totalYards / offensivePlays, null if no plays

  // First downs from stats_team_week is passing + rushing 1st downs only -
  // the feed carries no "1st downs by penalty" column, so this undercounts
  // by ~1-2 per game vs an official box score. Documented, not a bug.
  firstDowns: number;

  // Always null - see the module header. Nullable so a future play-by-play
  // source can populate them without a migration.
  thirdDownPct: number | null;
  thirdDownPctAllowed: number | null;
  timeOfPossessionSeconds: number | null;

  turnovers: number; // giveaways: interceptions thrown + fumbles lost
  takeaways: number; // defensive interceptions + opponent fumbles recovered
  turnoverMargin: number; // takeaways - turnovers

  sacks: number; // recorded BY this team's defense
  sacksAllowed: number; // suffered by this team's offense
  sackYardsLost: number; // yards lost on sacks taken (positive number)

  penalties: number;
  penaltyYards: number;

  // Pre-summed EPA from stats_team_week - not recomputed from play-by-play.
  passingEpa: number;
  rushingEpa: number;
  receivingEpa: number;
  offensiveEpa: number; // passingEpa + rushingEpa
};

export type NflIngestError = {
  kind: "unmapped_team" | "missing_schedule" | "missing_opponent" | "malformed_row";
  gameId?: string;
  detail: string;
};

export type BuildNflTeamStatRowsResult = { rows: NflTeamStatRow[]; errors: NflIngestError[] };

// stats_team_week columns read per team row (own side) - a non-empty
// non-numeric value in any of these marks the row malformed and skips it.
// An empty cell is treated as 0 (a team with no punts, no def interceptions,
// etc. legitimately has blanks in some columns).
const OWN_NUMERIC_FIELDS = [
  "passing_yards",
  "rushing_yards",
  "sack_yards_lost",
  "attempts",
  "carries",
  "sacks_suffered",
  "passing_first_downs",
  "rushing_first_downs",
  "passing_interceptions",
  "fumbles_lost_total",
  "def_interceptions",
  "fumble_recovery_opp",
  "def_sacks",
  "penalties",
  "penalty_yards",
  "passing_epa",
  "rushing_epa",
  "receiving_epa",
] as const;

type NumberReader = { get: (field: string) => number };

function readNumbers(row: Record<string, string>, fields: readonly string[]): NumberReader | { bad: string[] } {
  const values: Record<string, number> = {};
  const bad: string[] = [];
  for (const field of fields) {
    const raw = (row[field] ?? "").trim();
    if (raw === "") {
      values[field] = 0;
      continue;
    }
    const n = Number(raw);
    if (Number.isNaN(n)) {
      bad.push(field);
      continue;
    }
    values[field] = n;
  }
  if (bad.length > 0) return { bad };
  return { get: (field) => values[field] ?? 0 };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

type ScheduleGame = {
  gameId: string;
  gameType: string;
  gameDate: string;
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number | null;
  awayScore: number | null;
  completed: boolean;
};

function indexSchedule(gamesCsv: string): Map<string, ScheduleGame> {
  const { rows } = parseCsv(gamesCsv);
  const byId = new Map<string, ScheduleGame>();
  for (const r of rows) {
    const gameId = (r["game_id"] ?? "").trim();
    if (!gameId) continue;
    const homeRaw = (r["home_score"] ?? "").trim();
    const awayRaw = (r["away_score"] ?? "").trim();
    const completed = homeRaw !== "" && awayRaw !== "";
    byId.set(gameId, {
      gameId,
      gameType: (r["game_type"] ?? "").trim(),
      gameDate: (r["gameday"] ?? "").trim(),
      homeAbbr: (r["home_team"] ?? "").trim(),
      awayAbbr: (r["away_team"] ?? "").trim(),
      homeScore: completed ? Number(homeRaw) : null,
      awayScore: completed ? Number(awayRaw) : null,
      completed,
    });
  }
  return byId;
}

// Net total yards, the figure every NFL box score labels "total yards":
// gross passing + rushing, minus yards lost on sacks. sack_yards_lost is
// stored negative in the feed; Math.abs keeps this correct regardless of
// sign convention.
function netTotalYards(n: NumberReader): number {
  return n.get("passing_yards") + n.get("rushing_yards") - Math.abs(n.get("sack_yards_lost"));
}

export function buildNflTeamStatRows(statsTeamWeekCsv: string, gamesCsv: string): BuildNflTeamStatRowsResult {
  const rows: NflTeamStatRow[] = [];
  const errors: NflIngestError[] = [];

  const schedule = indexSchedule(gamesCsv);
  const { rows: statRows } = parseCsv(statsTeamWeekCsv);

  // (game_id | team_abbr) -> raw row, for the opponent self-join.
  const statByGameTeam = new Map<string, Record<string, string>>();
  for (const r of statRows) {
    const gameId = (r["game_id"] ?? "").trim();
    const team = (r["team"] ?? "").trim();
    if (gameId && team) statByGameTeam.set(`${gameId}|${team}`, r);
  }

  for (const r of statRows) {
    const gameId = (r["game_id"] ?? "").trim();
    const teamAbbr = (r["team"] ?? "").trim();
    const oppAbbr = (r["opponent_team"] ?? "").trim();
    const season = Number((r["season"] ?? "").trim());
    const week = Number((r["week"] ?? "").trim());

    if (!gameId || !teamAbbr || !oppAbbr || Number.isNaN(season) || Number.isNaN(week)) {
      errors.push({
        kind: "malformed_row",
        gameId: gameId || undefined,
        detail: `missing/invalid key fields (game_id=${gameId || "?"}, team=${teamAbbr || "?"}, opponent=${oppAbbr || "?"}, season=${r["season"] ?? "?"}, week=${r["week"] ?? "?"})`,
      });
      continue;
    }

    const game = schedule.get(gameId);
    if (!game) {
      errors.push({ kind: "missing_schedule", gameId, detail: `game_id in stats_team_week but not in games.csv` });
      continue;
    }

    const team = normalizeNflTeamName(teamAbbr);
    if (!team) {
      errors.push({ kind: "unmapped_team", gameId, detail: `unknown team abbreviation "${teamAbbr}"` });
      continue;
    }
    const opponent = normalizeNflTeamName(oppAbbr);
    if (!opponent) {
      errors.push({ kind: "unmapped_team", gameId, detail: `unknown opponent abbreviation "${oppAbbr}"` });
      continue;
    }

    const oppRaw = statByGameTeam.get(`${gameId}|${oppAbbr}`);
    if (!oppRaw) {
      errors.push({ kind: "missing_opponent", gameId, detail: `no stats_team_week row for opponent "${oppAbbr}"` });
      continue;
    }

    const own = readNumbers(r, OWN_NUMERIC_FIELDS);
    if ("bad" in own) {
      errors.push({ kind: "malformed_row", gameId, detail: `non-numeric ${own.bad.join(", ")} for ${teamAbbr}` });
      continue;
    }
    const opp = readNumbers(oppRaw, OWN_NUMERIC_FIELDS);
    if ("bad" in opp) {
      errors.push({ kind: "malformed_row", gameId, detail: `non-numeric ${opp.bad.join(", ")} for opponent ${oppAbbr}` });
      continue;
    }

    const isHome = game.homeAbbr === teamAbbr;
    const homeAway: "home" | "away" = isHome ? "home" : "away";

    const teamScore = isHome ? game.homeScore : game.awayScore;
    const oppScore = isHome ? game.awayScore : game.homeScore;

    const totalYards = netTotalYards(own);
    const totalYardsAllowed = netTotalYards(opp);
    const offensivePlays = own.get("attempts") + own.get("carries") + own.get("sacks_suffered");

    const turnovers = own.get("passing_interceptions") + own.get("fumbles_lost_total");
    const takeaways = own.get("def_interceptions") + own.get("fumble_recovery_opp");
    const passingEpa = own.get("passing_epa");
    const rushingEpa = own.get("rushing_epa");

    rows.push({
      gameId,
      season,
      week,
      gameType: game.gameType,
      gameDate: game.gameDate,
      team,
      opponent,
      homeAway,
      completed: game.completed,

      points: game.completed ? teamScore : null,
      pointsAllowed: game.completed ? oppScore : null,

      totalYards,
      totalYardsAllowed,
      passingYards: own.get("passing_yards"),
      passingYardsAllowed: opp.get("passing_yards"),
      rushingYards: own.get("rushing_yards"),
      rushingYardsAllowed: opp.get("rushing_yards"),
      offensivePlays,
      yardsPerPlay: offensivePlays > 0 ? round2(totalYards / offensivePlays) : null,

      firstDowns: own.get("passing_first_downs") + own.get("rushing_first_downs"),

      thirdDownPct: null,
      thirdDownPctAllowed: null,
      timeOfPossessionSeconds: null,

      turnovers,
      takeaways,
      turnoverMargin: takeaways - turnovers,

      sacks: own.get("def_sacks"),
      sacksAllowed: own.get("sacks_suffered"),
      sackYardsLost: Math.abs(own.get("sack_yards_lost")),

      penalties: own.get("penalties"),
      penaltyYards: own.get("penalty_yards"),

      passingEpa,
      rushingEpa,
      receivingEpa: own.get("receiving_epa"),
      offensiveEpa: passingEpa + rushingEpa,
    });
  }

  return { rows, errors };
}
