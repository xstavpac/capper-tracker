// The point-in-time starting-pitcher layer for BettingView.
//
// Everything here is read-only against the free MLB Stats API
// (statsapi.mlb.com - no key, no auth, Fastly-cached) plus a reader over
// this app's own GameStarters table. It exists so a later phase can build a
// starter-vs-starter pitching stimulus for the Decay Delta model WITHOUT
// that phase having to worry about how the data is sourced or kept
// point-in-time. This file is the data layer only - it computes no delta and
// applies no adjustment.
//
// Four concerns:
//
//  1. fetchMlbScheduleWithProbables(startKey, endKey)
//       schedule + hydrate=probablePitcher across a date range - the pitcher
//       announced (or, for a finished game, backfilled by MLB) to start each
//       side. Shared with the daily cron (stat-snapshots.ts) so there is one
//       schedule parse, not two.
//
//  2. fetchActualStarters(gamePk)
//       the CONFIRMED starter for each side from the final boxscore.
//       teams.{side}.pitchers[0] is the first pitcher to appear - the ground
//       truth a late scratch can make diverge from the probable.
//
//  3. fetchPointInTimePitcherLines(pitcherIds, asOfDateKey, season)
//       each pitcher's season-to-date ERA / WHIP / K9 / BB9 computed over
//       [regular-season opener .. asOfDateKey] via stats=byDateRange. Pass
//       asOfDateKey = the day BEFORE the game for a genuinely no-look-ahead
//       line. byDateRange returns regular-season stats only - a spring
//       training window returns nothing and a full-year window matches the
//       plain `season` total exactly (both verified live), so a fixed
//       March 1 lower bound needs no gameType filter.
//
//  4. getHistoricalStartingMatchup(sportKey, externalId)
//       ties a persisted GameStarters row to (3): resolves each side's
//       starter (actual, falling back to probable) and its point-in-time
//       line as of the day before the game - preferring a persisted
//       PitcherStatSnapshot row (written by the cron and the historical
//       backfill) and only calling the API when none exists yet. This is
//       the "reader" that proves the write path is usable end to end.
import { prisma } from "@/lib/prisma";
import type { PitcherStatSnapshot } from "@prisma/client";
import { addDaysToDateKey, easternDateKey } from "@/lib/dates";
import { dayBefore, findLatestAtOrBefore } from "@/server/data/providers/snapshot-utils";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const MLB_SPORT_ID = 1;

// A "YYYY-MM-DD" lower bound comfortably before any modern Opening Day.
// byDateRange excludes spring training on its own (verified), so this only
// needs to sit before the first regular-season game, not exactly on it.
export function regularSeasonStartKey(season: number): string {
  return `${season}-03-01`;
}

function seasonOf(dateKey: string): number {
  return Number(dateKey.slice(0, 4));
}

// -------------------------------------------------------------------------
// 1. Schedule + probable starters
// -------------------------------------------------------------------------

export type MlbScheduledGame = {
  gamePk: string;
  gameDate: Date;
  officialDateKey: string; // MLB's own officialDate, "YYYY-MM-DD"
  isFinal: boolean;
  homeTeamId: number;
  awayTeamId: number;
  homeTeamName: string; // MLB club name straight off the response
  awayTeamName: string;
  homeProbable: { id: number; name: string } | null;
  awayProbable: { id: number; name: string } | null;
};

function parseProbable(game: any, side: "home" | "away"): { id: number; name: string } | null {
  const p = game?.teams?.[side]?.probablePitcher;
  return p?.id && p?.fullName ? { id: p.id, name: p.fullName } : null;
}

export async function fetchMlbScheduleWithProbables(startKey: string, endKey: string): Promise<MlbScheduledGame[]> {
  const url = `${MLB_API}/schedule?sportId=${MLB_SPORT_ID}&startDate=${startKey}&endDate=${endKey}&hydrate=probablePitcher`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];

  const data = await res.json();
  const out: MlbScheduledGame[] = [];
  for (const day of data.dates ?? []) {
    for (const g of day.games ?? []) {
      const state = g.status?.abstractGameState;
      out.push({
        gamePk: String(g.gamePk),
        gameDate: new Date(g.gameDate),
        officialDateKey: g.officialDate ?? day.date,
        isFinal: state === "Final" || g.status?.codedGameState === "F",
        homeTeamId: g.teams?.home?.team?.id ?? 0,
        awayTeamId: g.teams?.away?.team?.id ?? 0,
        homeTeamName: g.teams?.home?.team?.name ?? "",
        awayTeamName: g.teams?.away?.team?.name ?? "",
        homeProbable: parseProbable(g, "home"),
        awayProbable: parseProbable(g, "away"),
      });
    }
  }
  return out;
}

// -------------------------------------------------------------------------
// 2. Confirmed actual starters (boxscore)
// -------------------------------------------------------------------------

export type ActualStarters = {
  home: { id: number; name: string } | null;
  away: { id: number; name: string } | null;
};

// pitchers[0] is the first pitcher to take the mound for that side (the
// array is in order of appearance). Guard: if that player's own
// stats.pitching.gamesStarted is explicitly 0, something is off with the
// boxscore's ordering - return null for that side so the caller keeps the
// probable rather than storing a reliever as the starter. An absent
// gamesStarted field is not treated as a rejection (older boxscores don't
// always carry per-player season/game splits).
function pickBoxscoreStarter(team: any): { id: number; name: string } | null {
  const firstId = team?.pitchers?.[0];
  if (!firstId) return null;
  const player = team?.players?.[`ID${firstId}`];
  const started = player?.stats?.pitching?.gamesStarted;
  if (started === 0 || started === "0") return null;
  return { id: firstId, name: player?.person?.fullName ?? String(firstId) };
}

export async function fetchActualStarters(gamePk: string): Promise<ActualStarters | null> {
  const res = await fetch(`${MLB_API}/game/${gamePk}/boxscore`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.teams?.home || !data.teams?.away) return null;
  return { home: pickBoxscoreStarter(data.teams.home), away: pickBoxscoreStarter(data.teams.away) };
}

// -------------------------------------------------------------------------
// 3. Point-in-time pitcher lines (byDateRange)
// -------------------------------------------------------------------------

export type PointInTimePitcherLine = {
  pitcherId: number;
  pitcherName: string;
  asOfDateKey: string; // the endDate the line was computed through (inclusive)
  era: number;
  whip: number;
  strikeouts: number;
  walks: number;
  inningsPitched: number; // MLB "6.1" convention (6 and 1/3)
  k9: number | null; // null only at 0 IP
  bb9: number | null;
  gamesStarted: number;
};

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

// "6.1" -> 6.333.., "6.2" -> 6.666.. - MLB reports innings pitched with a
// fractional-thirds suffix, not a real decimal, so K/9 and BB/9 must divide
// by the true innings count, not the printed number.
export function inningsPitchedToInnings(ip: unknown): number {
  const [wholeStr, fracStr] = String(ip ?? "0").split(".");
  const whole = parseInt(wholeStr, 10) || 0;
  const frac = fracStr === "1" ? 1 / 3 : fracStr === "2" ? 2 / 3 : 0;
  return whole + frac;
}

// The season-total split (not one of the per-team splits a mid-season trade
// produces). The entry with no `team` is MLB's own aggregate across every
// team the pitcher played for; a single-team season has only the one
// per-team entry, and the batched people-hydrate response repeats each
// split, so falling back to splits[0] is correct in both those cases.
export function findAggregateSplit(splits: any[] | undefined): any | undefined {
  if (!splits || splits.length === 0) return undefined;
  return splits.find((s) => !s.team) ?? splits[0];
}

export function pitcherLineFromStat(
  pitcherId: number,
  pitcherName: string,
  asOfDateKey: string,
  stat: any
): PointInTimePitcherLine {
  const trueInnings = stat?.outs != null ? num(stat.outs) / 3 : inningsPitchedToInnings(stat?.inningsPitched);
  const strikeouts = num(stat?.strikeOuts);
  const walks = num(stat?.baseOnBalls);
  const k9 =
    stat?.strikeoutsPer9Inn != null ? num(stat.strikeoutsPer9Inn) : trueInnings > 0 ? (strikeouts * 9) / trueInnings : null;
  const bb9 =
    stat?.walksPer9Inn != null ? num(stat.walksPer9Inn) : trueInnings > 0 ? (walks * 9) / trueInnings : null;
  return {
    pitcherId,
    pitcherName,
    asOfDateKey,
    era: num(stat?.era),
    whip: num(stat?.whip),
    strikeouts,
    walks,
    inningsPitched: num(stat?.inningsPitched),
    k9: k9 == null ? null : Math.round(k9 * 100) / 100,
    bb9: bb9 == null ? null : Math.round(bb9 * 100) / 100,
    gamesStarted: num(stat?.gamesStarted),
  };
}

// One batched call for every id, sharing one [seasonStart .. asOfDateKey]
// window (every starter on a slate has the same cutoff = that slate's date
// minus one). A pitcher with no appearances in the window - his season
// debut is this game or later - is simply absent from the returned map, not
// an error.
export async function fetchPointInTimePitcherLines(
  pitcherIds: number[],
  asOfDateKey: string,
  season: number
): Promise<Map<number, PointInTimePitcherLine>> {
  const out = new Map<number, PointInTimePitcherLine>();
  const ids = [...new Set(pitcherIds)].filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return out;

  const startKey = regularSeasonStartKey(season);
  // The window must end before it begins is impossible; the real guard is
  // that a cutoff before the season even opened has no prior data to
  // return. Anything on/after the game's own date is the CALLER's
  // responsibility (getHistoricalStartingMatchup passes dayBefore), and is
  // covered by the acceptance test asserting the endDate this builds.
  if (asOfDateKey < startKey) return out;

  const url = `${MLB_API}/people?personIds=${ids.join(
    ","
  )}&hydrate=stats(type=byDateRange,startDate=${startKey},endDate=${asOfDateKey},group=pitching)`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return out;

  const data = await res.json();
  for (const person of data.people ?? []) {
    const group = (person.stats ?? []).find(
      (s: any) => s.type?.displayName === "byDateRange" && s.group?.displayName === "pitching"
    );
    const stat = findAggregateSplit(group?.splits)?.stat;
    if (!stat) continue;
    out.set(person.id, pitcherLineFromStat(person.id, person.fullName ?? String(person.id), asOfDateKey, stat));
  }
  return out;
}

// -------------------------------------------------------------------------
// 4. GameStarters reader + point-in-time matchup
// -------------------------------------------------------------------------

export type ResolvedStarter = {
  pitcherId: number;
  pitcherName: string;
  source: "actual" | "probable";
};

export type StartingMatchupSide = {
  starter: ResolvedStarter | null;
  line: PointInTimePitcherLine | null;
  lineSource: "snapshot" | "api" | null;
};

export type HistoricalStartingMatchup = {
  externalId: string;
  gameDate: Date;
  // The point-in-time cutoff: the Eastern calendar day before the game.
  // Every line below is season-to-date THROUGH this date and no later.
  asOfDateKey: string;
  home: StartingMatchupSide;
  away: StartingMatchupSide;
};

function resolveStarter(
  actualId: number | null,
  actualName: string | null,
  probableId: number | null,
  probableName: string | null
): ResolvedStarter | null {
  if (actualId) return { pitcherId: actualId, pitcherName: actualName ?? String(actualId), source: "actual" };
  if (probableId) return { pitcherId: probableId, pitcherName: probableName ?? String(probableId), source: "probable" };
  return null;
}

function lineFromSnapshot(snap: PitcherStatSnapshot): PointInTimePitcherLine {
  const trueInnings = inningsPitchedToInnings(snap.inningsPitched);
  return {
    pitcherId: snap.pitcherId,
    pitcherName: snap.pitcherName,
    asOfDateKey: snap.snapshotDate,
    era: snap.era,
    whip: snap.whip,
    strikeouts: snap.strikeouts,
    walks: snap.walks,
    inningsPitched: snap.inningsPitched,
    k9: trueInnings > 0 ? Math.round(((snap.strikeouts * 9) / trueInnings) * 100) / 100 : null,
    bb9: trueInnings > 0 ? Math.round(((snap.walks * 9) / trueInnings) * 100) / 100 : null,
    gamesStarted: 0, // not stored on the snapshot; not needed by the reader
  };
}

async function pointInTimeLine(
  sportKey: string,
  pitcherId: number,
  gameDate: Date,
  asOfDateKey: string,
  season: number
): Promise<{ line: PointInTimePitcherLine | null; source: "snapshot" | "api" | null }> {
  // Prefer a persisted row. The daily cron and the historical backfill both
  // write PitcherStatSnapshot, and findLatestAtOrBefore(..., dayBefore) is
  // the identical point-in-time selector the model resolver and Zone Model
  // use - not a second one. dayBefore keeps a row dated the game's own day
  // (a same-day cron capture) from ever being chosen.
  const rows = await prisma.pitcherStatSnapshot.findMany({
    where: { sportKey, pitcherId },
    orderBy: { snapshotDate: "asc" },
  });
  const snap = findLatestAtOrBefore(rows, dayBefore(gameDate));
  if (snap) return { line: lineFromSnapshot(snap), source: "snapshot" };

  const lines = await fetchPointInTimePitcherLines([pitcherId], asOfDateKey, season);
  const line = lines.get(pitcherId) ?? null;
  return { line, source: line ? "api" : null };
}

export async function getHistoricalStartingMatchup(
  sportKey: string,
  externalId: string
): Promise<HistoricalStartingMatchup | null> {
  const row = await prisma.gameStarters.findUnique({
    where: { sportKey_externalId: { sportKey, externalId } },
  });
  if (!row) return null;

  const home = resolveStarter(
    row.homeStartingPitcherId,
    row.homeStartingPitcherName,
    row.homeProbablePitcherId,
    row.homeProbablePitcherName
  );
  const away = resolveStarter(
    row.awayStartingPitcherId,
    row.awayStartingPitcherName,
    row.awayProbablePitcherId,
    row.awayProbablePitcherName
  );

  const asOfDateKey = addDaysToDateKey(easternDateKey(row.gameDate), -1);
  const season = seasonOf(easternDateKey(row.gameDate));

  const [homeLine, awayLine] = await Promise.all([
    home ? pointInTimeLine(sportKey, home.pitcherId, row.gameDate, asOfDateKey, season) : Promise.resolve(null),
    away ? pointInTimeLine(sportKey, away.pitcherId, row.gameDate, asOfDateKey, season) : Promise.resolve(null),
  ]);

  return {
    externalId,
    gameDate: row.gameDate,
    asOfDateKey,
    home: { starter: home, line: homeLine?.line ?? null, lineSource: homeLine?.source ?? null },
    away: { starter: away, line: awayLine?.line ?? null, lineSource: awayLine?.source ?? null },
  };
}
