"use client";

import { useEffect, useState } from "react";
import type { ScoreGame } from "@/server/data/odds";

// Extracted from live-scoreboard.tsx as a pure refactor (behavior unchanged)
// so Advanced Live can poll the exact same scores feed instead of running a
// second interval. This is the same hand-rolled setInterval loop that
// existed inline before the extraction - NOT migrated to useSafePoll
// (src/lib/use-safe-poll.ts), the app's sanctioned polling hook, since that
// would add backoff/visibility-pause behavior Standard Live doesn't have
// today and this extraction is scoped to be a pure lift, not a behavior
// change. Migrating both Standard and Advanced Live's live-scores poll onto
// useSafePoll is a reasonable follow-up, just a separate, deliberate change.
//
// The interval itself balances "genuinely live" against Vercel function
// invocations - a game state (score, inning) realistically changes at most
// every few minutes, so polling faster than this would just be extra cost
// for no visible benefit.
const LIVE_POLL_INTERVAL_MS = 25000;

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

  return scores;
}
