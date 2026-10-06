"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { gradeDuePicksAction } from "@/server/actions/grade-due-picks";

// How long one browser tab waits before asking again for the SAME set of
// gradeable picks. A set that could not be graded (e.g. a market the grader
// does not support yet) would otherwise re-ask on every navigation.
const SAME_SET_RETRY_MS = 60_000;
const STORAGE_KEY = "grade-due-picks:last";

function recentlyAsked(dueKey: string): boolean {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const last = JSON.parse(raw) as { key?: string; at?: number };
    return last.key === dueKey && typeof last.at === "number" && Date.now() - last.at < SAME_SET_RETRY_MS;
  } catch {
    return false;
  }
}

function rememberAsked(dueKey: string) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ key: dueKey, at: Date.now() }));
  } catch {
    // Storage unavailable (private mode, blocked): just ask again next time.
  }
}

// Mounted by /picks and /live/[gameId] only when the page loaded a pending pick
// whose game is already over (lib/gradeable-picks.ts). Grades after paint and
// refreshes the page only if a status actually changed - the render itself no
// longer waits on grading. Renders nothing.
//
// Runs once per distinct gradeable set (dueKey): the refresh it triggers
// re-renders the page with those picks graded, which changes or empties the
// set, so it cannot loop.
export function GradeDuePicks({ sportKeys, dueKey }: { sportKeys: string[]; dueKey: string }) {
  const router = useRouter();
  const sportKeysKey = sportKeys.join(",");

  useEffect(() => {
    if (!dueKey || recentlyAsked(dueKey)) return;
    let cancelled = false;
    rememberAsked(dueKey);
    gradeDuePicksAction(sportKeysKey.split(","))
      .then(({ graded }) => {
        if (!cancelled && graded > 0) router.refresh();
      })
      .catch(() => {
        // Best-effort, as grading on view has always been: the cron grades it.
      });
    return () => {
      cancelled = true;
    };
  }, [dueKey, sportKeysKey, router]);

  return null;
}
