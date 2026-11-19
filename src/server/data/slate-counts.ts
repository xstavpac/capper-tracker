import { cache } from "react";
import { getClientScoresForSport } from "@/server/data/odds";
import { SLATE_LEAGUES, buildSlateCounts, type SlateCounts } from "@/lib/slate-counts";

// The Slate Bar's counts. Reads only the shared, cached score feed /live and the ticker already
// read (getClientScoresForSport: its 15 s Data Cache + process memo make this a hit whenever
// another surface just read the same league), so it issues no database statement and, within
// that cache, no extra upstream call. A league whose feed throws is marked failed (it is
// left out of the strip) instead of failing the bar.
export const getSlateCounts = cache(async (now: Date = new Date()): Promise<SlateCounts> => {
  const feeds = await Promise.all(
    SLATE_LEAGUES.map(async ({ key }) => {
      try {
        const games = await getClientScoresForSport(key);
        return { sportKey: key, failed: false, games };
      } catch {
        return { sportKey: key, failed: true, games: [] };
      }
    })
  );
  return buildSlateCounts(feeds, now);
});
