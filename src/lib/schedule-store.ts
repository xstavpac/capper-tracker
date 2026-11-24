// Pure half of the 7-day schedule store (server/data/schedule-store.ts): which
// leagues and Eastern dates a daily pull covers, how one ESPN scoreboard date or
// one MLB Stats API range maps to compact stored games, and how a stored game
// reads back as a schedule-only feed game. No I/O here.
//
// Why a store at all: The Odds API lists only games whose lines are posted
// (about today for NBA / NHL / NCAAB / MLB, about a week for football), and the
// score feed covers only yesterday..tomorrow. A pick on a game 2-6 days out in a
// daily league had nothing to match, and Feed health's "next 7 days" for those
// leagues could only ever show tonight.

import { addDaysToDateKey, easternDateKey } from "@/lib/dates";
import { isSportInSeason } from "@/lib/sport-seasons";
import { espnFeedStatus, mlbFeedStatus, type FeedGameStatus } from "@/lib/feed-game-status";

// Today plus the next six Eastern dates.
export const SCHEDULE_DAYS = 7;

// One stored game. `gameNumber` / `doubleHeader` are MLB doubleheader legs only
// (the flag pickBestScheduleCandidate trusts); absent everywhere else.
export type StoredScheduleGame = {
  id: string;
  home: string;
  away: string;
  start: string; // ISO
  status: FeedGameStatus;
  gameNumber?: number;
  doubleHeader?: "Y" | "S";
};

export type ScheduleSource =
  | { kind: "espn"; path: string; groups?: string[] }
  | { kind: "mlb" };

// Every league the store covers, with the same ESPN groups the score feeds use:
// NCAAB groups=50 is all of Division I (the default is ~18 featured games); NCAAF
// is FBS (80) plus FCS (81), merged by event id like getNcaafLiveScores.
export const SCHEDULE_LEAGUES: { sportKey: string; source: ScheduleSource }[] = [
  { sportKey: "basketball_nba", source: { kind: "espn", path: "basketball/nba" } },
  { sportKey: "icehockey_nhl", source: { kind: "espn", path: "hockey/nhl" } },
  { sportKey: "basketball_ncaab", source: { kind: "espn", path: "basketball/mens-college-basketball", groups: ["50"] } },
  { sportKey: "americanfootball_nfl", source: { kind: "espn", path: "football/nfl" } },
  { sportKey: "americanfootball_ncaaf", source: { kind: "espn", path: "football/college-football", groups: ["80", "81"] } },
  { sportKey: "basketball_wnba", source: { kind: "espn", path: "basketball/wnba" } },
  { sportKey: "baseball_mlb", source: { kind: "mlb" } },
];

// The Eastern dates a pull covers: today..today+6.
export function scheduleWindowKeys(now: Date): string[] {
  const today = easternDateKey(now);
  return Array.from({ length: SCHEDULE_DAYS }, (_, i) => addDaysToDateKey(today, i));
}

// The dates worth fetching for one league: those inside its season window
// (lib/sport-seasons.ts), judged at that date's Eastern midday - so a league
// whose season opens on day 4 has days 4-6 pulled, and an off-season league none.
export function plannedScheduleDates(sportKey: string, now: Date): string[] {
  return scheduleWindowKeys(now).filter((d) => isSportInSeason(sportKey, new Date(d + "T17:00:00Z")));
}

export function espnScheduleUrl(path: string, dateKey: string, group?: string): string {
  const params = new URLSearchParams({ dates: dateKey.replace(/-/g, "") });
  if (group) params.set("groups", group);
  // No `limit` param on purpose - see getEspnScoresForDate (odds.ts): above ~500
  // ESPN caps the response at 25 events.
  return "https://site.api.espn.com/apis/site/v2/sports/" + path + "/scoreboard?" + params.toString();
}

export function mlbScheduleUrl(startKey: string, endKey: string): string {
  return "https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=" + startKey + "&endDate=" + endKey;
}

// One ESPN scoreboard response -> compact games. Events with no two named sides
// are dropped (nothing to match a pick against).
export function espnEventsToStored(body: unknown, now: Date): StoredScheduleGame[] {
  const events = (body as { events?: unknown[] } | null)?.events;
  if (!Array.isArray(events)) throw new Error("ESPN scoreboard response has no events array");
  const out: StoredScheduleGame[] = [];
  for (const e of events as any[]) {
    const competitors = e?.competitions?.[0]?.competitors ?? [];
    const home = competitors.find((c: any) => c.homeAway === "home")?.team?.displayName;
    const away = competitors.find((c: any) => c.homeAway === "away")?.team?.displayName;
    if (!home || !away || !e?.id || !e?.date) continue;
    out.push({ id: String(e.id), home, away, start: e.date, status: espnFeedStatus(e.status?.type, e.date, now) });
  }
  return out;
}

// One MLB Stats API schedule response -> compact games grouped by each game's
// officialDate (the Eastern-calendar day MLB files it under).
export function mlbScheduleToStored(body: unknown, now: Date): Map<string, StoredScheduleGame[]> {
  const dates = (body as { dates?: unknown[] } | null)?.dates;
  if (!Array.isArray(dates)) throw new Error("MLB schedule response has no dates array");
  const byDate = new Map<string, StoredScheduleGame[]>();
  for (const d of dates as any[]) {
    for (const g of d?.games ?? []) {
      const home = g?.teams?.home?.team?.name;
      const away = g?.teams?.away?.team?.name;
      if (!home || !away || g?.gamePk == null || !g?.gameDate) continue;
      const day: string = g.officialDate ?? d.date;
      const game: StoredScheduleGame = { id: String(g.gamePk), home, away, start: g.gameDate, status: mlbFeedStatus(g.status, g.gameDate, now) };
      if (g.doubleHeader === "Y" || g.doubleHeader === "S") {
        game.doubleHeader = g.doubleHeader;
        if (typeof g.gameNumber === "number") game.gameNumber = g.gameNumber;
      }
      if (!byDate.has(day)) byDate.set(day, []);
      byDate.get(day)!.push(game);
    }
  }
  return byDate;
}

export function dedupeById(games: StoredScheduleGame[]): StoredScheduleGame[] {
  const seen = new Set<string>();
  return games.filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true)));
}

// One league's pull, as the cron records it: the dates that came back (with
// their games, possibly none) and the dates that failed, each with why.
export type LeagueSchedulePull = {
  sportKey: string;
  planned: string[];
  days: Map<string, StoredScheduleGame[]>;
  failed: { date: string; error: string }[];
};

// feed_syncs: a success only when every planned date came back. Nothing planned
// (off season) records nothing. The error names the failed dates, so Feed
// health shows a sync error rather than a quiet "no games".
export function scheduleSyncOutcome(pull: LeagueSchedulePull): { sportKey: string; ok: true } | { sportKey: string; ok: false; error: string } | null {
  if (pull.planned.length === 0) return null;
  if (pull.failed.length === 0) return { sportKey: pull.sportKey, ok: true };
  const first = pull.failed[0];
  return {
    sportKey: pull.sportKey,
    ok: false,
    error: `schedule pull failed for ${pull.failed.length} of ${pull.planned.length} dates (${pull.failed.map((f) => f.date).join(", ")}): ${first.error}`,
  };
}

// The feed-game shape the resolvers take (a structural subset of odds.ts's
// ScoreGame - kept here so this file never imports the server module).
export type ScheduleFeedGame = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  status: FeedGameStatus;
  scores: null;
  commenceTime: string;
  inningHalf: null;
  inningOrdinal: null;
  innings: null;
  gameNumber?: number | null;
  doubleHeaderStatus?: "Y" | "S" | "N" | null;
};

// Stored games for the import resolvers: only Eastern dates past the score
// feed's window (today+2 onward - the yesterday..tomorrow score feed is the
// authority for anything nearer, with a fresh status), postponed / cancelled
// dropped, every other status read as "preview" (the stored status is a day old;
// a game two or more days out has not started).
export function storedToScheduleGames(rows: { gameDate: string; games: StoredScheduleGame[] }[], now: Date): ScheduleFeedGame[] {
  const firstDay = addDaysToDateKey(easternDateKey(now), 2);
  const out: ScheduleFeedGame[] = [];
  for (const row of rows) {
    if (row.gameDate < firstDay) continue;
    for (const g of row.games) {
      if (g.status === "postponed" || g.status === "cancelled") continue;
      out.push({
        id: g.id,
        homeTeam: g.home,
        awayTeam: g.away,
        status: "preview",
        scores: null,
        commenceTime: g.start,
        inningHalf: null,
        inningOrdinal: null,
        innings: null,
        ...(g.doubleHeader ? { gameNumber: g.gameNumber ?? null, doubleHeaderStatus: g.doubleHeader } : {}),
      });
    }
  }
  return out;
}
