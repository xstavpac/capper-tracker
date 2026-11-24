// Pure half of the ops console's Feed health tab: per league, is the stored
// schedule healthy, finished for the year, or suspiciously empty? Everything
// here is derived from our own stored games and sync records - there is no
// season calendar in this file on purpose. (The feeds themselves still have
// season gates - lib/sport-seasons.ts - and a wrong gate makes a league read
// Off season here, since nothing gets stored; that blind spot is noted in the
// PR, it can't be seen from data we never fetch.)
//
// Inputs, per league (server/data/feed-health.ts reads them in one statement):
//   - played games: game_results finals (the score feeds - ESPN / MLB / NHL),
//     preseason rows excluded. NCAAB stores only finals that had picks
//     (final-pick-gate.ts), so its counts are "games with picks".
//   - posted games: for the daily leagues (NBA, NCAAB, NHL, MLB, WNBA) the
//     7-day schedule store (schedule_days, ESPN / MLB Stats API, today..today+6
//     ET) whenever it holds a row from today on; otherwise, and always for NFL /
//     NCAAF, the newest odds snapshot (The Odds API) no older than yesterday ET,
//     whose horizon is whatever the Odds API lists (about a week for football,
//     only about the current day for the daily leagues).
//   - feed_syncs: last success / last error per (feed, league).

import type { AdminReport } from "@/lib/admin-report";

export const FEED_HEALTH_LEAGUES = [
  { key: "americanfootball_nfl", label: "NFL" },
  { key: "americanfootball_ncaaf", label: "NCAAF" },
  { key: "basketball_nba", label: "NBA" },
  { key: "basketball_ncaab", label: "NCAAB" },
  { key: "icehockey_nhl", label: "NHL" },
  { key: "baseball_mlb", label: "MLB" },
  { key: "basketball_wnba", label: "WNBA" },
] as const;

export type FeedName = "scores" | "odds" | "schedule";
export const FEED_NAMES: FeedName[] = ["scores", "odds", "schedule"];
export const FEED_LABEL: Record<FeedName, string> = {
  scores: "Scores (ESPN / MLB / NHL)",
  odds: "Schedule + odds (The Odds API)",
  schedule: "7-day schedule (ESPN / MLB Stats API)",
};

// Leagues whose "posted" side reads the 7-day schedule store (see the header).
// Football keeps the odds snapshot, which already lists about a week ahead.
export const SCHEDULE_POSTED_LEAGUES: ReadonlySet<string> = new Set([
  "basketball_nba",
  "basketball_ncaab",
  "icehockey_nhl",
  "baseball_mlb",
  "basketball_wnba",
]);

const DAY = 86_400_000;
const HOUR = 3_600_000;

// "In season" = a played game in the last IN_SEASON_DAYS or a posted game in
// the next IN_SEASON_DAYS. "Off season" (spec) = nothing either side for
// OFF_SEASON_DAYS. The band in between - a season that ended 8-14 days ago -
// also reads Off season: see leagueFeedStatus.
export const IN_SEASON_DAYS = 7;
export const OFF_SEASON_DAYS = 14;
// "Had games recently" is counted over this many days back.
export const RECENT_DAYS = 14;

// ⚠ Check feed (a): the league had at least `minRecent` played games in the
// last RECENT_DAYS, yet there's no played game in the last `quietPastDays`
// and no posted game in the next `quietFutureDays`.
//
// Why these numbers (backtested on prod game_results, 2026-06 .. 2026-11, see
// feed-health-acceptance-test.ts):
// - quietPastDays sits above the league's longest normal mid-season gap. For
//   daily leagues the posted side only reaches the end of today, so the past
//   window alone has to cover the whole gap: NBA All-Star break ~7 days (Thu
//   -> Thu), MLB All-Star break 6 (2026: Jul 10 -> Jul 16), NHL All-Star /
//   Christmas breaks <= 6, WNBA All-Star break ~4, NCAAB Christmas <= 3.
//   Football's posted side lists ~a week ahead, which covers its weekly gaps
//   (NFL Week 18 -> Wild Card is 6 days; NCAAF conference championships ->
//   Army-Navy) - quietFutureDays 7 there.
//   Re-checked 2026-11-25 when the daily leagues' posted side moved from the
//   odds snapshot (today only) to the 7-day schedule store: unchanged. The new
//   source only ever adds posted games, so (a) can fire only where it already
//   did; with the week of lookahead a mid-season break now also clears (a) from
//   the future side, and the backtest (feed-health-acceptance-test.ts, run with
//   the 7-day posted horizon) still shows no warning on any real or modelled
//   break and every outage caught within quietPastDays + 1. quietPastDays could
//   now be lowered for the daily leagues (faster outage warnings); not done
//   here, it needs its own backtest against a store that has some history.
// - minRecent sits above the league's playoff tail, so the natural end of a
//   season never trips (a): after the last final, the last 14 days hold only
//   a handful of playoff games. NFL: Super Bowl + conf champ + divisional = 7
//   (< 10), which also covers the two-week pre-Super Bowl gap. NBA / NHL:
//   finals + late conference finals <= ~10 (< 15 / 20). MLB 2026: 6 games in
//   the 14 days after the World Series (< 30). NCAAF: CFP semis + title +
//   late bowls ~20 (< 40), which covers the semis -> title gap. NCAAB:
//   Elite 8 + Final Four + title + NIT ~10 (< 20). WNBA 2026: 8 (< 15).
//   And minRecent stays well under what a real outage leaves in the window
//   ((14 - quietPastDays) days of regular-season games), so an outage does
//   trip it - checked in the test for every league.
export type FeedThresholds = { quietPastDays: number; quietFutureDays: number; minRecent: number };

export const FEED_THRESHOLDS: Record<string, FeedThresholds> = {
  americanfootball_nfl: { quietPastDays: 5, quietFutureDays: 7, minRecent: 10 },
  americanfootball_ncaaf: { quietPastDays: 4, quietFutureDays: 7, minRecent: 40 },
  basketball_nba: { quietPastDays: 8, quietFutureDays: 4, minRecent: 15 },
  basketball_ncaab: { quietPastDays: 6, quietFutureDays: 4, minRecent: 20 },
  icehockey_nhl: { quietPastDays: 7, quietFutureDays: 4, minRecent: 20 },
  baseball_mlb: { quietPastDays: 7, quietFutureDays: 4, minRecent: 30 },
  basketball_wnba: { quietPastDays: 6, quietFutureDays: 4, minRecent: 15 },
};

// ⚠ Check feed (b): while in season, a feed's last success is older than this.
// Scores sync every 15 min (grade-picks) plus daily (refresh-scores): 6 h is
// 24 missed runs. Odds seed once a day (refresh-odds 05:05 UTC) plus the
// 4-hourly backfill: 26 h is a missed daily seed plus its grace.
// The schedule store is pulled once a day (refresh-scores 06:55 UTC): the same
// 26 h as the odds seed.
export const SYNC_STALE_HOURS: Record<FeedName, number> = { scores: 6, odds: 26, schedule: 26 };

export type FeedSyncRow = { feed: FeedName; sportKey: string; lastSuccessAt: Date | null; lastErrorAt: Date | null; lastError: string | null };

export type LeagueFeedData = {
  sportKey: string;
  past7: number; // played, last 7 days
  past14: number; // played, last 14 days
  lastGameAt: Date | null; // newest played game in the last 14 days
  next7: number; // posted, next 7 days
  nextGameAt: Date | null; // earliest posted game after now
  postedFetchDate: string | null; // the odds snapshot the posted counts came from (null = none from today/yesterday, or the schedule store was used)
  postedSource: "schedule" | "odds" | null; // where next7 / nextGameAt came from (null = no posted data at all)
  syncs: Partial<Record<FeedName, FeedSyncRow>>;
};

export type FeedStatus = "in_season" | "off_season" | "check_feed";

export type LeagueFeedHealth = LeagueFeedData & {
  label: string;
  status: FeedStatus;
  reasons: string[]; // why ⚠ Check feed (empty otherwise)
  note: string | null; // one line under the status (e.g. "season ended 9 days ago")
  thresholds: FeedThresholds;
};

const days = (ms: number) => Math.floor(ms / DAY);
export function formatHoursAgo(ms: number): string {
  const h = ms / HOUR;
  return h < 1.5 ? `${Math.max(1, Math.round(ms / 60000))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
}

export function leagueFeedStatus(d: LeagueFeedData, now: Date): LeagueFeedHealth {
  const league = FEED_HEALTH_LEAGUES.find((l) => l.key === d.sportKey);
  const label = league?.label ?? d.sportKey;
  const t = FEED_THRESHOLDS[d.sportKey] ?? FEED_THRESHOLDS.basketball_nba;
  const n = now.getTime();

  const sincePlayed = d.lastGameAt ? n - d.lastGameAt.getTime() : Infinity;
  const untilPosted = d.nextGameAt ? d.nextGameAt.getTime() - n : Infinity;
  const inSeason = sincePlayed <= IN_SEASON_DAYS * DAY || untilPosted <= IN_SEASON_DAYS * DAY;

  const reasons: string[] = [];

  // (a) the schedule went quiet right after a busy stretch.
  const quiet = sincePlayed > t.quietPastDays * DAY && untilPosted > t.quietFutureDays * DAY;
  if (quiet && d.past14 >= t.minRecent) {
    reasons.push(
      `${d.past14} games in the last ${RECENT_DAYS} days, then none played in ${t.quietPastDays}+ days and none posted for the next ${t.quietFutureDays}` +
        (d.postedSource ? "" : " (no stored schedule and no odds snapshot from today or yesterday)")
    );
  }

  // (b) a feed stopped succeeding mid-season. A feed with no row yet isn't
  // judged (recording started with this deploy).
  if (inSeason) {
    for (const feed of FEED_NAMES) {
      const s = d.syncs[feed];
      if (!s?.lastSuccessAt) {
        if (s?.lastErrorAt) reasons.push(`${feed} sync has never succeeded since recording began; last error ${formatHoursAgo(n - s.lastErrorAt.getTime())} ago`);
        continue;
      }
      const age = n - s.lastSuccessAt.getTime();
      if (age > SYNC_STALE_HOURS[feed] * HOUR) {
        reasons.push(`${feed} sync last succeeded ${formatHoursAgo(age)} ago (limit ${SYNC_STALE_HOURS[feed]}h)`);
      }
    }
  }

  let status: FeedStatus;
  let note: string | null = null;
  if (reasons.length) status = "check_feed";
  else if (inSeason) status = "in_season";
  else {
    // Off season, including the season-end band: games 8-14 days ago, nothing
    // posted. (a) can't have fired there (minRecent sits above the playoff
    // tail), so the last final simply ages out: In season for 7 days, then
    // Off season. The spec's strict definition (nothing within 14 days either
    // side) is the steady state this settles into.
    status = "off_season";
    if (d.lastGameAt && sincePlayed <= OFF_SEASON_DAYS * DAY) note = `last game ${days(sincePlayed)} days ago, nothing posted - season wound down`;
    else if (d.nextGameAt && untilPosted <= OFF_SEASON_DAYS * DAY) note = `next game in ${days(untilPosted)} days`;
  }
  return { ...d, label, status, reasons, note, thresholds: t };
}

export function feedHealth(rows: LeagueFeedData[], now: Date): LeagueFeedHealth[] {
  return FEED_HEALTH_LEAGUES.map((l) => leagueFeedStatus(rows.find((r) => r.sportKey === l.key) ?? emptyLeague(l.key), now));
}

export function emptyLeague(sportKey: string): LeagueFeedData {
  return { sportKey, past7: 0, past14: 0, lastGameAt: null, next7: 0, nextGameAt: null, postedFetchDate: null, postedSource: null, syncs: {} };
}

// The Feed health tab's red dot and the header badge's count.
export function feedHealthAlert(health: LeagueFeedHealth[]): string | null {
  const bad = health.filter((h) => h.status === "check_feed");
  if (bad.length === 0) return null;
  return `${bad.map((h) => h.label).join(", ")}: check feed - ${bad[0].reasons[0]}`;
}

// Where a league's posted counts came from, for the report and the tab.
export function postedFrom(h: Pick<LeagueFeedData, "postedSource" | "postedFetchDate">): string {
  if (h.postedSource === "schedule") return "7-day schedule store";
  if (h.postedSource === "odds") return `odds snapshot ${h.postedFetchDate}`;
  return "no stored schedule, no odds snapshot from today/yesterday";
}

// "Copy for Claude" for the Feed health tab.
export const STATUS_LABEL: Record<FeedStatus, string> = { in_season: "In season", off_season: "Off season", check_feed: "⚠ Check feed" };

export function feedHealthReport(health: LeagueFeedHealth[], now: Date): AdminReport {
  const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-");
  const syncLine = (h: LeagueFeedHealth, feed: FeedName) => {
    const s = h.syncs[feed];
    if (!s) return `${feed} sync: not recorded`;
    return `${feed} sync: last success ${fmt(s.lastSuccessAt)}${s.lastErrorAt ? `, last error ${fmt(s.lastErrorAt)}: ${s.lastError ?? ""}` : ""}`;
  };
  return {
    title: "Feed health report - stored schedules per league (game_results + 7-day schedule store / latest odds snapshot + feed_syncs)",
    header: [`As of ${fmt(now)}. ${health.filter((h) => h.status === "check_feed").length} of ${health.length} leagues flagged.`],
    sections: [
      {
        heading: "Leagues",
        items: health.map((h) => ({
          title: `${h.label} - ${STATUS_LABEL[h.status]}`,
          flags: h.reasons,
          lines: [
            `played: ${h.past7} in the last 7 days, ${h.past14} in 14; last ${fmt(h.lastGameAt)}`,
            `posted: ${h.next7} in the next 7 days; next ${fmt(h.nextGameAt)} (${postedFrom(h)})`,
            syncLine(h, "scores"),
            syncLine(h, "odds"),
            syncLine(h, "schedule"),
            `thresholds: quiet ${h.thresholds.quietPastDays}d back / ${h.thresholds.quietFutureDays}d ahead after >= ${h.thresholds.minRecent} games in ${RECENT_DAYS}d`,
            ...(h.note ? [h.note] : []),
          ],
        })),
      },
    ],
  };
}
