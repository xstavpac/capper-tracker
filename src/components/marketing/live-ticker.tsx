"use client";

import { useEffect, useState } from "react";
import type { TickerGame } from "@/server/data/live-ticker";
import { formatEastern, closestByTime } from "@/lib/dates";

// Deliberately lighter than the authenticated live page's 25s poll
// (LIVE_POLL_INTERVAL_MS in live-scoreboard.tsx) - a game's score
// realistically changes at most every few minutes either way, but this
// endpoint is PUBLIC (reachable by any anonymous visitor, and crawlers,
// with no session/rate-limit to bound it the way every other polled
// endpoint in this app has), and the ticker's job is to read as "genuinely
// live," not to be a real-time scoreboard - 45s keeps it visibly moving
// without adding avoidable load to a page nobody has to be logged in to hit.
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

function gameState(game: TickerGame): string {
  if (game.status === "preview") {
    return formatEastern(new Date(game.commenceTime), { hour: "numeric", minute: "2-digit" });
  }
  if (game.status === "final") return "Final";
  if (game.sportLabel === "MLB" && game.inningHalf && game.inningOrdinal) {
    return game.inningHalf + " " + game.inningOrdinal;
  }
  return "Live";
}

function Segment({ game }: { game: TickerGame }) {
  const isLive = game.status === "live";
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-l-4 bg-white/5 px-4 py-3"
      style={{ borderColor: game.accentColor }}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-300">{game.sportLabel}</span>
      <div className="flex items-center gap-1.5 text-sm font-medium text-white">
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
        {gameState(game)}
      </span>
    </div>
  );
}

export function LiveTicker({ initialGames }: { initialGames: TickerGame[] }) {
  const [games, setGames] = useState(initialGames);

  useEffect(() => {
    setGames(initialGames);
  }, [initialGames]);

  useEffect(() => {
    if (games.length === 0) return;
    const sportKeys = Array.from(new Set(initialGames.map((g) => g.sportKey)));
    let cancelled = false;

    const poll = async () => {
      try {
        const results = await Promise.all(
          sportKeys.map(async (sportKey) => {
            const res = await fetch(`/api/public/live-scores?sport=${encodeURIComponent(sportKey)}`, {
              cache: "no-store",
            });
            if (!res.ok) return [] as ScoreUpdate[];
            const data = await res.json();
            return Array.isArray(data.scores) ? (data.scores as ScoreUpdate[]) : [];
          })
        );
        if (cancelled) return;
        const updates = results.flat();
        setGames((prev) =>
          prev.map((game) => {
            const update = matchUpdate(updates, game);
            if (!update) return game;
            return {
              ...game,
              status: update.status,
              homeScore: parseScore(update, game.homeTeam),
              awayScore: parseScore(update, game.awayTeam),
              inningHalf: update.inningHalf,
              inningOrdinal: update.inningOrdinal,
            };
          })
        );
      } catch {
        // Transient network hiccup - next tick tries again.
      }
    };

    const interval = setInterval(poll, TICKER_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sportKeys is derived from initialGames, which only ever changes on a fresh SSR (not something this ticker itself needs to re-derive every render)
  }, [initialGames]);

  if (games.length === 0) return null;

  return (
    <div className="w-full overflow-hidden bg-brand-900 py-1" aria-label="Live scores across today's games">
      <div className="flex w-max animate-ticker-scroll motion-reduce:animate-none">
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
