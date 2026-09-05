"use server";

import { requireUser } from "@/server/auth";
import { resolveGameForNickname, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { SPORT_LABEL_TO_KEY } from "@/lib/sport-seasons";
import type { ScheduleCheckQuery } from "@/lib/ambiguous-hierarchy";

export type { ScheduleCheckQuery };

// The primary signal in the catalog-import disambiguation hierarchy (see
// ambiguous-hierarchy.ts) - for each (nickname, candidate sport) pair, looks
// up whether that sport's schedule has a game for that team today. Runs
// before the calendar/season check now, not after. Uses resolveGameForNickname, the
// exact same live-game data source the real import already uses to match
// picks to games (and that powers the Live tab) - not a UI scrape, and not a
// separate/parallel resolution path.
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
      const game = await resolveGameForNickname(sportKey, nickname);
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
