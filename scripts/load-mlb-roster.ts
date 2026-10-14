// Manual load of the MlbRosterPlayer cache table from the MLB Stats API's 40-man
// rosters (all 30 teams, every position - see server/data/mlb-roster.ts). The
// same loader runs daily in season from /api/cron/refresh-rosters; this is the
// by-hand path - in particular before opening day, when the first in-season run
// would otherwise meet a whole winter of roster moves. Run:
//
//   npx tsx scripts/load-mlb-roster.ts                      (dry run - the default)
//   npx tsx scripts/load-mlb-roster.ts --commit             (writes)
//   npx tsx scripts/load-mlb-roster.ts --commit --force     (also deactivates on short teams)
//   npx tsx scripts/load-mlb-roster.ts --season=2027        (roster year; default = current year)
//
// Flags and guards: see scripts/roster-load-script.ts.
import { fetchMlbLeagueRoster } from "@/server/data/mlb-roster";
import { mlbRosterSeason } from "@/server/data/roster-leagues";
import { runRosterLoadScript } from "./roster-load-script";

const seasonArg = process.argv.find((a) => a.startsWith("--season="));
const season = seasonArg ? parseInt(seasonArg.slice("--season=".length), 10) : mlbRosterSeason();
if (!Number.isInteger(season) || season < 2000) throw new Error("bad --season value");

runRosterLoadScript("MLB", { fetchRoster: () => fetchMlbLeagueRoster(season), extraHeader: `season=${season}` });
