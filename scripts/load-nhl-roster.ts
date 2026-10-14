// Manual load of the NhlRosterPlayer cache table from ESPN's live roster
// endpoint (all 32 teams, C/LW/RW/D/G - see server/data/nhl-roster.ts). The
// same loader runs daily in season from /api/cron/refresh-rosters; this is the
// by-hand path (a backfill, a check, or --force after a short-team skip). Run:
//
//   npx tsx scripts/load-nhl-roster.ts                    (dry run - the default)
//   npx tsx scripts/load-nhl-roster.ts --commit           (writes)
//   npx tsx scripts/load-nhl-roster.ts --commit --force   (also deactivates on short teams)
//
// Flags and guards: see scripts/roster-load-script.ts.
import { runRosterLoadScript } from "./roster-load-script";

runRosterLoadScript("NHL");
