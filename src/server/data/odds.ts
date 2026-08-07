import { prisma } from "@/lib/prisma";
import { sameLocalDay, closestByTime } from "@/lib/dates";

export type OddsGame = {
  id: string;
  sportKey: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  bookmakers: {
    key: string;
    title: string;
    markets: {
      key: string;
      outcomes: { name: string; price: number; point?: number }[];
    }[];
  }[];
};

export type ScoreGame = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  status: "preview" | "live" | "final";
  scores: { name: string; score: string }[] | null;
  commenceTime: string;
};

export const LIVE_SPORTS = [
  { key: "americanfootball_nfl", label: "NFL" },
  { key: "basketball_nba", label: "NBA" },
  { key: "baseball_mlb", label: "MLB" },
  { key: "icehockey_nhl", label: "NHL" },
  { key: "basketball_wnba", label: "WNBA" },
];

const BASE_URL = "https://api.the-odds-api.com/v4";

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function getOddsForSport(sportKey: string): Promise<OddsGame[]> {
  const fetchDate = todayKey();

  const existing = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
  });
  if (existing) {
    return existing.data as unknown as OddsGame[];
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return [];

  const url =
    BASE_URL +
    "/sports/" +
    sportKey +
    "/odds/?apiKey=" +
    apiKey +
    "&regions=us&markets=h2h,spreads,totals&oddsFormat=american";

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];

  const raw = await res.json();
  const games: OddsGame[] = raw.map((g: any) => ({
    id: g.id,
    sportKey: g.sport_key,
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    commenceTime: g.commence_time,
    bookmakers: g.bookmakers ?? [],
  }));

  await prisma.oddsSnapshot.upsert({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
    update: { data: games as any },
    create: { sportKey, fetchDate, data: games as any },
  });

  return games;
}

export async function getMlbLiveScores(): Promise<ScoreGame[]> {
  const today = todayKey();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const url = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=" + yesterday + "&endDate=" + tomorrow;

  const res = await fetch(url, { next: { revalidate: 60 } });
  if (!res.ok) return [];

  const data = await res.json();
  const games = (data.dates ?? []).flatMap((d: any) => d.games ?? []);

  return games.map((g: any) => {
    const state = g.status?.abstractGameState;
    const status: "preview" | "live" | "final" =
      state === "Final" ? "final" : state === "Live" ? "live" : "preview";

    return {
      id: String(g.gamePk),
      homeTeam: g.teams.home.team.name,
      awayTeam: g.teams.away.team.name,
      status,
      scores:
        status === "preview"
          ? null
          : [
              { name: g.teams.home.team.name, score: String(g.teams.home.score ?? 0) },
              { name: g.teams.away.team.name, score: String(g.teams.away.score ?? 0) },
            ],
      commenceTime: g.gameDate,
    };
  });
}

// Shared by every ESPN-backed score source (NBA, WNBA, ...) - ESPN's free
// public scoreboard endpoint (no key required, same "free/unauthenticated"
// pattern as MLB Stats API) has an identical response shape across sports,
// just a different URL path segment. First-half grading isn't wired up for
// any ESPN-backed sport yet - this only covers full-game status/scores,
// which is enough for live display and full-game Moneyline/Spread/Total
// grading.
async function getEspnScores(sportPath: string): Promise<ScoreGame[]> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const yesterday = fmt(new Date(Date.now() - 86400000));
  const tomorrow = fmt(new Date(Date.now() + 86400000));
  const url =
    "https://site.api.espn.com/apis/site/v2/sports/" + sportPath + "/scoreboard?dates=" + yesterday + "-" + tomorrow;

  const res = await fetch(url, { next: { revalidate: 60 } });
  if (!res.ok) return [];

  const data = await res.json();
  const events = data.events ?? [];

  return events.map((e: any) => {
    const competitors = e.competitions?.[0]?.competitors ?? [];
    const home = competitors.find((c: any) => c.homeAway === "home");
    const away = competitors.find((c: any) => c.homeAway === "away");
    const state = e.status?.type?.state;
    const status: "preview" | "live" | "final" = state === "post" ? "final" : state === "in" ? "live" : "preview";

    return {
      id: String(e.id),
      homeTeam: home?.team?.displayName ?? "",
      awayTeam: away?.team?.displayName ?? "",
      status,
      scores:
        status === "preview"
          ? null
          : [
              { name: home?.team?.displayName ?? "", score: String(home?.score ?? 0) },
              { name: away?.team?.displayName ?? "", score: String(away?.score ?? 0) },
            ],
      commenceTime: e.date,
    };
  });
}

export function getNbaLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("basketball/nba");
}

export function getWnbaLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("basketball/wnba");
}

// Sports with a real score source wired up (see getLiveScoresForSport below).
// The rest of LIVE_SPORTS still get odds display, just no live score/badge,
// game resolution, or auto-grading yet - add a key here (and a case below)
// once a free score source is wired up for it.
export const RESOLVABLE_SPORT_KEYS = ["baseball_mlb", "basketball_nba", "basketball_wnba"];

// Dispatches to the right free score source for a sport. Add a case here
// (and a getXLiveScores() above) when wiring up a new sport.
export async function getLiveScoresForSport(sportKey: string): Promise<ScoreGame[]> {
  if (sportKey === "baseball_mlb") return getMlbLiveScores();
  if (sportKey === "basketball_nba") return getNbaLiveScores();
  if (sportKey === "basketball_wnba") return getWnbaLiveScores();
  return [];
}

export type MlbEarlyInningScores = {
  firstInning: { home: number; away: number } | null;
  firstFive: { home: number; away: number } | null;
};

// Reads innings 1 and 1-5 from a finished game's linescore in a single
// fetch, for grading NRFI and F5/first-half picks respectively. Only call
// this once a game is Final - mid-game, a still-in-progress inning would
// report an incomplete (and misleading) score for whichever team hasn't
// batted yet. The schedule endpoint used by getMlbLiveScores() doesn't
// include inning-by-inning data, so this hits the heavier live-feed
// endpoint - only worth it for the one-time capture per game (both values
// share this one fetch rather than each needing their own).
export async function getMlbEarlyInningScores(gamePk: string): Promise<MlbEarlyInningScores> {
  const res = await fetch("https://statsapi.mlb.com/api/v1.1/game/" + gamePk + "/feed/live", {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return { firstInning: null, firstFive: null };

  const data = await res.json();
  const innings = data.liveData?.linescore?.innings ?? [];

  const inning1 = innings.find((i: any) => i.num === 1);
  const firstInning = inning1 ? { home: inning1.home?.runs ?? 0, away: inning1.away?.runs ?? 0 } : null;

  const firstFiveInnings = innings.filter((i: any) => i.num <= 5);
  let firstFive: { home: number; away: number } | null = null;
  if (firstFiveInnings.length >= 5) {
    let home = 0;
    let away = 0;
    for (const inning of firstFiveInnings) {
      home += inning.home?.runs ?? 0;
      away += inning.away?.runs ?? 0;
    }
    firstFive = { home, away };
  }

  return { firstInning, firstFive };
}

// Resolves a bare team nickname (e.g. "white sox", parsed from a capper's raw
// pick text) to the real game it refers to, using the yesterday/today/
// tomorrow schedule window for the given sport. Same-team matchups repeat
// every few days in a season (series/back-to-backs), so when a nickname
// matches more than one game we prefer a game on the same local calendar day
// as `referenceTime`, and within that, prefer one that hasn't finished yet -
// falling back to whichever candidate started closest to `referenceTime`.
export async function resolveGameForNickname(
  sportKey: string,
  nickname: string,
  referenceTime: Date = new Date()
): Promise<ScoreGame | null> {
  const games = await getLiveScoresForSport(sportKey);
  const candidates = games.filter(
    (g) => g.homeTeam.toLowerCase().endsWith(nickname) || g.awayTeam.toLowerCase().endsWith(nickname)
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sameDay = candidates.filter((g) => sameLocalDay(new Date(g.commenceTime), referenceTime));
  const pool = sameDay.length > 0 ? sameDay : candidates;
  const notFinal = pool.filter((g) => g.status !== "final");
  const finalPool = notFinal.length > 0 ? notFinal : pool;

  return closestByTime(finalPool, (g) => new Date(g.commenceTime).getTime(), referenceTime.getTime());
}

// Same idea as resolveGameForNickname, but for picks that name both teams
// (e.g. "Dodgers Cubs under 8.5") - requiring both nicknames to match pins the
// exact matchup directly instead of leaning on time-proximity guessing, and
// naturally disambiguates cases a single nickname alone couldn't.
export async function resolveGameForTeams(
  sportKey: string,
  nicknameA: string,
  nicknameB: string,
  referenceTime: Date = new Date()
): Promise<ScoreGame | null> {
  const games = await getLiveScoresForSport(sportKey);
  const candidates = games.filter((g) => {
    const home = g.homeTeam.toLowerCase();
    const away = g.awayTeam.toLowerCase();
    return (
      (home.endsWith(nicknameA) && away.endsWith(nicknameB)) ||
      (home.endsWith(nicknameB) && away.endsWith(nicknameA))
    );
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sameDay = candidates.filter((g) => sameLocalDay(new Date(g.commenceTime), referenceTime));
  const pool = sameDay.length > 0 ? sameDay : candidates;
  const notFinal = pool.filter((g) => g.status !== "final");
  const finalPool = notFinal.length > 0 ? notFinal : pool;

  return closestByTime(finalPool, (g) => new Date(g.commenceTime).getTime(), referenceTime.getTime());
}

// Matches a single odds-listed game to its live/final score by team pair,
// preferring whichever score candidate started closest to the odds game's
// commenceTime - same repeat-matchup problem resolveGameForNickname solves.
export function matchScoreToGame(
  scores: ScoreGame[],
  game: { homeTeam: string; awayTeam: string; commenceTime: string }
): ScoreGame | undefined {
  const candidates = scores.filter((s) => s.homeTeam === game.homeTeam && s.awayTeam === game.awayTeam);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const gameStart = new Date(game.commenceTime).getTime();
  return closestByTime(candidates, (s) => new Date(s.commenceTime).getTime(), gameStart);
}

// Looks up the real market price for a resolved game (see
// resolveGameForNickname), so bulk-imported picks that didn't state an
// explicit price can use the actual line instead of a hardcoded -110.
export async function findMarketPrice(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  betType: "SPREAD" | "MONEYLINE" | "TOTAL" | "PLAYER_PROP" | "NRFI",
  side: "home" | "away" | "over" | "under"
): Promise<number | null> {
  // No odds-API market exists for NRFI, so it falls through to null (default -110)
  // same as PLAYER_PROP - only h2h/spreads/totals have a real market to look up.
  const marketKey =
    betType === "MONEYLINE" ? "h2h" : betType === "SPREAD" ? "spreads" : betType === "TOTAL" ? "totals" : null;
  if (!marketKey) return null;

  const oddsGames = await getOddsForSport(sportKey);
  const candidates = oddsGames.filter((g) => g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam);
  if (candidates.length === 0) return null;

  const gameStart = new Date(game.commenceTime).getTime();
  const oddsGame = closestByTime(candidates, (g) => new Date(g.commenceTime).getTime(), gameStart);

  const outcomeName =
    side === "home" ? oddsGame.homeTeam : side === "away" ? oddsGame.awayTeam : side === "over" ? "Over" : "Under";

  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === marketKey);
    const outcome = market?.outcomes.find((o) => o.name === outcomeName);
    if (outcome) return outcome.price;
  }

  return null;
}


