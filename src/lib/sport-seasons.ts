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
export type SportSeasonWindow = {
  seasonStart: string;
  seasonEnd: string;
  // Only set for a sport whose Odds API listing splits its preseason into a
  // wholly separate sport key from its regular-season one (confirmed live:
  // NFL preseason odds live under "americanfootball_nfl_preseason", not
  // "americanfootball_nfl", even though this app treats the two as one
  // continuous NFL season everywhere else - one entry in LIVE_SPORTS, one
  // seasonStart/seasonEnd window, one set of grading rules). Before
  // regularSeasonStart, getOddsForSport (odds.ts) queries oddsApiPreseasonKey
  // instead of the sport's own key; on/after it, the sport's own key is used
  // exactly as it always has been. No other sport needs these two fields
  // today - they're absent, so oddsApiSportKey below is a no-op for them.
  regularSeasonStart?: string;
  oddsApiPreseasonKey?: string;
};

export const SPORT_SEASON_CONFIG: Record<string, SportSeasonWindow> = {
  // seasonStart is ESPN's own preseason start for 2026 (confirmed live against
  // their scoreboard: season.startDate = 2026-08-06T07:00Z, Hall of Fame
  // Weekend), not the regular-season opener (Seahawks @ Patriots, 2026-09-09) -
  // deliberately widened to cover preseason too, so real preseason games can
  // exercise the same odds/scores/grading pipeline the regular season uses,
  // no separate "preseason mode." seasonEnd covers through Super Bowl LXI
  // (early-mid Feb 2027). regularSeasonStart/oddsApiPreseasonKey handle the
  // one place preseason genuinely does need different sourcing - see the
  // type comment above and oddsApiSportKey below; confirmed live that
  // americanfootball_nfl_preseason actually has real odds data before wiring
  // this in (16 games, full h2h/spreads/totals, 9 books).
  americanfootball_nfl: {
    seasonStart: "2026-08-06",
    seasonEnd: "2027-02-15",
    regularSeasonStart: "2026-09-09",
    oddsApiPreseasonKey: "americanfootball_nfl_preseason",
  },
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
  // FBS Week 0 is confirmed live for 2026-08-29 (matches the Odds API's own
  // posted slate, checked live during the NCAAF ecosystem investigation);
  // seasonStart is a few days earlier as a buffer, same reasoning as NFL's
  // own preseason buffer above. seasonEnd covers through the 12-team CFP
  // National Championship, confirmed for 2027-01-25, plus a buffer past it.
  americanfootball_ncaaf: { seasonStart: "2026-08-25", seasonEnd: "2027-02-01" },
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

// Which literal Odds API sport key to actually query for `sportKey` right
// now - only ever differs from sportKey itself during a preseason window,
// and only for a sport that has oddsApiPreseasonKey configured (NFL today).
// Purely additive: every other sport, and NFL itself once its regular season
// starts, gets sportKey back unchanged, so this doesn't touch the
// already-working regular-season path at all. This app's own idea of the
// sport (LIVE_SPORTS, RESOLVABLE_SPORT_KEYS, SPORT_SEASON_CONFIG, grading)
// stays keyed on sportKey throughout - only the fetch URL changes.
export function oddsApiSportKey(sportKey: string, referenceDate: Date = new Date()): string {
  const window = SPORT_SEASON_CONFIG[sportKey];
  if (!window?.oddsApiPreseasonKey || !window.regularSeasonStart) return sportKey;
  const today = easternDateKey(referenceDate);
  return today < window.regularSeasonStart ? window.oddsApiPreseasonKey : sportKey;
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
