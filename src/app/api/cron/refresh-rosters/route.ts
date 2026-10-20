import { revalidateTag } from "next/cache";
import { ROSTER_LEAGUE_ORDER, ROSTER_LEAGUES } from "@/server/data/roster-leagues";
import { rosterTableFor } from "@/server/data/roster-tables";
import { isAuthorizedCronRequest, refreshRosters, rosterCacheTagsToRevalidate, rosterRefreshSummary } from "@/server/data/refresh-rosters";
import { runCronLogged } from "@/server/data/cron-runs";

export const dynamic = "force-dynamic";
// A normal run is four parallel league fetches (1-2s each, measured 2026-10-14)
// plus one narrow table read and a handful of row writes per league. Even a
// first load into an empty table is one createMany per league. Same ceiling as
// grade-picks.
export const maxDuration = 60;

// Daily at 10:45 UTC (see vercel.json). Keeps the four roster cache tables
// (NFL / NHL / NBA / MLB) current through trades, signings, call-ups and cuts,
// so import name matching and prop grading never run on a weeks-old roster.
// Each league is skipped outside its season window, and runs independently -
// see server/data/refresh-rosters.ts and server/data/roster-load.ts for the
// guards. Logs one summary line per league.
//
// Unlike the older cron routes, this one fails closed: with CRON_SECRET unset
// every request is rejected.
export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return runCronLogged("refresh-rosters", run);
}

// The run itself, logged to cron_runs (start, end, status, rows touched) by
// runCronLogged - only after the auth check above passes.
async function run(): Promise<Response> {
  const start = Date.now();
  const outcomes = await refreshRosters({
    leagues: ROSTER_LEAGUE_ORDER.map((league) => ROSTER_LEAGUES[league]),
    tableFor: rosterTableFor,
  });
  for (const o of outcomes) console.log(rosterRefreshSummary(o));

  // Every league whose load committed drops its cached roster (and NFL its
  // bulk-import name list), so the next grade or import reads the fresh table.
  for (const tag of rosterCacheTagsToRevalidate(outcomes)) revalidateTag(tag);

  return Response.json({
    ms: Date.now() - start,
    leagues: outcomes.map((o) => ({
      league: o.league,
      status: o.status,
      ...("rowsWritten" in o ? { rowsWritten: o.rowsWritten } : {}),
      ...(o.status === "failed" ? { error: o.error } : {}),
      ...(o.status === "aborted" && o.result.status === "aborted" ? { reason: o.result.reason } : {}),
    })),
  });
}
