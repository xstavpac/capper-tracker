import { GRADING_FUZZY_WINDOW_DAYS, GRADING_STUCK_AFTER_FINAL_HOURS, GRADING_STUCK_NO_RESULT_HOURS } from "@/lib/admin-thresholds";
import { formatAgo } from "@/lib/cron-runs";
import { shortId, type AdminReport } from "@/lib/admin-report";

// Pure half of the ops console's Grading tab: pending picks by sport, stuck
// pending (the game went final GRADING_STUCK_AFTER_FINAL_HOURS ago, or no
// final was found GRADING_STUCK_NO_RESULT_HOURS after it started, and the
// pick is still PENDING), the last recorded grading-failure reason, and the
// fuzzy-graded count. Reads: server/data/grading-health.ts.

export type PendingBySport = {
  sport: string;
  autoGraded: boolean; // a sport the grade-picks cron grades
  pending: number;
  inLookback: number; // retried by the cron
  pastLookback: number; // older than the regrade lookback: never retried
  stuck: number;
};

export type StuckPick = {
  id: string;
  sport: string;
  betType: string;
  period: string;
  betDetail: string | null;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  reason: string | null; // null: the grading pass hasn't recorded a miss for it yet
  finalSeenAt: Date | null;
  lastSeenAt: Date | null;
  attempts: number | null;
};

export type GradingView = {
  now: Date;
  lookbackDays: number;
  bySport: PendingBySport[];
  stuckTotal: number;
  stuck: StuckPick[]; // oldest first, capped
  fuzzyGraded: number; // within GRADING_FUZZY_WINDOW_DAYS
};

// Why a stuck pick counts as stuck: "final 5h ago" or "started 9h ago, no final found".
export function stuckSince(p: Pick<StuckPick, "finalSeenAt" | "gameTime">, now: Date): string {
  return p.finalSeenAt
    ? `final ${formatAgo(now.getTime() - p.finalSeenAt.getTime())} ago`
    : `started ${formatAgo(now.getTime() - p.gameTime.getTime())} ago, no final found`;
}

const describe = (p: StuckPick) => `${p.sport} ${p.betType}${p.period !== "FULL_GAME" ? ` ${p.period}` : ""} - ${p.betDetail ?? "(no bet text)"}`;

// The Grading tab's red dot: any stuck-pending pick.
export function gradingAlert(stuckTotal: number, oldest: StuckPick | null, now: Date): string | null {
  if (stuckTotal === 0) return null;
  const n = `${stuckTotal} stuck pending pick${stuckTotal === 1 ? "" : "s"}`;
  return oldest ? `${n}; oldest: ${describe(oldest)} (${stuckSince(oldest, now)})${oldest.reason ? ` - ${oldest.reason}` : ""}` : n;
}

// "Copy for Claude" for the Grading tab. Bet text is included; the pick id is
// shortened; no user ids.
export function gradingReport(v: GradingView): AdminReport {
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const pending = v.bySport.reduce((a, s) => a + s.pending, 0);
  return {
    title: "Grading report - pending picks, stuck pending, fuzzy-graded",
    header: [
      `As of ${fmt(v.now)}. Stuck = PENDING in an auto-graded sport within the ${v.lookbackDays}-day regrade lookback, and its game final ${GRADING_STUCK_AFTER_FINAL_HOURS}h+ ago (or no final found ${GRADING_STUCK_NO_RESULT_HOURS}h+ after it started).`,
      `Pending: ${pending}. Stuck: ${v.stuckTotal}. Fuzzy-graded in the last ${GRADING_FUZZY_WINDOW_DAYS} days: ${v.fuzzyGraded}.`,
    ],
    sections: [
      {
        heading: "Pending by sport",
        empty: "none",
        items: v.bySport.map((s) => ({
          title: `${s.sport} - ${s.pending} pending${s.autoGraded ? "" : " (not auto-graded)"}`,
          flags: s.stuck > 0 ? [`${s.stuck} stuck`] : [],
          lines: [`in lookback ${s.inLookback}, past lookback (never retried) ${s.pastLookback}`],
        })),
      },
      {
        heading: `Stuck pending (oldest first${v.stuckTotal > v.stuck.length ? `, first ${v.stuck.length} of ${v.stuckTotal}` : ""})`,
        empty: "none",
        items: v.stuck.map((p) => ({
          title: describe(p),
          flags: [stuckSince(p, v.now)],
          lines: [
            `pick ${shortId(p.id)}: ${p.awayTeam} @ ${p.homeTeam}, game ${fmt(p.gameTime)}`,
            p.reason
              ? `last grading failure: ${p.reason} (${p.attempts} attempt${p.attempts === 1 ? "" : "s"}, last ${p.lastSeenAt ? fmt(p.lastSeenAt) : "?"})`
              : "no grading failure recorded yet",
          ],
        })),
      },
    ],
  };
}
