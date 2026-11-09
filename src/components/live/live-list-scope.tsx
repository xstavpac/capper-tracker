"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { resolveShowAll, type ListScopeState } from "@/lib/live-list-scope";

// The one "See more" toggle shared by Grid's list, Feed's list and the category panel (siblings
// on /live, so the state lives in a provider next to LiveGameJumpProvider). Collapsed = today's
// and live games; expanded = the whole lookahead window. See orderBoardGames' `todayOnly`.
type LiveListScope = { showAll: boolean; setShowAll: (next: boolean) => void };

const NOT_MOUNTED: LiveListScope = { showAll: false, setShowAll: () => {} };

const LiveListScopeContext = createContext<LiveListScope>(NOT_MOUNTED);

export function LiveListScopeProvider({
  sportKey,
  initialShowAll,
  children,
}: {
  sportKey: string;
  // True when the request deep-linked to a game the collapsed list hides (resolveInitialScope).
  initialShowAll: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<ListScopeState>({ sportKey, showAll: initialShowAll });
  const showAll = resolveShowAll(state, sportKey);
  const setShowAll = useCallback((next: boolean) => setState({ sportKey, showAll: next }), [sportKey]);
  const value = useMemo(() => ({ showAll, setShowAll }), [showAll, setShowAll]);
  return <LiveListScopeContext.Provider value={value}>{children}</LiveListScopeContext.Provider>;
}

// Outside a provider (no board mounted) the list reads as collapsed and the setter does nothing.
export function useLiveListScope(): LiveListScope {
  return useContext(LiveListScopeContext);
}

// The "See more" / "Show fewer" button under a game list. Renders nothing when the collapsed
// list hides nothing (hiddenCount 0), so a league with only today's games never shows it.
export function SeeMoreGamesButton({ hiddenCount, className }: { hiddenCount: number; className?: string }) {
  const { showAll, setShowAll } = useLiveListScope();
  if (hiddenCount <= 0) return null;
  return (
    <button
      type="button"
      onClick={() => setShowAll(!showAll)}
      aria-expanded={showAll}
      className={
        "w-full rounded-xl border border-[#E1E7FA] bg-white px-3 py-2.5 text-center text-[13px] font-semibold text-brand-700 transition-colors hover:border-brand-300 dark:border-border dark:bg-card dark:text-brand-300 dark:hover:border-brand-500/60 " +
        (className ?? "")
      }
    >
      {showAll ? "Show fewer games" : "See more (" + hiddenCount + " later game" + (hiddenCount === 1 ? "" : "s") + ")"}
    </button>
  );
}
