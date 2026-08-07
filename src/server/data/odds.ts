import { prisma } from "@/lib/prisma";
import { sameLocalDay } from "@/lib/dates";

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

// Resolves a bare team nickname (e.g. "white sox", parsed from a capper's raw
// pick text) to the real MLB game it refers to, using the yesterday/today/
// tomorrow schedule window. Same-team matchups repeat every few days in MLB
// (series play), so when a nickname matches more than one game we prefer a
// game on the same local calendar day as `referenceTime`, and within that,
// prefer one that hasn't finished yet - falling back to whichever candidate
// started closest to `referenceTime`.
export async function resolveMlbGameForNickname(
  nickname: string,
  referenceTime: Date = new Date()
): Promise<ScoreGame | null> {
  const games = await getMlbLiveScores();
  const candidates = games.filter(
    (g) => g.homeTeam.toLowerCase().endsWith(nickname) || g.awayTeam.toLowerCase().endsWith(nickname)
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sameDay = candidates.filter((g) => sameLocalDay(new Date(g.commenceTime), referenceTime));
  const pool = sameDay.length > 0 ? sameDay : candidates;
  const notFinal = pool.filter((g) => g.status !== "final");
  const finalPool = notFinal.length > 0 ? notFinal : pool;

  return finalPool.reduce((closest, candidate) => {
    const closestDiff = Math.abs(new Date(closest.commenceTime).getTime() - referenceTime.getTime());
    const candidateDiff = Math.abs(new Date(candidate.commenceTime).getTime() - referenceTime.getTime());
    return candidateDiff < closestDiff ? candidate : closest;
  });
}

// Looks up the real market price for a resolved MLB game (see
// resolveMlbGameForNickname), so bulk-imported picks that didn't state an
// explicit price can use the actual line instead of a hardcoded -110.
export async function findMlbMarketPrice(
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  betType: "SPREAD" | "MONEYLINE" | "TOTAL" | "PLAYER_PROP",
  side: "home" | "away" | "over" | "under"
): Promise<number | null> {
  const marketKey =
    betType === "MONEYLINE" ? "h2h" : betType === "SPREAD" ? "spreads" : betType === "TOTAL" ? "totals" : null;
  if (!marketKey) return null;

  const oddsGames = await getOddsForSport("baseball_mlb");
  const candidates = oddsGames.filter((g) => g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam);
  if (candidates.length === 0) return null;

  const gameStart = new Date(game.commenceTime).getTime();
  const oddsGame = candidates.reduce((closest, candidate) => {
    const closestDiff = Math.abs(new Date(closest.commenceTime).getTime() - gameStart);
    const candidateDiff = Math.abs(new Date(candidate.commenceTime).getTime() - gameStart);
    return candidateDiff < closestDiff ? candidate : closest;
  });

  const outcomeName =
    side === "home" ? oddsGame.homeTeam : side === "away" ? oddsGame.awayTeam : side === "over" ? "Over" : "Under";

  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === marketKey);
    const outcome = market?.outcomes.find((o) => o.name === outcomeName);
    if (outcome) return outcome.price;
  }

  return null;
}


