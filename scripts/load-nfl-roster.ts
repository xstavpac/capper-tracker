// Manual load of the NflRosterPlayer cache table from ESPN's live roster
// endpoint (all 32 teams, QB/RB/WR/TE only - see server/data/nfl-roster.ts's
// extractRosterPlayers). The same loader runs daily in season from
// /api/cron/refresh-rosters; this is the by-hand path (a backfill, a check, or
// --force after a short-team skip). Run with tsx:
//
//   npx tsx scripts/load-nfl-roster.ts                    (dry run - the default)
//   npx tsx scripts/load-nfl-roster.ts --commit           (writes)
//   npx tsx scripts/load-nfl-roster.ts --commit --force   (also deactivates on short teams)
//
// Flags and guards: see scripts/roster-load-script.ts. Catalog-import recovery
// (server/data/nfl-roster-cache.ts) only ever reads whatever was last written;
// it never fetches ESPN itself.
import { runRosterLoadScript } from "./roster-load-script";

runRosterLoadScript("NFL");
