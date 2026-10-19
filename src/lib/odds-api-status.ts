import { ODDS_CREDITS_ALERT_PCT, ODDS_CREDITS_LOW_REMAINING, ODDS_SNAPSHOT_SEED_GRACE_HOURS } from "@/lib/admin-thresholds";
import { CRON_JOBS, previousFireTime, formatAgo } from "@/lib/cron-runs";
import { easternDateKey, easternDayStart } from "@/lib/dates";
import { isSportInSeason } from "@/lib/sport-seasons";
import type { AdminReport } from "@/lib/admin-report";

// Pure half of the ops console's Odds API tab: credits left (the Odds API's
// own x-requests-remaining / x-requests-used, as stored per call in
// odds_api_usage_log), calls today by sport, and each sport's latest odds
// snapshot - plus the red-dot rule. Reads: server/data/odds-api-status.ts.

export type LatestUsage = {
  sportKey: string;
  pollTimestamp: Date;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  httpStatus: number | null;
  caller: string | null;
};

// Today's calls (ET day), one row per sportKey x caller x HTTP status.
export type CallsToday = { sportKey: string; caller: string | null; httpStatus: number | null; calls: number };

// The newest snapshot row per sport (fetchDate is the ET date it covers;
// createdAt is when that day's row was first written - the seed).
export type LatestSnapshot = { sportKey: string; fetchDate: string; createdAt: Date };

// One per sport the app fetches odds for; fetchDate/createdAt/ageMs null when
// the sport has no snapshot rows at all.
export type SnapshotHealth = { sportKey: string; fetchDate: string | null; createdAt: Date | null; ageMs: number | null; inSeason: boolean; stale: boolean };

export function creditPct(u: Pick<LatestUsage, "creditsUsed" | "creditsRemaining"> | null): number | null {
  if (!u || u.creditsUsed === null || u.creditsRemaining === null) return null;
  const total = u.creditsUsed + u.creditsRemaining;
  return total > 0 ? u.creditsUsed / total : null;
}

export function creditsProblem(latest: LatestUsage | null): string | null {
  if (!latest) return null;
  const pct = creditPct(latest);
  const left = latest.creditsRemaining;
  if (pct !== null && pct >= ODDS_CREDITS_ALERT_PCT) return `Odds API credits ${Math.round(pct * 100)}% used (${left ?? "?"} left)`;
  if (left !== null && left < ODDS_CREDITS_LOW_REMAINING) return `Odds API credits low: ${left} left`;
  return null;
}

const SEED_SCHEDULE = CRON_JOBS.find((j) => j.name === "refresh-odds")!.schedule;

// When today's (ET) seed should have landed by: today's refresh-odds fire time
// plus the grace. null while today's seed hasn't fired yet (just after ET
// midnight), when yesterday's row is still the right one.
export function seedDueAt(now: Date): Date | null {
  const fire = previousFireTime(SEED_SCHEDULE, now);
  if (fire.getTime() < easternDayStart(easternDateKey(now)).getTime()) return null;
  return new Date(fire.getTime() + ODDS_SNAPSHOT_SEED_GRACE_HOURS * 3600000);
}

// `sportKeys`: the sports the app fetches odds for (LIVE_SPORTS keys).
export function snapshotHealth(sportKeys: string[], latest: LatestSnapshot[], now: Date): SnapshotHealth[] {
  const today = easternDateKey(now);
  const due = seedDueAt(now);
  return sportKeys.map((sportKey) => {
    const inSeason = isSportInSeason(sportKey, now);
    const row = latest.find((s) => s.sportKey === sportKey);
    const pastDue = due !== null && now.getTime() >= due.getTime();
    const stale = inSeason && pastDue && (!row || row.fetchDate !== today);
    return {
      sportKey,
      fetchDate: row?.fetchDate ?? null,
      createdAt: row?.createdAt ?? null,
      ageMs: row ? now.getTime() - row.createdAt.getTime() : null,
      inSeason,
      stale,
    };
  });
}

export function staleProblem(health: SnapshotHealth[], now: Date): string | null {
  const stale = health.filter((h) => h.stale);
  if (stale.length === 0) return null;
  const today = easternDateKey(now);
  return `${stale.map((h) => h.sportKey).join(", ")}: no odds snapshot for ${today} (seed due ${seedDueAt(now)?.toISOString().slice(11, 16)} UTC)`;
}

// The Odds API tab's red dot: low credits, or a stale snapshot.
export function oddsApiAlert(latest: LatestUsage | null, health: SnapshotHealth[], now: Date): string | null {
  const parts = [creditsProblem(latest), staleProblem(health, now)].filter((p): p is string => !!p);
  return parts.length ? parts.join("; ") : null;
}

export type OddsApiView = {
  now: Date;
  latest: LatestUsage | null;
  callsToday: CallsToday[];
  callsMonth: number;
  snapshots: SnapshotHealth[];
};

// "Copy for Claude" for the Odds API tab.
export function oddsApiReport(v: OddsApiView): AdminReport {
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const pct = creditPct(v.latest);
  const credits = creditsProblem(v.latest);
  const bySport = new Map<string, CallsToday[]>();
  for (const c of v.callsToday) bySport.set(c.sportKey, [...(bySport.get(c.sportKey) ?? []), c]);
  return {
    title: "Odds API report - odds_api_usage_log + odds_snapshots",
    header: [
      `As of ${fmt(v.now)} (ET day ${easternDateKey(v.now)}).`,
      v.latest
        ? `Credits (x-requests-used / x-requests-remaining on the latest call, ${fmt(v.latest.pollTimestamp)}): used ${v.latest.creditsUsed ?? "?"}, remaining ${v.latest.creditsRemaining ?? "?"}${pct !== null ? ` (${Math.round(pct * 100)}% used)` : ""}.`
        : "No Odds API calls logged yet.",
      `Calls today: ${v.callsToday.reduce((a, c) => a + c.calls, 0)}. Calls this month: ${v.callsMonth}.`,
      ...(credits ? [`[FLAG] ${credits}`] : []),
    ],
    sections: [
      {
        heading: "Calls today by sport",
        empty: "none",
        items: [...bySport.entries()].map(([sport, rows]) => ({
          title: `${sport} - ${rows.reduce((a, c) => a + c.calls, 0)} calls`,
          flags: rows.filter((r) => r.httpStatus !== null && r.httpStatus >= 400).map((r) => `${r.calls} x HTTP ${r.httpStatus} (${r.caller ?? "caller not recorded"})`),
          lines: rows.map((r) => `${r.caller ?? "caller not recorded"}, HTTP ${r.httpStatus ?? "not recorded"}: ${r.calls}`),
        })),
      },
      {
        heading: "Latest odds snapshot per sport",
        items: v.snapshots.map((s) => ({
          title: `${s.sportKey}${s.inSeason ? "" : " (off season)"}`,
          flags: s.stale ? [`no snapshot for ${easternDateKey(v.now)}`] : [],
          lines: s.createdAt && s.ageMs !== null ? [`fetchDate ${s.fetchDate}, seeded ${fmt(s.createdAt)} (${formatAgo(s.ageMs)} ago)`] : ["no snapshot rows"],
        })),
      },
    ],
  };
}
