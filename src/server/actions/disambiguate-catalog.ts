"use server";

import { requireUser } from "@/server/auth";
import {
  resolveGameForNickname,
  getLiveScoresForSport,
  getOddsForSport,
  getNcaafUpcomingFcsGames,
  RESOLVABLE_SPORT_KEYS,
} from "@/server/data/odds";
import { SPORT_LABEL_TO_KEY } from "@/lib/sport-seasons";
import { hasGameWithinActivityWindow, type ScheduleCheckQuery } from "@/lib/ambiguous-hierarchy";

export type { ScheduleCheckQuery };

// The primary signal in the catalog-import disambiguation hierarchy (see
// ambiguous-hierarchy.ts) - for each (nickname, candidate sport) pair, looks
// up whether that sport's schedule has a game for that team RIGHT NOW
// (~yesterday..tomorrow). Runs before the calendar/season check now, not
// after. Uses resolveGameForNickname - the exact same live-game data source
// the real import uses to match picks to games - with nearTermOnly, so it
// answers "is playing now", NOT "has a game somewhere in the posted
// schedule" (which is what import game-matching wants, and which would let a
// daily-sport team out-vote a weekly team just by playing every day).
export async function checkAmbiguousTeamSchedules(queries: ScheduleCheckQuery[]): Promise<Record<string, boolean>> {
  await requireUser();

  const result: Record<string, boolean> = {};
  await Promise.all(
    queries.map(async ({ nickname, sport }) => {
      const sportKey = SPORT_LABEL_TO_KEY[sport];
      const mapKey = nickname + "|" + sport;
      // No live score source wired up for this sport at all (see
      // RESOLVABLE_SPORT_KEYS) - can't confirm a game either way, so this
      // pair contributes nothing to narrowing rather than being treated as
      // a confident "no game today".
      if (!sportKey || !RESOLVABLE_SPORT_KEYS.includes(sportKey)) {
        result[mapKey] = false;
        return;
      }
      const { game } = await resolveGameForNickname(sportKey, nickname, { nearTermOnly: true });
      result[mapKey] = game !== null;
      console.log(
        "[catalog-disambiguation] schedule check:",
        nickname,
        sport,
        "->",
        game !== null ? "has a game today" : "no game today"
      );
    })
  );
  return result;
}

// The schedule-check tiebreaker in ambiguous-hierarchy.ts - answers "does
// this candidate have a real game ANYWHERE on the posted schedule" rather
// than checkAmbiguousTeamSchedules' "is playing right now". Same
// resolveGameForNickname call, just without nearTermOnly, so it also
// consults the full posted-schedule odds feed - a team playing later this
// week still counts. Only ever called for the runner-up candidate(s) of a
// key the near-term check already narrowed to one match.
export async function checkAmbiguousTeamWideSchedules(queries: ScheduleCheckQuery[]): Promise<Record<string, boolean>> {
  await requireUser();

  const result: Record<string, boolean> = {};
  await Promise.all(
    queries.map(async ({ nickname, sport }) => {
      const sportKey = SPORT_LABEL_TO_KEY[sport];
      const mapKey = nickname + "|" + sport;
      if (!sportKey || !RESOLVABLE_SPORT_KEYS.includes(sportKey)) {
        result[mapKey] = false;
        return;
      }
      const { game } = await resolveGameForNickname(sportKey, nickname);
      result[mapKey] = game !== null;
      console.log(
        "[catalog-disambiguation] wide schedule tiebreaker check:",
        nickname,
        sport,
        "->",
        game !== null ? "has a real scheduled game" : "nothing on the schedule"
      );
    })
  );
  return result;
}

// Step 1b of the hierarchy (see ambiguous-hierarchy.ts): for each candidate
// league, whether it has a game within LEAGUE_ACTIVITY_WINDOW_DAYS of the
// import, read from the same two feeds the import matches games against - the
// score feed first, then the posted-schedule odds feed (and, for NCAAF, the
// week-ahead FCS schedule), which is only read when the score feed shows
// nothing in the window.
//
// A league is reported `false` only when its feeds were read and hold no game
// in the window. A league with no feed wired up (KBO, CFL) or whose read threw
// is left out of the result - "couldn't tell", which the hierarchy never drops.
export async function checkAmbiguousLeagueActivity(
  sports: string[],
  referenceIso: string
): Promise<Record<string, boolean>> {
  await requireUser();

  const referenceDate = new Date(referenceIso);
  const result: Record<string, boolean> = {};
  await Promise.all(
    sports.map(async (sport) => {
      const sportKey = SPORT_LABEL_TO_KEY[sport];
      if (!sportKey || !RESOLVABLE_SPORT_KEYS.includes(sportKey)) return;
      try {
        let active = hasGameWithinActivityWindow(await getLiveScoresForSport(sportKey), referenceDate);
        if (!active) active = hasGameWithinActivityWindow(await getOddsForSport(sportKey), referenceDate);
        if (!active && sportKey === "americanfootball_ncaaf") {
          active = hasGameWithinActivityWindow(await getNcaafUpcomingFcsGames(), referenceDate);
        }
        result[sport] = active;
      } catch (err) {
        console.log(
          "[catalog-disambiguation] league activity read failed, leaving the league undecided:",
          sport,
          err instanceof Error ? err.message : err
        );
      }
    })
  );
  console.log("[catalog-disambiguation] league activity:", result);
  return result;
}
