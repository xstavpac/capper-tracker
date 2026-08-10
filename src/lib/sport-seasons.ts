import { easternDateKey } from "@/lib/dates";

// One entry per sport whose Odds-API/score fetches should be suppressed
// outside its active window. `seasonEnd` intentionally covers through that
// sport's postseason, not just its regular season - a bare "regular season"
// cutoff would incorrectly gate out real, heavily-bet playoff/finals games.
// Update these once a year when each league announces its new schedule;
// there's no live schedule feed reliable enough across all five sports to
// derive this automatically, so a plain config is the deliberate choice
// here (see the NFL Odds API investigation for the same tradeoff reasoned
// through in more depth for NFL specifically).
export type SportSeasonWindow = { seasonStart: string; seasonEnd: string };

export const SPORT_SEASON_CONFIG: Record<string, SportSeasonWindow> = {
  // 2026 season opener: Seahawks @ Patriots, Wed 2026-09-09. seasonEnd
  // covers through Super Bowl LXI (early-mid Feb 2027).
  americanfootball_nfl: { seasonStart: "2026-09-09", seasonEnd: "2027-02-15" },
  // 2026-27 tip-off ~mid/late Oct 2026; seasonEnd covers through the Finals
  // (mid-to-late June 2027).
  basketball_nba: { seasonStart: "2026-10-20", seasonEnd: "2027-06-25" },
  // 2026 Opening Day ~late March; seasonEnd covers through the World Series
  // (early Nov 2026).
  baseball_mlb: { seasonStart: "2026-03-15", seasonEnd: "2026-11-05" },
  // 2026-27 puck-drop ~early Oct 2026; seasonEnd covers through the Stanley
  // Cup Final (mid-to-late June 2027).
  icehockey_nhl: { seasonStart: "2026-10-07", seasonEnd: "2027-06-20" },
  // 2026 season tips off mid-May; seasonEnd covers through the WNBA Finals
  // (mid-to-late Oct 2026).
  basketball_wnba: { seasonStart: "2026-05-15", seasonEnd: "2026-10-20" },
};

// Fails closed, not open: a sportKey with no entry here is treated as
// out-of-season rather than always-in-season. The credit-leak bug this
// fixes (a sport silently fetched year-round because nobody added a season
// check) only stays fixed if adding a new sport to LIVE_SPORTS/
// RESOLVABLE_SPORT_KEYS forces a conscious decision about its season
// window, instead of defaulting to "fetch always" until someone notices.
export function isSportInSeason(sportKey: string, referenceDate: Date = new Date()): boolean {
  const window = SPORT_SEASON_CONFIG[sportKey];
  if (!window) return false;
  const today = easternDateKey(referenceDate);
  return today >= window.seasonStart && today <= window.seasonEnd;
}

// Maps the short display labels used by parse-catalog.ts's AMBIGUOUS_NICKNAMES
// (and LIVE_SPORTS' own labels) to the sportKey strings SPORT_SEASON_CONFIG is
// keyed by - kept here rather than importing LIVE_SPORTS from
// server/data/odds.ts, which pulls in prisma/fetch and can't be imported from
// a "use client" component.
export const SPORT_LABEL_TO_KEY: Record<string, string> = {
  NFL: "americanfootball_nfl",
  NBA: "basketball_nba",
  MLB: "baseball_mlb",
  NHL: "icehockey_nhl",
  WNBA: "basketball_wnba",
};

// Same idea as isSportInSeason, but for the AMBIGUOUS_NICKNAMES-style display
// label rather than a sportKey - used by the catalog-import disambiguation
// pipeline to narrow an ambiguous team name (e.g. "Cardinals") down to
// whichever of its candidate sports is actually in season. Fails open (an
// unmapped label doesn't get eliminated) rather than isSportInSeason's fail-
// closed default - here the risk of wrongly ruling out a real candidate
// outweighs the risk of not narrowing, unlike the credit-cost gate that
// function exists for.
export function isSportLabelInSeason(label: string, referenceDate: Date = new Date()): boolean {
  const key = SPORT_LABEL_TO_KEY[label];
  if (!key) return true;
  return isSportInSeason(key, referenceDate);
}
