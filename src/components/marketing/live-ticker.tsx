"use client";

import { useEffect, useState } from "react";
import type { TickerGame } from "@/server/data/live-ticker";
import { closestByTime } from "@/lib/dates";
import { LocalGameTime } from "@/components/local-game-time";
import { useSafePoll } from "@/lib/use-safe-poll";

// Deliberately lighter than the authenticated live page's 25s poll
// (LIVE_POLL_INTERVAL_MS in live-scoreboard.tsx) - a game's score
// realistically changes at most every few minutes either way, and the
// ticker's job is to read as "genuinely live," not to be a real-time
// scoreboard - 45s keeps it visibly moving without adding avoidable load.
// The endpoint it polls is public and CDN-cached (s-maxage=15).
const TICKER_POLL_INTERVAL_MS = 45000;

type ScoreUpdate = {
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  status: "preview" | "live" | "final";
  scores: { name: string; score: string }[] | null;
  inningHalf: string | null;
  inningOrdinal: string | null;
};

// Same team-pair-plus-closest-commenceTime matching odds.ts's
// matchScoreToGame does server-side, adapted to merge fresh score polls into
// the ticker's own flattened TickerGame shape instead of raw OddsGame/
// ScoreGame - duplicated rather than imported for the same reason
// live-scoreboard.tsx duplicates it: server/data/odds.ts has a module-level
// prisma import that must never reach a "use client" bundle, even
// transitively.
function matchUpdate(updates: ScoreUpdate[], game: TickerGame): ScoreUpdate | undefined {
  const candidates = updates.filter((u) => u.homeTeam === game.homeTeam && u.awayTeam === game.awayTeam);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const gameStart = new Date(game.commenceTime).getTime();
  return closestByTime(candidates, (u) => new Date(u.commenceTime).getTime(), gameStart);
}

function parseScore(update: ScoreUpdate | undefined, teamName: string): number | null {
  const raw = update?.scores?.find((s) => s.name === teamName)?.score;
  if (raw === undefined) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

type TickerScoresResponse = { scoresBySport: Record<string, ScoreUpdate[]> };

async function fetchTickerScores(signal: AbortSignal): Promise<TickerScoresResponse> {
  const res = await fetch("/api/public/ticker-scores", { signal });
  if (!res.ok) throw new Error(`ticker-scores ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.scoresBySport !== "object" || data.scoresBySport === null) {
    throw new Error("ticker-scores: malformed response");
  }
  return data as TickerScoresResponse;
}

// A game only matches updates from its OWN sport's array - a sport missing
// from the response (its upstream failed) leaves those games untouched.
function applyScoreUpdates(games: TickerGame[], scoresBySport: Record<string, ScoreUpdate[]>): TickerGame[] {
  return games.map((game) => {
    const sportScores = scoresBySport[game.sportKey];
    if (!Array.isArray(sportScores)) return game;
    const update = matchUpdate(sportScores, game);
    if (!update) return game;
    return {
      ...game,
      status: update.status,
      homeScore: parseScore(update, game.homeTeam),
      awayScore: parseScore(update, game.awayTeam),
      inningHalf: update.inningHalf,
      inningOrdinal: update.inningOrdinal,
    };
  });
}

function GameState({ game }: { game: TickerGame }) {
  if (game.status === "preview") {
    return <LocalGameTime date={game.commenceTime} options={{ hour: "numeric", minute: "2-digit" }} />;
  }
  if (game.status === "final") return <>Final</>;
  if (game.sportLabel === "MLB" && game.inningHalf && game.inningOrdinal) {
    return (
      <>
        {game.inningHalf} {game.inningOrdinal}
      </>
    );
  }
  return <>Live</>;
}

function Segment({ game }: { game: TickerGame }) {
  const isLive = game.status === "live";
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-l-4 bg-white/5 px-3 py-2"
      style={{ borderColor: game.accentColor }}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-300">{game.sportLabel}</span>
      <div className="flex items-center gap-1.5 text-xs font-medium text-white">
        <span>{game.awayShort}</span>
        <span className="text-blue-300">
          {game.awayScore ?? ""}
          {game.status !== "preview" && " - "}
          {game.homeScore ?? ""}
        </span>
        <span>{game.homeShort}</span>
      </div>
      <span className="flex items-center gap-1.5 text-xs text-blue-200">
        {isLive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />}
        <GameState game={game} />
      </span>
    </div>
  );
}

export function LiveTicker({ initialGames }: { initialGames: TickerGame[] }) {
  const [games, setGames] = useState(initialGames);

  useEffect(() => {
    setGames(initialGames);
  }, [initialGames]);

  // One combined request per poll (all sports), through the shared hardened
  // poll hook: it pauses while the tab is hidden, refreshes right away when
  // the tab becomes visible again, and backs off on failures.
  const { data: polled } = useSafePoll<TickerScoresResponse>({
    fetcher: fetchTickerScores,
    enabled: initialGames.length > 0,
    intervalMs: TICKER_POLL_INTERVAL_MS,
  });

  useEffect(() => {
    if (!polled) return;
    setGames((prev) => applyScoreUpdates(prev, polled.scoresBySport));
  }, [polled]);

  if (games.length === 0) return null;

  // Duration scales with game count so per-segment dwell time stays roughly
  // constant - the track always scrolls exactly 50% of its own width (see
  // ticker-scroll's keyframes in tailwind.config.ts), and that width grows
  // with games.length, so a fixed duration would make a heavy game day
  // visibly faster than a light one. 45s floor keeps light days from
  // scrolling too slowly to read as "live."
  const scrollDurationSeconds = Math.max(45, games.length * 6);

  return (
    <div className="w-full overflow-hidden bg-brand-900 py-1" aria-label="Live scores across today's games">
      <div
        className="flex w-max animate-ticker-scroll motion-reduce:animate-none"
        style={{ animationDuration: `${scrollDurationSeconds}s` }}
      >
        {[0, 1].map((copy) => (
          <div key={copy} className="flex" aria-hidden={copy === 1}>
            {games.map((game) => (
              <Segment key={copy + "-" + game.id} game={game} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
