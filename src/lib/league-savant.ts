// Shared (client-safe) contract of the /dashboard League Savant card: row shapes, the score's
// constants and the daily league rotation. The SQL lives in server/data/league-savant.ts.

// Shrinkage toward break-even: every capper is ranked as if they also had this many picks at 0 units.
//   adjusted = netUnits / (decidedPicks + SAVANT_PRIOR_PICKS)
export const SAVANT_PRIOR_PICKS = 20;
// The rows the card shows, and the rows "See more" opens it to (all of them come in the one read).
export const SAVANT_COLLAPSED_COUNT = 5;
export const SAVANT_PANEL_COUNT = 10;
// "+X.Xu last 30" under #1's name.
export const SAVANT_TREND_DAYS = 30;
// A league is in season when the feed has a game within this many days of today, either side.
export const SAVANT_IN_SEASON_DAYS = 7;
// Two regular-season game days further apart than this are two seasons (the longest in-season break,
// an Olympic one, is about a month; the shortest off-season is over three).
export const SAVANT_SEASON_GAP_DAYS = 60;
// The season window when the feed cannot say where the season started: this many Eastern days back.
export const SAVANT_FALLBACK_DAYS = 180;
// How far back the feed is read for a season's start: past the longest season, into the one before.
export const SAVANT_FEED_LOOKBACK_DAYS = 400;

// `units` / `picks` are the real season totals (pushes count as picks and add 0 units); `score` is
// the 0-100 percentile of the shrunk rate among the league's ranked cappers. `last30Units` is null
// when the capper has no graded pick in the last SAVANT_TREND_DAYS days.
export type SavantRow = { capperId: string; name: string; units: number; picks: number; score: number; last30Units: number | null };

// Where a league's season start came from:
//   feed      the first regular-season game day of the feed's newest season
//   upcoming  the feed's last regular-season game is a season ago: this one has no final yet, so the
//             window opens today
//   fallback  the feed cannot say (no games, or its history starts mid-season): SAVANT_FALLBACK_DAYS
export type SavantSeasonSource = "feed" | "upcoming" | "fallback";
export type SavantLeague = { league: string; seasonStart: string; seasonSource: SavantSeasonSource; rows: SavantRow[] };

// `leagues` is in a fixed alphabetical order: the in-season ones, or - `fromFeed` false, the feed
// named none - every league with a decided pick this season.
export type LeagueSavant = { leagues: SavantLeague[]; fromFeed: boolean };

// Day 0 of the rotation, an Eastern calendar day. Any fixed day works; changing it reshuffles which
// league leads on which day.
export const SAVANT_ROTATION_EPOCH = "2026-01-01";

// Whole Eastern calendar days from the epoch to `dateKey` ("YYYY-MM-DD", easternDateKey): it steps
// at midnight Eastern, and is the same for every viewer.
export function savantDayIndex(dateKey: string): number {
  const day = (key: string) => Date.parse(key + "T00:00:00.000Z");
  return Math.round((day(dateKey) - day(SAVANT_ROTATION_EPOCH)) / 86400000);
}

// The day's league: one step through the (alphabetical) list per Eastern day.
export function defaultSavantLeague(leagues: string[], dateKey: string): string | null {
  if (leagues.length === 0) return null;
  const n = leagues.length;
  return leagues[((savantDayIndex(dateKey) % n) + n) % n];
}

// A viewer's own choice is kept for the rest of that Eastern day only: the key carries the date, so
// the next day's lookup finds nothing and the rotation takes over again.
export const savantChoiceKey = (dateKey: string) => "league-savant:" + dateKey;
