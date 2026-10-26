import { getClientScoresForSport, LIVE_SPORTS } from "@/server/data/odds";
import { isSportInSeason } from "@/lib/sport-seasons";
import { pickDefaultLeague } from "@/lib/live-default-league";

// The league /live opens on when the URL names none: pickDefaultLeague over every in-season
// league's game list. Reads only the shared, cached score feed the board itself reads (the same
// getClientScoresForSport entry, so the chosen league's own read is a hit afterwards): no
// database statement. A league whose feed fails counts as having no games; a league out of
// season has an empty board (getBoardOddsForSport), so it is not read.
export async function getDefaultLiveSport(): Promise<string> {
  const slates = await Promise.all(
    LIVE_SPORTS.filter((s) => isSportInSeason(s.key) || s.key === "baseball_mlb").map(async ({ key }) => {
      const scores = await getClientScoresForSport(key).catch(() => []);
      return { sportKey: key, games: scores.map((g) => ({ status: g.status, commenceTime: g.commenceTime })) };
    })
  );
  return pickDefaultLeague(slates);
}
