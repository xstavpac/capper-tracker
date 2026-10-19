import { CRON_GRACE_MINUTES, CRON_TIMEOUT_GRACE_SECONDS } from "@/lib/admin-thresholds";
import type { AdminReport } from "@/lib/admin-report";

// Pure half of the ops console's Crons tab: which crons exist and when they
// are due (mirrors vercel.json - cron-runs-acceptance-test.ts pins that), how a
// finished run's HTTP response becomes a cron_runs row (status, rows
// touched, a small summary), and whether a cron is failing or overdue.

export type CronName = "grade-picks" | "refresh-scores" | "refresh-odds" | "backfill-odds" | "nhl-goal-scorer-odds" | "refresh-rosters";

export type CronJob = {
  name: CronName;
  path: string;
  schedule: string; // vercel.json, UTC
  // The route's maxDuration (Vercel's 300 s ceiling where the route sets none).
  maxDurationSec: number;
  what: string;
};

export const CRON_JOBS: CronJob[] = [
  { name: "grade-picks", path: "/api/cron/grade-picks", schedule: "*/15 * * * *", maxDurationSec: 60, what: "final scores + grade pending picks and legs" },
  { name: "refresh-scores", path: "/api/cron/refresh-scores", schedule: "55 6 * * *", maxDurationSec: 300, what: "final scores, tendencies, stat/record/situational snapshots, decay-delta" },
  { name: "refresh-odds", path: "/api/cron/refresh-odds", schedule: "5 5 * * *", maxDurationSec: 300, what: "seed today's odds snapshots, NFL props, NHL goal scorer" },
  { name: "backfill-odds", path: "/api/cron/backfill-odds", schedule: "0 */4 * * *", maxDurationSec: 300, what: "add games missing from today's snapshots" },
  { name: "nhl-goal-scorer-odds", path: "/api/cron/nhl-goal-scorer-odds", schedule: "30 16 * * *", maxDurationSec: 300, what: "second pass for NHL goal scorer / 3-way markets" },
  { name: "refresh-rosters", path: "/api/cron/refresh-rosters", schedule: "45 10 * * *", maxDurationSec: 60, what: "NFL / NHL / NBA / MLB roster tables" },
];

// ---------------------------------------------------------------------------
// Schedules: the subset of cron syntax vercel.json uses - minute and hour as
// a number, "*" or "*/n"; day, month and weekday must be "*".
// ---------------------------------------------------------------------------

type Field = { kind: "any" } | { kind: "every"; n: number } | { kind: "at"; v: number };

function parseField(f: string): Field {
  if (f === "*") return { kind: "any" };
  const every = /^\*\/(\d+)$/.exec(f);
  if (every) return { kind: "every", n: Number(every[1]) };
  if (/^\d+$/.test(f)) return { kind: "at", v: Number(f) };
  throw new Error(`unsupported cron field "${f}"`);
}

function parseSchedule(schedule: string): { minute: Field; hour: Field } {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5 || parts.slice(2).some((p) => p !== "*")) throw new Error(`unsupported cron schedule "${schedule}"`);
  return { minute: parseField(parts[0]), hour: parseField(parts[1]) };
}

const fieldMatches = (f: Field, v: number) => f.kind === "any" || (f.kind === "every" ? v % f.n === 0 : v === f.v);

// The most recent scheduled fire time at or before `at` (UTC, whole minutes).
export function previousFireTime(schedule: string, at: Date): Date {
  const { minute, hour } = parseSchedule(schedule);
  const t = new Date(at);
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 2 * 24 * 60; i++) {
    if (fieldMatches(minute, t.getUTCMinutes()) && fieldMatches(hour, t.getUTCHours())) return t;
    t.setUTCMinutes(t.getUTCMinutes() - 1);
  }
  throw new Error(`no fire time for "${schedule}" in the last 2 days`);
}

// "every 15 min" / "every 4h at :00" / "daily 06:55 UTC"
export function describeSchedule(schedule: string): string {
  const { minute, hour } = parseSchedule(schedule);
  const mm = (v: number) => String(v).padStart(2, "0");
  if (minute.kind === "every" && hour.kind === "any") return `every ${minute.n} min`;
  if (minute.kind === "at" && hour.kind === "every") return `every ${hour.n}h at :${mm(minute.v)}`;
  if (minute.kind === "at" && hour.kind === "at") return `daily ${mm(hour.v)}:${mm(minute.v)} UTC`;
  return schedule;
}

// ---------------------------------------------------------------------------
// A finished run -> its cron_runs row
// ---------------------------------------------------------------------------

export type CronRunStatus = "RUNNING" | "OK" | "WARNING" | "ERROR";
export type CronRunOutcome = { status: Exclude<CronRunStatus, "RUNNING">; rowsTouched: number | null; summary: Record<string, number | string> | null };

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const sum = (xs: any[] | undefined, f: (x: any) => number) => (Array.isArray(xs) ? xs.reduce((a, x) => a + f(x), 0) : 0);

// Per route: rows written / graded, plus the few counts worth seeing at a
// glance. Read off the route's own JSON response, so the routes compute
// nothing extra for this.
const SUMMARIZE: Record<CronName, (b: any) => { rowsTouched: number; summary: Record<string, number | string> }> = {
  "grade-picks": (b) => {
    const r = b.results ?? [];
    const summary = {
      finalsPersisted: sum(r, (x) => num(x.persisted)),
      graded: sum(r, (x) => num(x.grading?.graded)),
      notMatched: sum(r, (x) => num(x.grading?.notMatched)),
      remaining: sum(r, (x) => num(x.grading?.remaining)),
      fuzzyUpgraded: sum(r, (x) => num(x.regrading?.upgraded)),
      legsGraded: sum(r, (x) => num(x.legGrading?.graded)),
      legsUpgraded: sum(r, (x) => num(x.legRegrading?.upgraded)),
    };
    return { rowsTouched: summary.finalsPersisted + summary.graded + summary.fuzzyUpgraded + summary.legsGraded + summary.legsUpgraded, summary };
  },
  "refresh-scores": (b) => {
    const r = b.results ?? [];
    const summary = {
      finalsPersisted: sum(r, (x) => num(x.persisted)),
      tendenciesUpdated: sum(r, (x) => num(x.tendencies?.teamsUpdated)),
      tendencySnapshots: sum(r, (x) => num(x.tendencySnapshots)),
      teamStatSnapshots: num(b.statSnapshots?.teamSnapshots),
      pitcherSnapshots: num(b.statSnapshots?.pitcherSnapshots),
      nflTeamSnapshots: num(b.nflTeamSnapshots?.rowsWritten),
      nflTeamSnapshotErrors: num(b.nflTeamSnapshots?.errors),
      nflRecordSnapshots: num(b.nflRecordSnapshots),
      nflSituationalSnapshots: num(b.nflSituationalSnapshots),
      decayDeltaPersisted: num(b.decayDeltaPredictions?.graded?.newlyPersisted) + num(b.decayDeltaPredictions?.pregame?.newlyPersisted),
    };
    const { nflTeamSnapshotErrors: _e, ...written } = summary;
    return { rowsTouched: Object.values(written).reduce((a, v) => a + v, 0), summary };
  },
  "refresh-odds": (b) => {
    const r = b.results ?? [];
    const failed = r.filter((x: any) => x.status === "fetch_failed" || x.status === "no_api_key").map((x: any) => x.sport);
    const summary: Record<string, number | string> = {
      sportsSeeded: r.filter((x: any) => x.status === "seeded").length,
      games: sum(r, (x) => num(x.games)),
      nflPropEvents: num(b.nflProps?.eventsFetched),
      nhlGoalScorerEvents: num(b.nhlGoalScorer?.eventsFetched),
    };
    if (failed.length) summary.failed = failed.join(",");
    if (typeof b.creditsRemaining === "number") summary.creditsRemaining = b.creditsRemaining;
    return { rowsTouched: num(summary.sportsSeeded) + num(summary.nflPropEvents) + num(summary.nhlGoalScorerEvents), summary };
  },
  "backfill-odds": (b) => {
    const r = b.results ?? [];
    const failed = r.filter((x: any) => x.status === "fetch_failed" || x.status === "no_api_key").map((x: any) => x.sport);
    const missingSeed = r.filter((x: any) => x.status === "no_base_row").map((x: any) => x.sport);
    const summary: Record<string, number | string> = { gamesAdded: sum(r, (x) => num(x.added)) };
    if (failed.length) summary.failed = failed.join(",");
    if (missingSeed.length) summary.missingSeed = missingSeed.join(",");
    return { rowsTouched: num(summary.gamesAdded), summary };
  },
  "nhl-goal-scorer-odds": (b) => {
    const summary: Record<string, number | string> = {
      eventsFetched: num(b.eventsFetched),
      eventsSkippedCreditGate: num(b.eventsSkippedCreditGate),
      eventsFailed: num(b.eventsFailed),
    };
    if (typeof b.status === "string") summary.result = b.status;
    return { rowsTouched: num(b.eventsFetched), summary };
  },
  "refresh-rosters": (b) => {
    const l = b.leagues ?? [];
    const failed = l.filter((x: any) => x.status === "failed" || x.status === "aborted").map((x: any) => x.league);
    const summary: Record<string, number | string> = {
      leaguesCommitted: l.filter((x: any) => x.status === "committed").length,
      rowsWritten: sum(l, (x) => num(x.rowsWritten)),
    };
    if (failed.length) summary.failedOrAborted = failed.join(",");
    return { rowsTouched: num(summary.rowsWritten), summary };
  },
};

// HTTP 5xx is ERROR. A 2xx whose body says ok:false (refresh-odds' "every
// sport empty", backfill's missing seed) is WARNING - or ERROR when the body's
// own status says "error". refresh-rosters reports per league instead of an
// ok flag: a failed or aborted league is a WARNING.
export function outcomeFromResponse(name: CronName, httpStatus: number, body: unknown): CronRunOutcome {
  const b = (body && typeof body === "object" ? body : {}) as any;
  let rowsTouched: number | null = null;
  let summary: Record<string, number | string> | null = null;
  try {
    ({ rowsTouched, summary } = SUMMARIZE[name](b));
  } catch {
    // A body we can't read still gets a status.
  }
  let status: CronRunOutcome["status"] = "OK";
  if (httpStatus >= 500 || b.status === "error") status = "ERROR";
  else if (httpStatus >= 400 || b.ok === false || (summary && "failedOrAborted" in summary)) status = "WARNING";
  return { status, rowsTouched, summary };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Health: failed / timed out / overdue
// ---------------------------------------------------------------------------

export type CronRunRow = {
  name: string;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  status: CronRunStatus;
  httpStatus: number | null;
  rowsTouched: number | null;
  summary: Record<string, number | string> | null;
  error: string | null;
};

export type CronHealth = {
  job: CronJob;
  latest: CronRunRow | null;
  // What's wrong, if anything (null = healthy or nothing logged yet).
  problem: string | null;
  expectedAt: Date; // the latest fire time past its grace
};

const ago = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 90 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

// A RUNNING row older than maxDuration + grace never finished: the function
// was killed (timeout) or crashed before its update.
export function isTimedOut(job: CronJob, run: CronRunRow, now: Date): boolean {
  return run.status === "RUNNING" && now.getTime() - run.startedAt.getTime() > (job.maxDurationSec + CRON_TIMEOUT_GRACE_SECONDS) * 1000;
}

// `latest` is the newest run of the job. Overdue = the latest fire time that
// is already past its grace has no run started at or after it (1 min early
// counts - Vercel fires within the minute). A job with no runs logged at all
// isn't called overdue: logging starts with this deploy.
export function cronHealth(job: CronJob, latest: CronRunRow | null, now: Date): CronHealth {
  const grace = CRON_GRACE_MINUTES[job.name];
  const expectedAt = previousFireTime(job.schedule, new Date(now.getTime() - grace * 60000));
  let problem: string | null = null;
  if (latest) {
    if (isTimedOut(job, latest, now)) {
      problem = `${job.name}: run started ${ago(now.getTime() - latest.startedAt.getTime())} ago never finished (timed out or crashed)`;
    } else if (latest.status === "ERROR") {
      problem = `${job.name}: last run failed${latest.httpStatus ? ` (HTTP ${latest.httpStatus})` : ""}${latest.error ? `: ${latest.error.slice(0, 80)}` : ""}`;
    } else if (latest.startedAt.getTime() < expectedAt.getTime() - 60000) {
      problem = `${job.name}: overdue - no run since ${ago(now.getTime() - latest.startedAt.getTime())} ago (due ${expectedAt.toISOString().slice(11, 16)} UTC)`;
    }
  }
  return { job, latest, problem, expectedAt };
}

export function formatAgo(ms: number): string {
  return ago(ms);
}

// "Copy for Claude" for the Crons tab.
export function cronsReport(health: CronHealth[], recent: CronRunRow[], now: Date): AdminReport {
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const runLine = (r: CronRunRow) =>
    `${fmt(r.startedAt)} ${r.status}${r.httpStatus ? ` HTTP ${r.httpStatus}` : ""}${r.durationMs !== null ? `, ${Math.round(r.durationMs / 100) / 10}s` : ""}${r.rowsTouched !== null ? `, ${r.rowsTouched} rows` : ""}${r.error ? `, error: ${r.error}` : ""}`;
  return {
    title: "Crons report - cron_runs (one row per authorized run)",
    header: [`As of ${fmt(now)}. ${health.filter((h) => h.problem).length} of ${health.length} crons flagged (failed, timed out or overdue).`],
    sections: [
      {
        heading: "Crons",
        items: health.map((h) => ({
          title: `${h.job.name} - ${describeSchedule(h.job.schedule)} - ${h.job.what}`,
          flags: h.problem ? [h.problem] : [],
          lines: h.latest
            ? [
                `last run: ${runLine(h.latest)} (${ago(now.getTime() - h.latest.startedAt.getTime())} ago)`,
                ...(h.latest.summary ? [`summary: ${Object.entries(h.latest.summary).map(([k, v]) => `${k}=${v}`).join(", ")}`] : []),
                `recent: ${recent.filter((r) => r.name === h.job.name).map((r) => r.status).join(" ") || "-"}`,
              ]
            : ["no runs logged yet"],
        })),
      },
    ],
  };
}

// The Crons tab's red dot.
export function cronsAlert(health: CronHealth[]): string | null {
  const bad = health.filter((h) => h.problem);
  if (bad.length === 0) return null;
  return bad.length === 1 ? bad[0].problem : `${bad.length} crons need attention; ${bad[0].problem}`;
}
