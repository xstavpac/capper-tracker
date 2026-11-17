// The Slate Bar's numbers, worked out from the score feed the Live tab already reads
// (getClientScoresForSport: ESPN / MLB Stats API, cached, no database). Pure and
// dependency-light so the server loader and the acceptance test share it.
import { addDaysToDateKey, easternDateKey } from "@/lib/dates";

export type SlateDay = "yesterday" | "today" | "tomorrow";
export const SLATE_DAYS: SlateDay[] = ["yesterday", "today", "tomorrow"];
export const SLATE_DAY_LABEL: Record<SlateDay, string> = { yesterday: "Yesterday", today: "Today", tomorrow: "Tomorrow" };

// Display order of the league chips. `logo` is the league's own logo as ESPN's scoreboard
// reports it (leagues[0].logos, the dark-background variant, since the bar is navy); the college
// leagues have no /teamlogos/leagues image, ESPN uses the NCAA Sports icons for them.
export const SLATE_LEAGUES = [
  { key: "basketball_nba", label: "NBA", logo: "https://a.espncdn.com/i/teamlogos/leagues/500-dark/nba.png" },
  { key: "americanfootball_nfl", label: "NFL", logo: "https://a.espncdn.com/i/teamlogos/leagues/500-dark/nfl.png" },
  { key: "icehockey_nhl", label: "NHL", logo: "https://a.espncdn.com/i/teamlogos/leagues/500-dark/nhl.png" },
  { key: "basketball_ncaab", label: "NCAAB", logo: "https://a.espncdn.com/redesign/assets/img/icons/NCAASports_MensBasketball.png" },
  { key: "americanfootball_ncaaf", label: "NCAAF", logo: "https://a.espncdn.com/redesign/assets/img/icons/NCAASports_Football.png" },
  { key: "baseball_mlb", label: "MLB", logo: "https://a.espncdn.com/i/teamlogos/leagues/500-dark/mlb.png" },
  { key: "basketball_wnba", label: "WNBA", logo: "https://a.espncdn.com/i/teamlogos/leagues/500-dark/wnba.png" },
] as const;

export type LeagueDayCount = {
  // Games that count toward "{n} games": every game on the day except postponed/cancelled ones.
  games: number;
  live: number;
  // Not started yet.
  pending: number;
};

export type LeagueSlate = {
  sportKey: string;
  // The league has no games in the feed's window at all and is out of season.
  offseason: boolean;
  // The league's feed could not be read; its chip shows no count.
  failed: boolean;
  days: Record<SlateDay, LeagueDayCount>;
};

export type SlateCounts = { leagues: LeagueSlate[] };

export type SlateFeedInput = {
  sportKey: string;
  inSeason: boolean;
  failed: boolean;
  games: { status: string; commenceTime: string }[];
};

const EMPTY_DAY = (): LeagueDayCount => ({ games: 0, live: 0, pending: 0 });

export function buildSlateCounts(feeds: SlateFeedInput[], now: Date = new Date()): SlateCounts {
  const todayKey = easternDateKey(now);
  const keyToDay = new Map<string, SlateDay>([
    [addDaysToDateKey(todayKey, -1), "yesterday"],
    [todayKey, "today"],
    [addDaysToDateKey(todayKey, 1), "tomorrow"],
  ]);

  const leagues = feeds.map((feed): LeagueSlate => {
    const days: Record<SlateDay, LeagueDayCount> = { yesterday: EMPTY_DAY(), today: EMPTY_DAY(), tomorrow: EMPTY_DAY() };
    for (const g of feed.games) {
      if (g.status === "postponed" || g.status === "cancelled") continue;
      const dayKey = easternDateKey(new Date(g.commenceTime));
      // A game still live after midnight (started yesterday evening) is happening today.
      const day = g.status === "live" && dayKey < todayKey ? "today" : (keyToDay.get(dayKey) ?? null);
      if (!day) continue;
      days[day].games += 1;
      if (g.status === "live") days[day].live += 1;
      else if (g.status === "preview") days[day].pending += 1;
    }
    const anyGames = SLATE_DAYS.some((d) => days[d].games > 0);
    return { sportKey: feed.sportKey, offseason: !feed.failed && !feed.inSeason && !anyGames, failed: feed.failed, days };
  });
  return { leagues };
}

export type SlateTotals = { live: number; pending: number; liveTop: string | null; pendingTop: string | null };

// The two stats cells for a day: totals across every league, plus the league with the most
// matching games (where the cell's link lands, since /live shows one league at a time).
export function slateTotals(counts: SlateCounts, day: SlateDay): SlateTotals {
  let live = 0;
  let pending = 0;
  let liveTop: { key: string; n: number } | null = null;
  let pendingTop: { key: string; n: number } | null = null;
  for (const l of counts.leagues) {
    const d = l.days[day];
    live += d.live;
    pending += d.pending;
    if (d.live > (liveTop?.n ?? 0)) liveTop = { key: l.sportKey, n: d.live };
    if (d.pending > (pendingTop?.n ?? 0)) pendingTop = { key: l.sportKey, n: d.pending };
  }
  return { live, pending, liveTop: liveTop?.key ?? null, pendingTop: pendingTop?.key ?? null };
}

// Chip order for a day: leagues with games first, then the rest, each group in SLATE_LEAGUES order.
export function orderSlateLeagues(counts: SlateCounts, day: SlateDay): LeagueSlate[] {
  const bySport = new Map(counts.leagues.map((l) => [l.sportKey, l]));
  const ordered = SLATE_LEAGUES.map((l) => bySport.get(l.key)).filter((l): l is LeagueSlate => !!l);
  const has = (l: LeagueSlate) => l.days[day].games > 0;
  return [...ordered.filter(has), ...ordered.filter((l) => !has(l))];
}
