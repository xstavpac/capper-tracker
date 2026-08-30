import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { sameEasternDay, easternDateKey, closestByTime, withinDateDriftDays } from "@/lib/dates";
import { isSportInSeason, oddsApiSportKey } from "@/lib/sport-seasons";
import { memoizeWithTtl, LIVE_SCORES_TTL_SECONDS } from "@/server/data/live-scores-cache";

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

// One entry per inning that has started. `runs` is null (not 0) for a half
// that hasn't been played yet - the schedule endpoint's linescore just omits
// the "runs" key on an in-progress/upcoming half, and collapsing that to 0
// would make "hasn't batted yet" indistinguishable from "batted and scored
// nothing," which situational reads like "scored first" depend on.
export type ScoreGameInning = {
  num: number;
  home: { runs: number } | null;
  away: { runs: number } | null;
};

export type ScoreGame = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  status: "preview" | "live" | "final";
  scores: { name: string; score: string }[] | null;
  commenceTime: string;
  // MLB-only (from the schedule endpoint's `hydrate=linescore`) - "Top"/
  // "Bottom"/"Middle"/"End" + an ordinal like "9th". Null for preview/final
  // games and for every ESPN-backed sport (innings are baseball-specific).
  inningHalf: string | null;
  inningOrdinal: string | null;
  // MLB-only, same `hydrate=linescore` payload as inningHalf/inningOrdinal -
  // populated for live and final games, null for preview and for every
  // ESPN-backed sport.
  innings: ScoreGameInning[] | null;
};

export const LIVE_SPORTS = [
  { key: "americanfootball_nfl", label: "NFL" },
  { key: "basketball_nba", label: "NBA" },
  { key: "baseball_mlb", label: "MLB" },
  { key: "icehockey_nhl", label: "NHL" },
  { key: "basketball_wnba", label: "WNBA" },
  { key: "americanfootball_ncaaf", label: "NCAAF" },
];

const BASE_URL = "https://api.the-odds-api.com/v4";

export async function getOddsForSport(sportKey: string): Promise<OddsGame[]> {
  // Every sport in LIVE_SPORTS used to hit the Odds API bulk endpoint every
  // day year-round, including months of pure off-season - the API charges
  // per markets x regions requested regardless of how many (or how few)
  // games come back, so this was pure waste. Checked first, before any DB
  // read/write, so an out-of-season sport never touches the cache table or
  // the network at all.
  if (!isSportInSeason(sportKey)) return [];

  const fetchDate = easternDateKey(new Date());

  const existing = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
  });
  if (existing) {
    const cachedGames = existing.data as unknown as OddsGame[];
    // Temporary diagnostic for the 2026-08-21 live-page-empty incident -
    // distinguishes "cache hit but the day's snapshot was empty" (e.g. the
    // 4am seed fetch itself failed and got written as [] - it shouldn't per
    // the empty-fetch-doesn't-write logic below, but this catches it if that
    // assumption is ever wrong) from "cache hit, genuinely has games."
    console.log(
      "[getOddsForSport] cache hit",
      JSON.stringify({ sportKey, fetchDate, gameCount: cachedGames.length })
    );
    return cachedGames;
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error("[getOddsForSport] no ODDS_API_KEY configured", JSON.stringify({ sportKey, fetchDate }));
    return [];
  }

  // Almost always sportKey itself - only differs during a sport's preseason
  // window, and only for a sport with a preseason-specific Odds API key
  // configured (NFL today, see SPORT_SEASON_CONFIG). The cache above and
  // everything below stays keyed on the app's own sportKey regardless -
  // this only changes which upstream listing gets fetched.
  const requestSportKey = oddsApiSportKey(sportKey);
  const url =
    BASE_URL +
    "/sports/" +
    requestSportKey +
    "/odds/?apiKey=" +
    apiKey +
    "&regions=us&markets=h2h,spreads,totals&oddsFormat=american";

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    // Temporary diagnostic for the 2026-08-21 live-page-empty incident -
    // this failure path previously returned [] with zero logging, making a
    // real outage indistinguishable from a legitimately empty slate. Body is
    // truncated (the-odds-api.com error responses are small JSON, but this
    // guards against ever logging something unexpectedly large) and the URL
    // is never logged as-is since it carries apiKey as a query param.
    const bodyText = await res.text().catch(() => "<unreadable body>");
    console.error(
      "[getOddsForSport] upstream fetch failed",
      JSON.stringify({
        sportKey,
        requestSportKey,
        fetchDate,
        status: res.status,
        statusText: res.statusText,
        body: bodyText.slice(0, 500),
      })
    );
    return [];
  }

  const raw = await res.json();
  const fetchedAt = new Date();
  const games: OddsGame[] = raw
    .map((g: any) => ({
      id: g.id,
      sportKey: g.sport_key,
      homeTeam: g.home_team,
      awayTeam: g.away_team,
      commenceTime: g.commence_time,
      bookmakers: g.bookmakers ?? [],
    }))
    // The whole point of caching once/day is to lock in pregame lines - but
    // that only holds if this is the day's first fetch AND it happens before
    // any of that day's games start. Neither is guaranteed: the scheduled
    // cron (see /api/cron/refresh-odds) is meant to win that race, but if
    // anything else (a dev session, a stray request) hits this first, mid-
    // game, the API returns *current* (in-play) prices for already-started
    // games - e.g. a -2400 moneyline on a team already up big late - which
    // would otherwise get cached as if it were the pregame line, permanently,
    // for the rest of the day. Excluding already-started games here means
    // worst case we cache nothing for them (fixable by the cron catching up
    // sportsbook-side next time), never a wrong number silently treated as
    // real - since this feeds real ROI/profit tracking, missing beats wrong.
    .filter((g: OddsGame) => new Date(g.commenceTime) > fetchedAt);
  // Deliberately no upper date bound here - this cache is shared by
  // consumers with genuinely different windows (the odds board wants
  // whatever the Odds API has posted, which for NFL is a full week at once;
  // grading/pregame-facts want today only; bulk-import wants today+tomorrow),
  // and starving the fetch itself to satisfy the narrowest of them silently
  // broke the others (e.g. NFL's odds board going empty days out from a
  // Sunday slate). Each consumer now applies its own window on top of this
  // full cache instead: grading.ts's deriveLedgerFields and pregame-
  // facts.ts's getPregameEventFacts both same-day-scope their own match
  // (with closestByTime disambiguation, same pattern as resolveOddsGame
  // below) precisely to guard the same-team-rematch risk this filter used to
  // paper over; the live ticker (live-ticker.ts) keeps its own same-day
  // display filter independently.

  await prisma.oddsSnapshot.upsert({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
    update: { data: games as any },
    create: { sportKey, fetchDate, data: games as any },
  });

  // Temporary diagnostic for the 2026-08-21 live-page-empty incident - a
  // "success" (res.ok) response that itself came back with rawCount 0 (or
  // every game already started, so the post-filter games.length is 0 while
  // the upstream actually returned some) is a different failure mode than
  // the upstream error case above, and was equally invisible before this.
  console.log(
    "[getOddsForSport] live fetch cached",
    JSON.stringify({ sportKey, requestSportKey, fetchDate, rawCount: raw.length, cachedCount: games.length })
  );

  return games;
}

// Yesterday's cached OddsSnapshot, read-only - never fetches, never writes.
// The Live tab uses this to carry a game that started last night and is
// still in progress after midnight onto today's board: getOddsForSport is
// keyed to today's Eastern date, so once the clock rolls over, a game whose
// commenceTime was "yesterday" is no longer in the list it returns, and a
// still-live game would otherwise just vanish (see LiveScoreboard, which
// drops these again the moment they go Final). Returns [] if last night's
// snapshot is missing - same "nothing to show" outcome as any other day
// with no cached odds.
export async function getYesterdayOddsForSport(sportKey: string): Promise<OddsGame[]> {
  const fetchDate = easternDateKey(new Date(Date.now() - 86400000));
  const snapshot = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
  });
  return snapshot ? (snapshot.data as unknown as OddsGame[]) : [];
}

// Runs periodically (see /api/cron/backfill-odds), well after the once-daily
// seed fetch above. That seed fetch locks in OddsSnapshot for the rest of
// the day the moment it succeeds - so a game whose sportsbook lines simply
// weren't posted yet when it ran (a doubleheader nightcap, a weather-
// rescheduled game, anything late) is silently absent from the cache with no
// other path to ever pick it up before the next day's seed fetch. This adds
// exactly those missing games and nothing else: it diffs a fresh API
// response against what's already cached today by the Odds API's own event
// id and only appends games not already present. Every already-cached game
// is left byte-for-byte untouched - in particular this must never refresh an
// already-cached game's price with a current/in-play one, same reason
// getOddsForSport excludes started games from its own fetch below.
export async function backfillOddsForSport(sportKey: string): Promise<{ added: number }> {
  if (!isSportInSeason(sportKey)) return { added: 0 };

  const fetchDate = easternDateKey(new Date());

  // Nothing to merge into - creating today's first snapshot is
  // getOddsForSport's job (via the seed cron, or a page load that beats it),
  // not this function's. Running the full fetch below without an existing
  // row would just duplicate that path for no benefit.
  const existing = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
  });
  if (!existing) return { added: 0 };

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { added: 0 };

  const existingGames = existing.data as unknown as OddsGame[];
  const existingIds = new Set(existingGames.map((g) => g.id));

  // Credit-cost guard: once every game already cached for today has started,
  // there's nothing left this function could add for today - it only ever
  // appends not-yet-started games (see the already-started filter below), so
  // a still-missing game that has ALSO already started is unrecoverable
  // either way, same "missing beats wrong" tradeoff as everywhere else in
  // this file. Skipping here avoids an API call - and its Odds API credit
  // cost (markets x regions, not free) - that's guaranteed to find nothing.
  // Only skips when there's at least one cached game for today AND all of
  // them have started: an empty todayGames list (e.g. the 4am seed fetch
  // found nothing posted yet) must NOT skip, since that's exactly the
  // "genuinely still missing" case this function exists to catch - the
  // original doubleheader-nightcap incident this was built for.
  const now = new Date();
  const todayGames = existingGames.filter((g) => easternDateKey(new Date(g.commenceTime)) === fetchDate);
  if (todayGames.length > 0 && todayGames.every((g) => new Date(g.commenceTime) <= now)) {
    return { added: 0 };
  }

  const requestSportKey = oddsApiSportKey(sportKey);
  const url =
    BASE_URL +
    "/sports/" +
    requestSportKey +
    "/odds/?apiKey=" +
    apiKey +
    "&regions=us&markets=h2h,spreads,totals&oddsFormat=american";

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return { added: 0 };

  const raw = await res.json();
  const fetchedAt = new Date();
  const freshGames: OddsGame[] = raw
    .map((g: any) => ({
      id: g.id,
      sportKey: g.sport_key,
      homeTeam: g.home_team,
      awayTeam: g.away_team,
      commenceTime: g.commence_time,
      bookmakers: g.bookmakers ?? [],
    }))
    // Identical pregame-only guarantee as getOddsForSport's own fetch - a
    // game already under way must never get captured at all here either, so
    // an in-play price can't sneak into the cache as if it were the pregame
    // line. A game that started before ANY fetch (seed or backfill) ever
    // saw it stays permanently missing - that's the existing, deliberate
    // "missing beats wrong" tradeoff, unchanged by this function.
    .filter((g: OddsGame) => new Date(g.commenceTime) > fetchedAt)
    // The raw endpoint has no date bound - it's whatever the API currently
    // has odds posted for, which by evening already includes tomorrow's
    // slate. getOddsForSport gets away without this filter because its one
    // fetch always runs at 4am ET, hours before any future day's lines are
    // posted - but this function runs all day, so without this it would
    // "backfill" every future day's entire slate into today's row on every
    // run. Confirmed live: an unfiltered run at ~8pm ET pulled in 16 of
    // tomorrow's games alongside the 1 real gap it was meant to fill.
    .filter((g: OddsGame) => easternDateKey(new Date(g.commenceTime)) === fetchDate);

  const missingGames = freshGames.filter((g) => !existingIds.has(g.id));
  if (missingGames.length === 0) return { added: 0 };

  await prisma.oddsSnapshot.update({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
    data: { data: [...existingGames, ...missingGames] as any },
  });

  return { added: missingGames.length };
}

export async function getMlbLiveScores(): Promise<ScoreGame[]> {
  const yesterday = easternDateKey(new Date(Date.now() - 86400000));
  const tomorrow = easternDateKey(new Date(Date.now() + 86400000));
  const url =
    "https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=" +
    yesterday +
    "&endDate=" +
    tomorrow +
    "&hydrate=linescore";

  // No per-fetch cache directive here on purpose: live-score caching is owned
  // by getLiveScoresForSport's wrapper (see live-scores-cache.ts) - a short
  // TTL layer that fetches once per sport per window and serves that to every
  // polling client. Setting no-store here as well would conflict with the
  // unstable_cache boundary that wrapper puts around this call.
  const res = await fetch(url);
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
      inningHalf: status === "live" ? (g.linescore?.inningState ?? null) : null,
      inningOrdinal: status === "live" ? (g.linescore?.currentInningOrdinal ?? null) : null,
      innings:
        status === "live" || status === "final"
          ? (g.linescore?.innings ?? []).map((i: any) => ({
              num: i.num,
              home: typeof i.home?.runs === "number" ? { runs: i.home.runs } : null,
              away: typeof i.away?.runs === "number" ? { runs: i.away.runs } : null,
            }))
          : null,
    };
  });
}

// Shared by every ESPN-backed score source (NBA, WNBA, ...) - ESPN's free
// public scoreboard endpoint (no key required, same "free/unauthenticated"
// pattern as MLB Stats API) has an identical response shape across sports,
// just a different URL path segment. This only covers full-game status/
// scores, enough for live display and full-game Moneyline/Spread/Total
// grading - first-half and touchdown-prop grading need the heavier
// per-event summary endpoint instead (see getNflGameFacts and
// getNflPlayerTdStats below, NFL-only for now).
async function getEspnScores(sportPath: string): Promise<ScoreGame[]> {
  const fmt = (d: Date) => easternDateKey(d).replace(/-/g, "");
  const yesterday = fmt(new Date(Date.now() - 86400000));
  const tomorrow = fmt(new Date(Date.now() + 86400000));
  const url =
    "https://site.api.espn.com/apis/site/v2/sports/" + sportPath + "/scoreboard?dates=" + yesterday + "-" + tomorrow;

  // Same as getMlbLiveScores: no per-fetch cache directive here - caching is
  // owned by getLiveScoresForSport's short-TTL wrapper (live-scores-cache.ts).
  const res = await fetch(url);
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
      inningHalf: null,
      inningOrdinal: null,
      innings: null,
    };
  });
}

export function getNbaLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("basketball/nba");
}

export function getWnbaLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("basketball/wnba");
}

export function getNflLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("football/nfl");
}

// Same shared ESPN scoreboard helper as every other ESPN-backed sport above,
// just a different sport path - confirmed live (real FBS week-1 coverage,
// same response shape) before adding this during the NCAAF ecosystem
// investigation.
export function getNcaafLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("football/college-football");
}

// Sports with a real score source wired up (see getLiveScoresForSport below).
// The rest of LIVE_SPORTS still get odds display, just no live score/badge,
// game resolution, or auto-grading yet - add a key here (and a case below)
// once a free score source is wired up for it.
export const RESOLVABLE_SPORT_KEYS = [
  "baseball_mlb",
  "basketball_nba",
  "basketball_wnba",
  "americanfootball_nfl",
  "americanfootball_ncaaf",
];

// Dispatches to the right free score source for a sport. Add a case here
// (and a getXLiveScores() above) when wiring up a new sport.
async function dispatchLiveScoresForSport(sportKey: string): Promise<ScoreGame[]> {
  if (sportKey === "baseball_mlb") return getMlbLiveScores();
  if (sportKey === "basketball_nba") return getNbaLiveScores();
  if (sportKey === "basketball_wnba") return getWnbaLiveScores();
  if (sportKey === "americanfootball_nfl") {
    // ESPN's scoreboard is free either way, but off-season it's just
    // preseason noise - gating it keeps preseason games out of live
    // display, catalog-import game resolution, and auto-grading alike,
    // not only the credit-costing Odds API side.
    if (!isSportInSeason(sportKey)) return [];
    return getNflLiveScores();
  }
  if (sportKey === "americanfootball_ncaaf") {
    // Same reasoning as NFL above - off-season (including spring games)
    // would otherwise leak into live display/game resolution/grading as
    // pure noise.
    if (!isSportInSeason(sportKey)) return [];
    return getNcaafLiveScores();
  }
  return [];
}

// Cross-instance layer: unstable_cache stores the parsed result in the
// Next.js Data Cache, which on Vercel is shared across every serverless
// instance - so one upstream fetch per sport per TTL serves the whole fleet.
// The result is small and the whole point is to be current-ish, so the TTL is
// short (LIVE_SCORES_TTL_SECONDS, default 15). Tagged so a manual purge is
// possible if ever needed.
//
// Outside a Next request/render context (bare scripts, the tsx acceptance
// tests) there is no incremental cache and unstable_cache rejects with an
// invariant - fall back to calling straight through in that case. Real
// traffic (route handlers, cron routes) always has the context.
function dataCachedLiveScores(sportKey: string): Promise<ScoreGame[]> {
  const run = unstable_cache(() => dispatchLiveScoresForSport(sportKey), ["live-scores", sportKey], {
    revalidate: LIVE_SCORES_TTL_SECONDS,
    tags: [`live-scores-${sportKey}`],
  });
  return run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("incrementalCache")) return dispatchLiveScoresForSport(sportKey);
    throw err;
  });
}

// Public entry point. memoizeWithTtl is the process-local layer in front of
// the Data Cache - see live-scores-cache.ts for why both exist.
export async function getLiveScoresForSport(sportKey: string): Promise<ScoreGame[]> {
  return memoizeWithTtl(`live-scores:${sportKey}`, () => dataCachedLiveScores(sportKey));
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

export type NflGameFacts = {
  // Q1+Q2 summed - same value the old getNflFirstHalfScore returned, for
  // grading 1st-half Moneyline/Spread/Total picks.
  firstHalf: { home: number; away: number } | null;
  // Per-quarter {home, away} score array (Q1..Q4, plus any OT periods), in
  // order - feeds NFL Game Pulse's leadingAtHalftime and trailingEntering4th
  // questions (see nfl-game-pulse-situations.ts). Persisted as
  // GameResult.quartersJson.
  quarters: { home: number; away: number }[] | null;
  // Every scoring play in the game, in chronological order, as {home, away}
  // running score snapshots (the score immediately after that play) - which
  // team scored on a given play is derivable from which number increased,
  // so team identity doesn't need to be captured separately. Empty array
  // (not null) for a genuine scoreless game; null only when ESPN didn't
  // return this field at all. Feeds scoredFirst and ledByDoubleDigits.
  // Persisted as GameResult.scoringPlaysJson.
  scoringPlays: { home: number; away: number }[] | null;
  // Turnovers (interceptions thrown + fumbles lost) per team, from ESPN's
  // boxscore team statistics. Feeds wonTurnoverBattle. Persisted as
  // GameResult.homeTurnovers/awayTurnovers.
  turnovers: { home: number; away: number } | null;
};

// Single fetch to ESPN's NFL summary endpoint - replaces the old
// getNflFirstHalfScore (which hit this same URL for Q1+Q2 alone) with
// everything persistFinalScores needs to capture for a finished NFL game in
// one round trip: first-half score (unchanged grading behavior), the full
// per-quarter linescore and scoring-play margin trail for NFL Game Pulse,
// and each team's turnover count. getNflPlayerTdStats below stays a
// separate fetch to this same endpoint deliberately - it's called
// independently at touchdown-prop GRADING time (resolveTouchdownProp, once
// per pending prop pick), not at this capture-time step, so folding it in
// here wouldn't actually eliminate a redundant call. Only call this once a
// game is Final - a still-in-progress game would report incomplete
// quarters/scoring plays, same caution as getMlbEarlyInningScores.
export async function getNflGameFacts(eventId: string): Promise<NflGameFacts | null> {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=" + eventId, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const competitors = data.header?.competitions?.[0]?.competitors ?? [];
  const home = competitors.find((c: any) => c.homeAway === "home");
  const away = competitors.find((c: any) => c.homeAway === "away");
  if (!home || !away) return null;

  // Each competitor's `linescores` entries only carry a `displayValue`
  // string (confirmed against real final games), no numeric `value` field,
  // so this parses it. Missing/empty entirely -> null (no usable checkpoint
  // at all) - a real finished NFL game always has at least 4 linescores, so
  // there's no legitimate "empty but valid" case to preserve here, unlike
  // scoringPlays below.
  const parseQuarterValues = (linescores: any[] | undefined): number[] | null => {
    if (!linescores || linescores.length === 0) return null;
    const values = linescores.map((l: any) => parseFloat(l?.displayValue ?? ""));
    return values.some((v) => Number.isNaN(v)) ? null : values;
  };
  const homeQuarterValues = parseQuarterValues(home.linescores);
  const awayQuarterValues = parseQuarterValues(away.linescores);

  let quarters: { home: number; away: number }[] | null = null;
  if (homeQuarterValues && awayQuarterValues && homeQuarterValues.length === awayQuarterValues.length) {
    quarters = homeQuarterValues.map((h, i) => ({ home: h, away: awayQuarterValues[i] }));
  }

  const firstHalf =
    quarters && quarters.length >= 2
      ? { home: quarters[0].home + quarters[1].home, away: quarters[0].away + quarters[1].away }
      : null;

  // Array.isArray, not a length/truthiness check - a genuinely scoreless
  // game (0-0) legitimately has an empty scoringPlays array, distinct from
  // ESPN not returning the field at all (null, "we don't have this data").
  const scoringPlays: { home: number; away: number }[] | null = Array.isArray(data.scoringPlays)
    ? data.scoringPlays.map((p: any) => ({ home: p.homeScore ?? 0, away: p.awayScore ?? 0 }))
    : null;

  const boxscoreTeams = data.boxscore?.teams ?? [];
  const homeBox = boxscoreTeams.find((t: any) => t.homeAway === "home");
  const awayBox = boxscoreTeams.find((t: any) => t.homeAway === "away");
  const findTurnovers = (team: any): number | null => {
    const stat = team?.statistics?.find((s: any) => s.name === "turnovers");
    const parsed = stat ? parseInt(stat.displayValue, 10) : NaN;
    return Number.isNaN(parsed) ? null : parsed;
  };
  const homeTurnovers = findTurnovers(homeBox);
  const awayTurnovers = findTurnovers(awayBox);
  const turnovers = homeTurnovers !== null && awayTurnovers !== null ? { home: homeTurnovers, away: awayTurnovers } : null;

  return { firstHalf, quarters, scoringPlays, turnovers };
}

// Same first-half-only linescores parsing getNflGameFacts above does for
// NFL (before that function grew quarters/scoringPlays/turnovers for Game
// Pulse), just the college-football summary endpoint instead - confirmed
// live against a real finished game (Ohio State 7-10-14-7, Penn State
// 0-14-0-0) during the NFL/NCAAF category-tile investigation: identical
// `competitors[].linescores[].displayValue` shape, so this is a straight
// copy with the URL path swapped, not a new parsing approach. Kept as its
// own function (not a shared helper taking a sport path) to match this
// file's own precedent of one function per sport rather than a generic
// dispatcher - see getNflGameFacts' comment for why only a Final game's
// linescores should ever be read here.
export async function getNcaafFirstHalfScore(eventId: string): Promise<{ home: number; away: number } | null> {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=" + eventId, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const competitors = data.header?.competitions?.[0]?.competitors ?? [];
  const home = competitors.find((c: any) => c.homeAway === "home");
  const away = competitors.find((c: any) => c.homeAway === "away");
  if (!home || !away) return null;

  const sumFirstHalf = (linescores: any[] | undefined): number | null => {
    if (!linescores || linescores.length < 2) return null;
    const q1 = parseFloat(linescores[0]?.displayValue ?? "");
    const q2 = parseFloat(linescores[1]?.displayValue ?? "");
    if (Number.isNaN(q1) || Number.isNaN(q2)) return null;
    return q1 + q2;
  };

  const homeFirstHalf = sumFirstHalf(home.linescores);
  const awayFirstHalf = sumFirstHalf(away.linescores);
  if (homeFirstHalf === null || awayFirstHalf === null) return null;

  return { home: homeFirstHalf, away: awayFirstHalf };
}

// Same first-half-only linescores parsing getNflGameFacts above does for
// NFL, just the NBA summary endpoint instead - confirmed live against two
// real finished games (PHI 109-97 ORL:
// linescores [28,31,20,30]/[24,31,19,23], summing to the real final score on
// both sides; GS 126-121 LAC: [22,31,30,43]/[31,30,28,32], same self-check)
// during the NBA chip-set investigation: identical
// `competitors[].linescores[].displayValue` shape as football, quarters
// instead of halves-of-quarters but still index [0]/[1] = Q1/Q2 = first
// half, so this is a straight copy with the URL path swapped, not a new
// parsing approach. An overtime game just has extra linescores entries past
// index 3, which sumFirstHalf never reads - doesn't affect this function.
export async function getNbaFirstHalfScore(eventId: string): Promise<{ home: number; away: number } | null> {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=" + eventId, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const competitors = data.header?.competitions?.[0]?.competitors ?? [];
  const home = competitors.find((c: any) => c.homeAway === "home");
  const away = competitors.find((c: any) => c.homeAway === "away");
  if (!home || !away) return null;

  const sumFirstHalf = (linescores: any[] | undefined): number | null => {
    if (!linescores || linescores.length < 2) return null;
    const q1 = parseFloat(linescores[0]?.displayValue ?? "");
    const q2 = parseFloat(linescores[1]?.displayValue ?? "");
    if (Number.isNaN(q1) || Number.isNaN(q2)) return null;
    return q1 + q2;
  };

  const homeFirstHalf = sumFirstHalf(home.linescores);
  const awayFirstHalf = sumFirstHalf(away.linescores);
  if (homeFirstHalf === null || awayFirstHalf === null) return null;

  return { home: homeFirstHalf, away: awayFirstHalf };
}

export type NflPlayerTdStats = {
  playerName: string;
  rushTds: number;
  recTds: number;
};

// Every player who appears anywhere in a finished NFL game's box score, with
// their rushing and receiving TD counts (0 if they have a stat line in that
// category but no TD there; genuinely absent from the map entirely if they
// don't appear in the box score at all, e.g. a name that doesn't match
// anyone who played). Scans every statistics category (not just rushing/
// receiving) so a player is still present with rushTds/recTds both 0 if
// they only show up elsewhere (e.g. a QB who only has a passing line) -
// callers use "found in this map" vs "not found at all" to tell a confident
// 0-TD grade apart from a name that couldn't be matched to anyone in the
// game (see gradeTouchdownProp in grading.ts). Confirmed against a real
// final game's response shape: each category has its own `labels` array and
// a `TD` column isn't always at the same index across categories, so the
// index is looked up per-category rather than hardcoded.
export async function getNflPlayerTdStats(eventId: string): Promise<NflPlayerTdStats[] | null> {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=" + eventId, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const teams = data.boxscore?.players ?? [];
  if (teams.length === 0) return null;

  const byPlayer = new Map<string, NflPlayerTdStats>();

  for (const team of teams) {
    for (const category of team.statistics ?? []) {
      const tdIndex = (category.labels ?? []).indexOf("TD");
      for (const athlete of category.athletes ?? []) {
        const name = athlete.athlete?.displayName;
        if (!name) continue;

        const entry = byPlayer.get(name) ?? { playerName: name, rushTds: 0, recTds: 0 };
        if (tdIndex !== -1) {
          const tdCount = parseInt(athlete.stats?.[tdIndex] ?? "0", 10) || 0;
          if (category.name === "rushing") entry.rushTds = tdCount;
          else if (category.name === "receiving") entry.recTds = tdCount;
        }
        byPlayer.set(name, entry);
      }
    }
  }

  return Array.from(byPlayer.values());
}

// How many Eastern calendar days a candidate game may sit from `referenceTime`
// (import time, normally) and still be accepted as the game a pick refers to.
// getLiveScoresForSport's feeds only span ~yesterday..tomorrow, so for a
// present-time import this rejects nothing they legitimately return - it's an
// explicit backstop for the case where a team's game today is missing from
// the feed (an ingestion gap - e.g. an FCS-vs-FCS college game ESPN's FBS
// scoreboard omits) but a DIFFERENT game for that same team, a week or more
// out, IS in the feed. Without the check that lone far-off game gets silently
// attached to the pick; a clean "couldn't match, add manually" is much safer
// than a wrong-game attach that then grades against the wrong result.
const MAX_RESOLVE_DATE_DRIFT_DAYS = 2;

function withinResolveWindow(commenceTime: string, referenceTime: Date): boolean {
  return withinDateDriftDays(new Date(commenceTime), referenceTime, MAX_RESOLVE_DATE_DRIFT_DAYS);
}

// Resolves a bare team nickname (e.g. "white sox", parsed from a capper's raw
// pick text) to the real game it refers to, using the yesterday/today/
// tomorrow schedule window for the given sport. Same-team matchups repeat
// every few days in a season (series/back-to-backs), so when a nickname
// matches more than one game we prefer a game on the same local calendar day
// as `referenceTime`, and within that, prefer one that hasn't finished yet -
// falling back to whichever candidate started closest to `referenceTime`.
// Every candidate is first constrained to MAX_RESOLVE_DATE_DRIFT_DAYS of
// `referenceTime` (see withinResolveWindow) so a lone far-future game can't
// be attached to a pick meant for a game that isn't in the feed.
export async function resolveGameForNickname(
  sportKey: string,
  nickname: string,
  referenceTime: Date = new Date()
): Promise<ScoreGame | null> {
  const games = await getLiveScoresForSport(sportKey);
  const candidates = games.filter(
    (g) =>
      (g.homeTeam.toLowerCase().endsWith(nickname) || g.awayTeam.toLowerCase().endsWith(nickname)) &&
      withinResolveWindow(g.commenceTime, referenceTime)
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sameDay = candidates.filter((g) => sameEasternDay(new Date(g.commenceTime), referenceTime));
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
    const teamsMatch =
      (home.endsWith(nicknameA) && away.endsWith(nicknameB)) ||
      (home.endsWith(nicknameB) && away.endsWith(nicknameA));
    return teamsMatch && withinResolveWindow(g.commenceTime, referenceTime);
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sameDay = candidates.filter((g) => sameEasternDay(new Date(g.commenceTime), referenceTime));
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

// Shared by findMarketPrice and findMarketTotalLine - resolves which
// odds-listed game (by team pair + closest commenceTime) a schedule-sourced
// game corresponds to, same repeat-matchup handling as matchScoreToGame.
async function resolveOddsGame(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string }
): Promise<OddsGame | null> {
  const oddsGames = await getOddsForSport(sportKey);
  const candidates = oddsGames.filter((g) => g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam);
  if (candidates.length === 0) return null;

  const gameStart = new Date(game.commenceTime).getTime();
  return closestByTime(candidates, (g) => new Date(g.commenceTime).getTime(), gameStart);
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

  const oddsGame = await resolveOddsGame(sportKey, game);
  if (!oddsGame) return null;

  const outcomeName =
    side === "home" ? oddsGame.homeTeam : side === "away" ? oddsGame.awayTeam : side === "over" ? "Over" : "Under";

  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === marketKey);
    const outcome = market?.outcomes.find((o) => o.name === outcomeName);
    if (outcome) return outcome.price;
  }

  return null;
}

// Looks up the real market TOTAL LINE (the point number, e.g. 8.5 - not the
// price) for a resolved game, so a TOTAL pick whose raw bet text had no
// parseable number at all (missing or garbled, e.g. "Cubs under a") can have
// today's real line proposed for the user's confirmation instead of staying
// permanently ungradeable. Never used to override a number the capper
// actually specified - see previewMissingTotalLines, the only caller.
export async function findMarketTotalLine(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  side: "over" | "under"
): Promise<number | null> {
  const oddsGame = await resolveOddsGame(sportKey, game);
  if (!oddsGame) return null;

  const outcomeName = side === "over" ? "Over" : "Under";

  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === "totals");
    const outcome = market?.outcomes.find((o) => o.name === outcomeName);
    if (outcome?.point !== undefined) return outcome.point;
  }

  return null;
}


