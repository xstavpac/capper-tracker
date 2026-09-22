"use client";

// The Parlay Pool: client-side state for the Parlay Generator's simplest
// construction mode (My Picks - see /parlay). Deliberately client-only, not
// a DB table - unlike ParlayBet/Leg (server/data/parlays.ts), which record a
// CAPPER's own already-placed parlay for grading/record-keeping, this pool
// is the user's own in-progress selection of picks to combine into a slip.
// Nothing here is graded or tied to a capper's record.
//
// One provider (mounted in (app)/layout.tsx, alongside ThemeProvider) covers
// every page, so the pool and any in-progress "add mode" selection survive a
// client-side nav between /live and /parlay without a remount. It's also
// persisted to localStorage (scoped by userId) purely so an accidental
// refresh doesn't silently wipe a slip the user was still building - the
// pool is never read or written anywhere else, so there's no server state to
// go stale against.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

export type PooledPick = ExpanderPick;

const MLB_LEAGUE_NAME = "MLB";

type PersistedState = {
  pool: PooledPick[];
  leagueScope: Record<string, boolean>;
  legCount: number;
};

type ParlayPoolContextValue = {
  pool: PooledPick[];
  isInPool: (pickId: string) => boolean;
  removeFromPool: (pickId: string) => void;

  addMode: boolean;
  checkedPicks: Map<string, PooledPick>;
  enterAddMode: () => void;
  toggleChecked: (pick: PooledPick) => void;
  confirmAdd: () => void;
  discardAdd: () => void;

  leaguesInPool: string[];
  isLeagueInScope: (league: string) => boolean;
  toggleLeague: (league: string) => void;

  legCount: number;
  setLegCount: (n: number) => void;
  maxLegCount: number;
};

const ParlayPoolContext = createContext<ParlayPoolContextValue | null>(null);

function storageKey(userId: string) {
  return "parlay-pool:" + userId;
}

export function ParlayPoolProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const [pool, setPool] = useState<PooledPick[]>([]);
  const [leagueScope, setLeagueScope] = useState<Record<string, boolean>>({});
  const [legCount, setLegCountState] = useState(2);
  const [addMode, setAddMode] = useState(false);
  const [checkedPicks, setCheckedPicks] = useState<Map<string, PooledPick>>(new Map());
  // Guards the persist effect below - without it, that effect's own first
  // run (on mount, before hydration below has applied) fires with the
  // empty initial state and immediately overwrites a real saved pool with
  // {pool: []}, wiping it out before it's ever read back.
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage once per userId (e.g. a different account
  // signing in on the same browser gets its own, empty pool rather than
  // inheriting the previous user's). addMode/checkedPicks are deliberately
  // NOT persisted - that's in-progress UI state, not a saved selection.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey(userId));
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState;
        setPool(parsed.pool ?? []);
        setLeagueScope(parsed.leagueScope ?? {});
        if (parsed.legCount) setLegCountState(parsed.legCount);
      }
    } catch {
      // Corrupt/unavailable storage - start from an empty pool rather than fail the page.
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-hydrate when the signed-in user changes
  }, [userId]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const data: PersistedState = { pool, leagueScope, legCount };
      window.localStorage.setItem(storageKey(userId), JSON.stringify(data));
    } catch {
      // Best-effort persistence only - a full localStorage or a private window is not fatal.
    }
  }, [userId, pool, leagueScope, legCount, hydrated]);

  const isInPool = useCallback((pickId: string) => pool.some((p) => p.pickId === pickId), [pool]);

  const removeFromPool = useCallback((pickId: string) => {
    setPool((prev) => prev.filter((p) => p.pickId !== pickId));
  }, []);

  const enterAddMode = useCallback(() => {
    setCheckedPicks(new Map());
    setAddMode(true);
  }, []);

  const toggleChecked = useCallback((pick: PooledPick) => {
    setCheckedPicks((prev) => {
      const next = new Map(prev);
      if (next.has(pick.pickId)) next.delete(pick.pickId);
      else next.set(pick.pickId, pick);
      return next;
    });
  }, []);

  const confirmAdd = useCallback(() => {
    setPool((prev) => {
      const existingIds = new Set(prev.map((p) => p.pickId));
      const additions = Array.from(checkedPicks.values()).filter((p) => !existingIds.has(p.pickId));
      // MLB defaults on, every other league defaults off - only set on FIRST
      // appearance of a league in the pool so a user's own later toggle is
      // never clobbered by a repeat add from the same league.
      setLeagueScope((prevScope) => {
        const nextScope = { ...prevScope };
        for (const p of additions) {
          if (!(p.leagueName in nextScope)) nextScope[p.leagueName] = p.leagueName === MLB_LEAGUE_NAME;
        }
        return nextScope;
      });
      return [...prev, ...additions];
    });
    setCheckedPicks(new Map());
    setAddMode(false);
  }, [checkedPicks]);

  const discardAdd = useCallback(() => {
    setCheckedPicks(new Map());
    setAddMode(false);
  }, []);

  const leaguesInPool = useMemo(() => Array.from(new Set(pool.map((p) => p.leagueName))), [pool]);

  const isLeagueInScope = useCallback(
    (league: string) => leagueScope[league] ?? league === MLB_LEAGUE_NAME,
    [leagueScope]
  );

  const toggleLeague = useCallback((league: string) => {
    setLeagueScope((prev) => ({ ...prev, [league]: !(prev[league] ?? league === MLB_LEAGUE_NAME) }));
  }, []);

  const maxLegCount = useMemo(
    () => pool.filter((p) => isLeagueInScope(p.leagueName)).length,
    [pool, isLeagueInScope]
  );

  const setLegCount = useCallback(
    (n: number) => {
      setLegCountState(Math.max(1, Math.min(n, Math.max(maxLegCount, 1))));
    },
    [maxLegCount]
  );

  const value: ParlayPoolContextValue = {
    pool,
    isInPool,
    removeFromPool,
    addMode,
    checkedPicks,
    enterAddMode,
    toggleChecked,
    confirmAdd,
    discardAdd,
    leaguesInPool,
    isLeagueInScope,
    toggleLeague,
    legCount: Math.max(1, Math.min(legCount, Math.max(maxLegCount, 1))),
    setLegCount,
    maxLegCount,
  };

  return <ParlayPoolContext.Provider value={value}>{children}</ParlayPoolContext.Provider>;
}

export function useParlayPool() {
  const ctx = useContext(ParlayPoolContext);
  if (!ctx) throw new Error("useParlayPool must be used within a ParlayPoolProvider");
  return ctx;
}
