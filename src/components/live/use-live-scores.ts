"use client";

import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";
import type { ScoreGame } from "@/server/data/odds";
import { useSafePoll } from "@/lib/use-safe-poll";

// Extracted from live-scoreboard.tsx as a pure refactor so Grid Live can poll
// the exact same scores feed instead of running a second interval. Polls
// through useSafePoll (src/lib/use-safe-poll.ts), the app's sanctioned polling
// hook: no fetches while the tab is hidden, an immediate refresh when it
// becomes visible again, backed-off retries on failure, and a stop after
// repeated failures (the hand-rolled setInterval it replaced did none of
// these, so a background tab polled all day).
//
// The interval itself balances "genuinely live" against Vercel function
// invocations - a game state (score, inning) realistically changes at most
// every few minutes, so polling faster than this would just be extra cost
// for no visible benefit.
export const LIVE_POLL_INTERVAL_MS = 25000;

// The fetch useSafePoll runs each tick: throws on a non-2xx or a malformed body
// so the hook counts it as a failure (and backs off) rather than treating it as
// a successful empty poll.
export async function fetchLiveScores(activeSport: string, signal: AbortSignal): Promise<ScoreGame[]> {
  const res = await fetch(`/api/live/scores?sport=${encodeURIComponent(activeSport)}`, { cache: "no-store", signal });
  if (!res.ok) throw new Error("live scores " + res.status);
  const data = await res.json();
  if (!Array.isArray(data.scores)) throw new Error("live scores: no scores array");
  return data.scores;
}

export function useLiveScores(activeSport: string, initialScores: ScoreGame[]): ScoreGame[] {
  const [scores, setScores] = useState(initialScores);

  // Resets on navigation (sport tab switch, filters) via the key prop the
  // caller is mounted with - this just keeps score state in sync with a
  // fresh server-rendered initial snapshot on that same reset, so switching
  // sports doesn't show the previous tab's scores for a moment before the
  // first poll lands.
  useEffect(() => {
    setScores(initialScores);
  }, [initialScores]);

  const { data: polled } = useSafePoll<ScoreGame[]>({
    fetcher: (signal) => fetchLiveScores(activeSport, signal),
    enabled: true,
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });
  useEffect(() => {
    if (polled) setScores(polled);
  }, [polled]);

  return scores;
}

// One poll for the whole /live page. live/page.tsx mounts this once around the
// category panel and the board, so the panel's slate counts and the board's
// cards read the same scores on the same tick instead of each running its own
// interval.
const LiveScoresContext = createContext<ScoreGame[] | null>(null);

export function LiveScoresProvider({
  activeSport,
  initialScores,
  children,
}: {
  activeSport: string;
  initialScores: ScoreGame[];
  children: ReactNode;
}) {
  const scores = useLiveScores(activeSport, initialScores);
  return createElement(LiveScoresContext.Provider, { value: scores }, children);
}

export function useSharedLiveScores(): ScoreGame[] {
  const scores = useContext(LiveScoresContext);
  if (scores === null) throw new Error("useSharedLiveScores must be used inside LiveScoresProvider");
  return scores;
}

// For the category panel, which also renders when no board (and so no
// provider, and no poll) is mounted: null means "no board on the page".
export function useSharedLiveScoresIfAny(): ScoreGame[] | null {
  return useContext(LiveScoresContext);
}
