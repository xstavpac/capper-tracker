// Persists the Odds API usage headers (x-requests-remaining / -used) that
// readOddsApiCredits (odds.ts) already parses on every real HTTP call - they
// were logged (console.warn under a low watermark) but never written
// anywhere durable, so "how close are we to the monthly cap" only ever
// existed transiently in log lines. Locked budget is 20,000 credits/month
// (docs/odds-expansion-reconciled-plan.md §1); this deliberately does NOT
// hardcode that number - `total` below is derived from the API's own
// used+remaining on each call, so this keeps working correctly if the plan
// ever changes without a code edit.
//
// Three escalating thresholds (whitepaper §31, applied here):
//   - 70%: log-level escalation only (still "warn", matches the existing
//     low-watermark pattern's severity, just an earlier trigger).
//   - 85%: a louder alert (console.error) - action should be taken soon,
//     but nothing is blocked yet.
//   - 95%: STOP_LOWER_PRIORITY - the actual behavioral gate. NFL
//     event-level player-prop odds (nfl-prop-odds.ts) are the "lower-
//     priority" market this protects: getLatestCreditUsageLevel is checked
//     BEFORE every prop fetch, and the whole props step is skipped once
//     usage crosses this line. The core game-lines bulk fetch (h2h/spreads/
//     totals) is never gated by this - it's the higher-priority market and
//     keeps running regardless, same as before this file existed.
import { prisma } from "@/lib/prisma";
import { easternDateKey, easternDayStart } from "@/lib/dates";
import type { OddsApiCredits } from "@/server/data/odds";

export const CREDIT_WARN_THRESHOLD = 0.7;
export const CREDIT_ALERT_THRESHOLD = 0.85;
export const CREDIT_STOP_LOWER_PRIORITY_THRESHOLD = 0.95;

export type CreditUsageLevel = "ok" | "warn" | "alert" | "stop_lower_priority";

// null when either header was missing (a network-level failure never even
// reached the API, or a provider response omitted them) - callers treat
// unknown the same as "ok" (fail OPEN, not closed: a missing signal must
// never itself block the higher-priority game-lines fetch, and for the
// lower-priority props gate, getLatestCreditUsageLevel below falls back to
// the last KNOWN row rather than trusting a single missing reading).
export function creditUsagePct(credits: OddsApiCredits): number | null {
  if (credits.used === null || credits.remaining === null) return null;
  const total = credits.used + credits.remaining;
  if (total <= 0) return null;
  return credits.used / total;
}

export function classifyCreditUsage(pct: number | null): CreditUsageLevel {
  if (pct === null) return "ok";
  if (pct >= CREDIT_STOP_LOWER_PRIORITY_THRESHOLD) return "stop_lower_priority";
  if (pct >= CREDIT_ALERT_THRESHOLD) return "alert";
  if (pct >= CREDIT_WARN_THRESHOLD) return "warn";
  return "ok";
}

// Writes one row per real Odds API HTTP call. requestsToday/requestsMonth
// are computed by counting this table's own prior rows for the Eastern day/
// month (not a separately-maintained running counter, so they can never
// drift out of sync with the rows actually present) - not transactional
// with the insert (two concurrent callers could double-count by one), but
// this only ever runs from low-concurrency cron paths, same tradeoff every
// other count-then-write in this codebase already makes at this volume.
export async function persistOddsApiUsage(input: {
  sportKey: string;
  marketsRequested: string[];
  eventsRequested: number;
  credits: OddsApiCredits;
  pollTimestamp?: Date;
}): Promise<{ pctUsed: number | null; level: CreditUsageLevel }> {
  const now = input.pollTimestamp ?? new Date();
  const todayKey = easternDateKey(now);
  const monthStartKey = todayKey.slice(0, 7) + "-01";
  const todayStart = easternDayStart(todayKey);
  const monthStart = easternDayStart(monthStartKey);

  const [todayCountBefore, monthCountBefore] = await Promise.all([
    prisma.oddsApiUsageLog.count({ where: { pollTimestamp: { gte: todayStart } } }),
    prisma.oddsApiUsageLog.count({ where: { pollTimestamp: { gte: monthStart } } }),
  ]);

  const pctUsed = creditUsagePct(input.credits);
  const level = classifyCreditUsage(pctUsed);

  await prisma.oddsApiUsageLog.create({
    data: {
      sportKey: input.sportKey,
      pollTimestamp: now,
      creditsUsed: input.credits.used,
      creditsRemaining: input.credits.remaining,
      requestsToday: todayCountBefore + 1,
      requestsMonth: monthCountBefore + 1,
      marketsRequested: input.marketsRequested.join(","),
      eventsRequested: input.eventsRequested,
    },
  });

  const line = JSON.stringify({
    sportKey: input.sportKey,
    pctUsed: pctUsed === null ? null : Math.round(pctUsed * 1000) / 1000,
    creditsUsed: input.credits.used,
    creditsRemaining: input.credits.remaining,
    marketsRequested: input.marketsRequested,
    eventsRequested: input.eventsRequested,
  });
  if (level === "stop_lower_priority") console.error("[odds-api-usage] credits STOP_LOWER_PRIORITY (>=95%)", line);
  else if (level === "alert") console.error("[odds-api-usage] credits ALERT (>=85%)", line);
  else if (level === "warn") console.warn("[odds-api-usage] credits WARN (>=70%)", line);
  else console.log("[odds-api-usage] credits ok", line);

  return { pctUsed, level };
}

// Checked BEFORE spending credits on a lower-priority fetch (NFL prop
// odds), so a batch of several events in one cron run stops as soon as the
// most recently observed usage crosses 95%, without needing to make one
// more call first just to find out. Credits are account-wide (shared
// across every sport hitting this API key), so the most recent row from
// ANY sport is the right signal here, not just NFL's own rows.
export async function getLatestCreditUsageLevel(): Promise<CreditUsageLevel> {
  const latest = await prisma.oddsApiUsageLog.findFirst({ orderBy: { pollTimestamp: "desc" } });
  if (!latest) return "ok";
  return classifyCreditUsage(creditUsagePct({ used: latest.creditsUsed, remaining: latest.creditsRemaining, lastCost: null }));
}
