"use client";

import Link from "next/link";
import type { OddsGame, ScoreGame } from "@/server/data/odds";
import { computeBoardPulse, type BoardPulseGame } from "@/lib/board-pulse";
import { easternDateKey } from "@/lib/dates";
import { LocalGameTime } from "@/components/local-game-time";
import { orderBoardGames, matchScoreToGame } from "@/components/live/live-scoreboard-ordering";
import { getTeamColor } from "@/lib/team-colors";
import { GamePicksExpander, type ExpanderPick } from "@/components/live/game-picks-expander";
import { TeamColorBar } from "@/components/live/team-color-bar";
import { BoardPulsePanel } from "@/components/live/board-pulse-panel";
import { useLiveScores } from "@/components/live/use-live-scores";

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
  boardPulseOdds,
  initialScores,
  matchedPicksByGame,
  showBoardPulse,
}: {
  activeSport: string;
  odds: OddsGame[];
  // The fixed full slate Board Pulse runs off (see live/page.tsx) - today's
  // scheduled games regardless of status, NOT the board's shrinking rendered
  // list. Distinct from `odds`, which also carries future-slate and carried-
  // over games and is what the visible board is built from.
  boardPulseOdds: OddsGame[];
  initialScores: ScoreGame[];
  matchedPicksByGame: ExpanderPick[][];
  showBoardPulse: boolean;
}) {
  const scores = useLiveScores(activeSport, initialScores);

  // Recomputed on every render (not memoized) since `scores` is client state
  // that changes on each poll tick - a game that goes live or finishes must
  // re-sort / drop off immediately, not just on the next navigation.
  // easternDateKey(new Date()) is re-evaluated here each render too, so the
  // "is this yesterday's game" boundary advances on its own for a tab left
  // open across midnight. See live-scoreboard-ordering.ts for both rules.
  const gamesWithScores = odds.map((game, gameIndex) => ({
    game,
    gameIndex,
    score: matchScoreToGame(scores, game),
  }));
  const sortedGames = orderBoardGames(gamesWithScores, easternDateKey(new Date()));

  // Built from the FIXED today-scoped slate (boardPulseOdds), NOT sortedGames -
  // orderBoardGames drops finished games from the board, and feeding that
  // shrinking list here made "expected upsets today" collapse through the day
  // (see live-scoreboard-ordering.ts's render-only note). matchScoreToGame
  // still resolves a final game's score from the same poll; it's just hidden
  // from the rendered board below.
  const boardPulseGames: BoardPulseGame[] = boardPulseOdds.map((game) => {
    const score = matchScoreToGame(scores, game);
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

          // Final games are filtered out upstream by orderBoardGames, so the
          // board only ever renders live or not-yet-started games here.
          const isLive = score?.status === "live";

          return (
            <div key={game.id} className="rounded-card bg-card p-4 shadow-soft transition-shadow hover:shadow-md">
              {/* LiveScoreboard only ever renders in Feed mode (live/page.tsx
                  gates it on !isGrid), so this link always carries an
                  explicit view=feed - the detail page's own "Back to Live"
                  link mirrors it back out so returning from a game doesn't
                  silently land on Grid's default. */}
              <Link href={"/live/" + game.id + "?sport=" + activeSport + "&view=feed"} className="block">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    <LocalGameTime
                      date={game.commenceTime}
                      options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
                    />
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
