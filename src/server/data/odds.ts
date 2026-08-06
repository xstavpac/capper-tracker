import { prisma } from "@/lib/prisma";

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


