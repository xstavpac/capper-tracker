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
// refresh doesn't silently wipe a slip the user was still building. The stored
// legs are only a list of pick ids to look up, though: on hydrate and on every
// tab focus they are revalidated against the DB (getSlipPickStatesAction), so
// status/odds/game time always come from current data and any leg that has
// started, been graded, or been deleted is pruned (with a one-time notice).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { getSlipPickStatesAction } from "@/server/actions/parlay-slip";
import { reconcileSlip, type PrunedLeg } from "@/lib/parlay/slip-reconcile";

export type PooledPick = ExpanderPick;

const MLB_LEAGUE_NAME = "MLB";
const STORAGE_PREFIX = "parlay-pool:";
const LEGACY_UNSCOPED_KEY = "parlay-pool";
const REVALIDATE_MIN_INTERVAL_MS = 60_000;

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

  // Legs just pruned from the slip (started/graded/deleted/aged out), shown
  // once by ParlaySlipNotice until dismissed.
  notice: PrunedLeg[] | null;
  dismissNotice: () => void;
};

const ParlayPoolContext = createContext<ParlayPoolContextValue | null>(null);

function storageKey(userId: string) {
  return STORAGE_PREFIX + userId;
}

// Called on sign-out: a slip must not outlive the session on a shared browser.
export function clearParlaySlips() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && (k === LEGACY_UNSCOPED_KEY || k.startsWith(STORAGE_PREFIX))) keys.push(k);
    }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // Storage unavailable - nothing persisted to clear.
  }
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
  const [notice, setNotice] = useState<PrunedLeg[] | null>(null);
  const poolRef = useRef<PooledPick[]>([]);
  poolRef.current = pool;
  const lastCheckRef = useRef(0);
  const inFlightRef = useRef(false);
  // Pick ids already reported in a notice this session, so the same leg is
  // never announced twice (e.g. two overlapping revalidations).
  const noticedRef = useRef<Set<string>>(new Set());

  const reportPruned = useCallback((pruned: PrunedLeg[]) => {
    const fresh = pruned.filter((l) => !noticedRef.current.has(l.pickId));
    if (fresh.length === 0) return;
    fresh.forEach((l) => noticedRef.current.add(l.pickId));
    setNotice((prev) => [...(prev ?? []), ...fresh]);
  }, []);

  // Hydrate once per userId (a different account signing in on the same
  // browser gets its own, empty pool rather than inheriting the previous
  // user's). The stored pool is NOT put on screen until it has been checked
  // against the DB, so a stale leg never flashes as Pending or counts in the
  // nav badge. addMode/checkedPicks are deliberately NOT persisted - that's
  // in-progress UI state, not a saved selection.
  useEffect(() => {
    let cancelled = false;
    let stored: PooledPick[] = [];
    try {
      window.localStorage.removeItem(LEGACY_UNSCOPED_KEY);
      const raw = window.localStorage.getItem(storageKey(userId));
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState;
        stored = parsed.pool ?? [];
        setLeagueScope(parsed.leagueScope ?? {});
        if (parsed.legCount) setLegCountState(parsed.legCount);
      }
    } catch {
      // Corrupt/unavailable storage - start from an empty pool rather than fail the page.
    }
    if (stored.length === 0) {
      setHydrated(true);
      return;
    }
    (async () => {
      let states: Awaited<ReturnType<typeof getSlipPickStatesAction>> | null = null;
      try {
        states = await getSlipPickStatesAction(stored.map((p) => p.pickId));
      } catch {
        // Offline / server error - handled below.
      }
      if (cancelled) return;
      if (states) {
        const { kept, pruned } = reconcileSlip(stored, states);
        setPool(kept);
        reportPruned(pruned);
      } else {
        // Couldn't reach the DB: show only what can't already be known stale
        // (still pending, not started per the client clock). The next focus
        // revalidation replaces these with real values.
        const now = Date.now();
        setPool(stored.filter((p) => p.status === "PENDING" && new Date(p.gameTime).getTime() > now));
      }
      lastCheckRef.current = Date.now();
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
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

  // Re-check the live pool against the DB. Only legs that were in the pool
  // when the request went out are touched, so a pick added mid-flight is left alone.
  const revalidate = useCallback(async () => {
    const checked = poolRef.current;
    if (checked.length === 0 || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const states = await getSlipPickStatesAction(checked.map((p) => p.pickId));
      const ids = new Set(checked.map((p) => p.pickId));
      const current = poolRef.current.filter((p) => ids.has(p.pickId));
      const { kept, pruned } = reconcileSlip(current, states);
      const keptById = new Map(kept.map((p) => [p.pickId, p]));
      const changed =
        pruned.length > 0 ||
        current.some((c) => {
          const k = keptById.get(c.pickId);
          return k !== undefined && (k.status !== c.status || k.odds !== c.odds || k.gameTime !== c.gameTime);
        });
      if (changed) {
        setPool((prev) =>
          prev.flatMap((p) => (!ids.has(p.pickId) ? [p] : keptById.has(p.pickId) ? [keptById.get(p.pickId)!] : []))
        );
        reportPruned(pruned);
      }
    } catch {
      // Transient failure - keep the slip as-is; the next focus retries.
    } finally {
      inFlightRef.current = false;
    }
  }, [reportPruned]);

  // Revalidate whenever the tab regains focus/visibility (throttled - focus
  // and visibilitychange usually fire together).
  useEffect(() => {
    if (!hydrated) return;
    function check() {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastCheckRef.current < REVALIDATE_MIN_INTERVAL_MS) return;
      lastCheckRef.current = now;
      void revalidate();
    }
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [hydrated, revalidate]);

  const dismissNotice = useCallback(() => setNotice(null), []);

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
    notice,
    dismissNotice,
  };

  return <ParlayPoolContext.Provider value={value}>{children}</ParlayPoolContext.Provider>;
}

export function useParlayPool() {
  const ctx = useContext(ParlayPoolContext);
  if (!ctx) throw new Error("useParlayPool must be used within a ParlayPoolProvider");
  return ctx;
}
