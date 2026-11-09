import { isAuthorizedCronRequest } from "@/server/data/refresh-rosters";
import { runCronLogged } from "@/server/data/cron-runs";
import { runQueryStatSnapshot } from "@/server/data/query-stat-snapshots";

export const dynamic = "force-dynamic";
// One read of pg_stat_statements counters, one baseline read, one write transaction.
export const maxDuration = 60;

// Daily at 08:15 UTC (3:15 am Eastern; see vercel.json), off-peak and after the
// refresh-scores cron (06:55). Subtracts the counters it stored last time from
// pg_stat_statements' current ones for the tracked queries and adds the day's delta to
// query_stat_daily - see lib/query-stat-snapshots.ts. It changes no query, cache or
// app behavior.
//
// Fails closed like refresh-rosters: with CRON_SECRET unset every request is rejected.
export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return runCronLogged("db-stats-snapshot", run);
}

async function run(): Promise<Response> {
  return Response.json(await runQueryStatSnapshot());
}
