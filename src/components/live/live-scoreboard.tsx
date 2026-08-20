"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { OddsGame, ScoreGame } from "@/server/data/odds";
import type { GamePulseResult } from "@/server/data/game-pulse";
import { computeBoardPulse, type BoardPulseGame } from "@/lib/board-pulse";
import { formatEastern, closestByTime } from "@/lib/dates";
import { getTeamColor } from "@/lib/team-colors";
import { GamePicksExpander, type ExpanderPick } from "@/components/live/game-picks-expander";
import { GamePulseBadge } from "@/components/live/game-pulse-badge";
import { TeamColorBar } from "@/components/live/team-color-bar";
import { BoardPulsePanel } from "@/components/live/board-pulse-panel";

// The /api/live/scores route attaches this alongside every ScoreGame (null
// for anything not MLB-and-live - see attachGamePulse in
// server/data/game-pulse.ts) - not part of ScoreGame itself since grading
// and other ScoreGame consumers have no use for it.
type ScoreGameWithPulse = ScoreGame & { pulse: GamePulseResult | null };

// Duplicated from server/data/odds.ts rather than imported - that module has
// a module-level prisma import, which a "use client" component must never
// pull in even transitively (odds.ts itself is fine server-side; the risk is
// only in crossing into the client bundle).
function matchScoreToGame(
  scores: ScoreGameWithPulse[],
  game: { homeTeam: string; awayTeam: string; commenceTime: string }
): ScoreGameWithPulse | undefined {
  const candidates = scores.filter((s) => s.homeTeam === game.homeTeam && s.awayTeam === game.awayTeam);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const gameStart = new Date(game.commenceTime).getTime();
  return closestByTime(candidates, (s) => new Date(s.commenceTime).getTime(), gameStart);
}

// Balances "genuinely live" against Vercel function invocations - a game
// state (score, inning) realistically changes at most every few minutes, so
// polling faster than this would just be extra cost for no visible benefit.
const LIVE_POLL_INTERVAL_MS = 25000;

function formatOdds(price: number) {
  return price > 0 ? "+" + price : String(price);
}

function findMarket(bookmaker: OddsGame["bookmakers"][number], key: string) {
  return bookmaker?.markets?.find((m) => m.key === key);
}

// Whichever side has the lower (more negative) moneyline price is favored -
// null for a genuine pick-em or if either side's price is missing.
function favoriteSide(homePrice: number | null, awayPrice: number | null): "home" | "away" | null {
  if (homePrice === null || awayPrice === null || homePrice === awayPrice) return null;
  return homePrice < awayPrice ? "home" : "away";
}

export function LiveScoreboard({
  activeSport,
  odds,
  initialScores,
  matchedPicksByGame,
  showBoardPulse,
}: {
  activeSport: string;
  odds: OddsGame[];
  initialScores: ScoreGameWithPulse[];
  matchedPicksByGame: ExpanderPick[][];
  showBoardPulse: boolean;
}) {
  const [scores, setScores] = useState(initialScores);

  // Odds/matched-picks reset on navigation (sport tab switch, filters) via
  // the key prop this component is mounted with (see live/page.tsx) - this
  // just keeps score state in sync with a fresh server-rendered initial
  // snapshot on that same reset, so switching sports doesn't show the
  // previous tab's scores for a moment before the first poll lands.
  useEffect(() => {
    setScores(initialScores);
  }, [initialScores]);

  useEffect(() => {
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/live/scores?sport=${encodeURIComponent(activeSport)}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.scores)) setScores(data.scores);
      } catch {
        // Transient network hiccup - next tick tries again, no need to
        // surface this as an error for a background refresh.
      }
    }, LIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeSport]);

  // Live games first, then soonest-starting first - a currently-live game
  // (however late it started) is the one a user opening this page actually
  // cares about most, and burying it below not-yet-started games sorted
  // purely by start time (the previous, unsorted-array-order behavior) reads
  // as broken - confirmed against a real case where an in-progress Cubs/
  // White Sox game (1:11 PM start) rendered below three not-yet-started
  // games. Recomputed on every render (not memoized) since `scores` is
  // client state that changes on each poll tick - a game that goes live or
  // finishes must re-sort immediately, not just on the next navigation.
  const gamesWithScores = odds.map((game, gameIndex) => ({
    game,
    gameIndex,
    score: matchScoreToGame(scores, game),
  }));
  const sortedGames = [...gamesWithScores].sort((a, b) => {
    const aLive = a.score?.status === "live";
    const bLive = b.score?.status === "live";
    if (aLive !== bLive) return aLive ? -1 : 1;
    return new Date(a.game.commenceTime).getTime() - new Date(b.game.commenceTime).getTime();
  });

  const boardPulseGames: BoardPulseGame[] = gamesWithScores.map(({ game, score }) => {
    const homePrice = findMarketAcrossBooks(game, "h2h")?.outcomes.find((o) => o.name === game.homeTeam)?.price ?? null;
    const awayPrice = findMarketAcrossBooks(game, "h2h")?.outcomes.find((o) => o.name === game.awayTeam)?.price ?? null;
    const totalLine = findMarketAcrossBooks(game, "totals")?.outcomes.find((o) => o.name === "Over")?.point ?? null;

    const homeScore = parseScore(score, game.homeTeam);
    const awayScore = parseScore(score, game.awayTeam);

    return {
      id: game.id,
      status: score?.status ?? "preview",
      homeScore,
      awayScore,
      inningHalf: score?.inningHalf ?? null,
      inningOrdinal: score?.inningOrdinal ?? null,
      favorite: favoriteSide(homePrice, awayPrice),
      totalLine,
    };
  });
  const boardPulseStats = computeBoardPulse(boardPulseGames);

  return (
    <div>
      {showBoardPulse && <BoardPulsePanel stats={boardPulseStats} />}

      <div className="space-y-3">
        {sortedGames.map(({ game, gameIndex, score }) => {
          const book = game.bookmakers[0];
          const matchedPicks = matchedPicksByGame[gameIndex];

          const h2h = findMarketAcrossBooks(game, "h2h");
          const spreads = findMarketAcrossBooks(game, "spreads");
          const totals = findMarketAcrossBooks(game, "totals");

          const homeH2h = h2h?.outcomes.find((o) => o.name === game.homeTeam);
          const awayH2h = h2h?.outcomes.find((o) => o.name === game.awayTeam);
          const homeSpread = spreads?.outcomes.find((o) => o.name === game.homeTeam);
          const awaySpread = spreads?.outcomes.find((o) => o.name === game.awayTeam);
          const over = totals?.outcomes.find((o) => o.name === "Over");

          const isLive = score?.status === "live";
          const isFinal = score?.status === "final";

          return (
            <div key={game.id} className="rounded-card bg-card p-4 shadow-soft transition-shadow hover:shadow-md">
              <Link href={"/live/" + game.id + "?sport=" + activeSport} className="block">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    {formatEastern(new Date(game.commenceTime), {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                    {book && " - " + book.title}
                  </div>
                  {isLive && (
                    <span className="flex items-center gap-1.5">
                      {score?.inningHalf && score?.inningOrdinal && (
                        <span className="text-xs text-muted-foreground">
                          {score.inningHalf} {score.inningOrdinal}
                        </span>
                      )}
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-500/15 dark:text-red-400">LIVE</span>
                    </span>
                  )}
                  {isFinal && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">FINAL</span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex items-center justify-between">
                    <span className="flex min-w-0 items-center gap-2">
                      <TeamColorBar color={getTeamColor(activeSport, game.awayTeam)} />
                      <span className="truncate text-sm font-medium">{game.awayTeam}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {score?.scores?.find((s) => s.name === game.awayTeam)?.score ?? ""}
                    </span>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {awayH2h && "ML " + formatOdds(awayH2h.price)}
                    {awaySpread && " - " + (awaySpread.point! > 0 ? "+" : "") + awaySpread.point}
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="flex min-w-0 items-center gap-2">
                      <TeamColorBar color={getTeamColor(activeSport, game.homeTeam)} />
                      <span className="truncate text-sm font-medium">{game.homeTeam}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {score?.scores?.find((s) => s.name === game.homeTeam)?.score ?? ""}
                    </span>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {homeH2h && "ML " + formatOdds(homeH2h.price)}
                    {homeSpread && " - " + (homeSpread.point! > 0 ? "+" : "") + homeSpread.point}
                  </div>
                </div>

                {over && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Total: O/U {over.point} ({formatOdds(over.price)})
                  </div>
                )}
              </Link>

              <GamePulseBadge pulse={score?.pulse ?? null} />
              <GamePicksExpander picks={matchedPicks} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function findMarketAcrossBooks(game: OddsGame, key: string) {
  for (const b of game.bookmakers) {
    const m = findMarket(b, key);
    if (m) return m;
  }
  return undefined;
}

function parseScore(score: ScoreGame | undefined, teamName: string): number | null {
  const raw = score?.scores?.find((s) => s.name === teamName)?.score;
  if (raw === undefined) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}
