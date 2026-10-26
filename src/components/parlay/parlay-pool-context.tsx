"use client";

// The Parlay slip: client-side state for the Parlay Generator - the picks the
// user put in it and the games they targeted. Deliberately client-only, not a
// DB table - unlike ParlayBet/Leg (server/data/parlays.ts), which record a
// CAPPER's own already-placed parlay for grading/record-keeping, the slip is
// the user's own in-progress selection. Nothing here is graded.
//
// One provider (mounted in (app)/layout.tsx, alongside ThemeProvider) covers
// every page, so the slip and Live's slip mode survive a client-side nav. It's
// also persisted to localStorage (scoped by userId) so a refresh doesn't wipe
// it. The stored picks are only ids to look up, though: on hydrate and on
// every tab focus they are revalidated against the DB (getSlipPickStatesAction),
// so status, odds and whether the game has started always come from current
// data, and any pick that has started, been graded or been deleted is pruned -
// said once, quietly, by `removedLine` on the generator's Your Picks.
//
// The model and its stored format live in lib/parlay/slip-state.ts:
//   - picks: every one goes into every generated parlay; at most MAX_PARLAY_LEGS.
//   - targets: games targeted on purpose. A pick's game is in play too
//     ("targeted via your picks") but isn't a target.
//   - league scope: every league is on unless switched off; a league with a
//     pick or a target in the slip can't be switched off, and adding one
//     switches its league back on. Only the switched-off leagues are stored.
//   - Live's slip mode: its checkboxes write straight into the slip (no
//     Confirm). It lives in memory only - it survives a client-side nav, turns
//     off on Send to generator or Exit, and a reload never brings it back.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { getSlipPickStatesAction } from "@/server/actions/parlay-slip";
import { reconcileSlip, type PrunedLeg } from "@/lib/parlay/slip-reconcile";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import {
  addRemoved,
  clearedSlip,
  EMPTY_LEGACY,
  generatorTargets as toGeneratorTargets,
  migrateStoredSlip,
  serializeSlip,
  slipFromStorageEvent,
  targetedGames as toTargetedGames,
  toggleTarget as toggleTargetIn,
  togglePick as togglePickIn,
  type RemovedLine,
  type SlipStateV2,
  type SlipTarget,
  type TargetedGame,
} from "@/lib/parlay/slip-state";

export type PooledPick = ExpanderPick;
export type SlipGame = SlipTarget;

const STORAGE_PREFIX = "parlay-pool:";
const LEGACY_UNSCOPED_KEY = "parlay-pool";
const REVALIDATE_MIN_INTERVAL_MS = 60_000;
// How long "Clear all picks" can be undone.
const UNDO_CLEAR_MS = 30_000;

type ClearedSlip = { picks: PooledPick[]; targets: SlipGame[] };

type ParlayPoolContextValue = {
  // ---- Picks ----
  pool: PooledPick[];
  isInPool: (pickId: string) => boolean;
  removeFromPool: (pickId: string) => void;
  // Live's checkbox in slip mode: adds or removes the pick at once. Refused
  // past the leg cap (overCapBy says so).
  togglePick: (pick: PooledPick) => void;
  // How many picks the slip holds (the sidebar badge).
  slipSize: number;

  // ---- Targets ----
  targets: SlipGame[];
  // Every game in play: the targets plus the games of the slip's picks.
  targetedGames: TargetedGame[];
  isTargeted: (gameId: string) => boolean;
  // A pick is on it: in play, and can't be untargeted while the pick is there.
  isTargetedViaPicks: (gameId: string) => boolean;
  // Refused (returns false) for a game a pick is on, or past the target cap.
  toggleTarget: (game: SlipGame) => boolean;
  // "Use full slate".
  clearTargets: () => void;
  // What the generator is told: the explicit targets only.
  generatorTargets: () => { gameId: string; leagueName: string }[];

  // ---- League scope ----
  isLeagueInScope: (league: string) => boolean;
  // A league a pick or a target is in can't be switched off.
  isLeagueLocked: (league: string) => boolean;
  toggleLeague: (league: string) => void;

  // ---- The generator's leg count (1 to MAX_PARLAY_LEGS) ----
  legCount: number;
  setLegCount: (n: number) => void;

  // ---- Live's slip mode (in memory only) ----
  slipMode: boolean;
  enterSlipMode: () => void;
  exitSlipMode: () => void;
  // Turns slip mode off; the caller then goes to /parlay.
  sendToGenerator: () => void;
  // Set (to 1) when a pick was refused at the leg cap, null otherwise.
  // Cleared by the next change.
  overCapBy: number | null;
  dismissOverCap: () => void;

  // ---- "Clear all picks": picks and targets cleared, slip mode off. Undoable
  // for a while (clearedCount says how many it would bring back, else 0). ----
  clearSlip: () => void;
  undoClear: () => void;
  clearedCount: number;

  // The picks pruned from the slip (graded, started, or gone) and why, until
  // dismissed - null when none.
  removed: RemovedLine | null;
  dismissRemoved: () => void;

  // Re-checks the slip against the DB now (no throttle). True when it changed.
  refreshSlip: () => Promise<boolean>;
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

const unstarted = (games: SlipGame[], now: number) => games.filter((g) => new Date(g.gameTime).getTime() > now);

export function ParlayPoolProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const [pool, setPool] = useState<PooledPick[]>([]);
  const [targets, setTargets] = useState<SlipGame[]>([]);
  const [excludedLeagues, setExcludedLeagues] = useState<string[]>([]);
  const [legCount, setLegCountState] = useState(EMPTY_LEGACY.legCount);
  // Live's slip mode. In memory only: never stored, so a reload never brings it back.
  const [slipMode, setSlipMode] = useState(false);
  const [overCapBy, setOverCapBy] = useState<number | null>(null);
  const [removed, setRemoved] = useState<RemovedLine | null>(null);
  const [cleared, setCleared] = useState<ClearedSlip | null>(null);
  // Guards the persist effect below - without it, that effect's own first
  // run (on mount, before hydration below has applied) fires with the
  // empty initial state and immediately overwrites a real saved slip.
  const [hydrated, setHydrated] = useState(false);
  // The refs move with every change (not on the next render), so two changes
  // in one event each see the other.
  const poolRef = useRef<PooledPick[]>([]);
  poolRef.current = pool;
  const targetsRef = useRef<SlipGame[]>([]);
  targetsRef.current = targets;
  // Stored picks still being checked against the DB on hydrate: not in `pool`
  // yet, but about to be, so the cap counts them.
  const uncheckedStoredRef = useRef<Set<string>>(new Set());
  const lastCheckRef = useRef(0);
  const inFlightRef = useRef(false);
  // Pick ids already reported this session, so the same pick is never
  // counted twice (e.g. two overlapping revalidations).
  const noticedRef = useRef<Set<string>>(new Set());

  const reportPruned = useCallback((pruned: PrunedLeg[]) => {
    const fresh = pruned.filter((l) => !noticedRef.current.has(l.pickId));
    if (fresh.length === 0) return;
    fresh.forEach((l) => noticedRef.current.add(l.pickId));
    // Every pick that leaves is named, whatever the reason (graded, started, deleted).
    setRemoved((prev) => addRemoved(prev, fresh));
  }, []);

  // Hydrate once per userId (a different account signing in on the same
  // browser gets its own, empty slip). The stored picks are NOT put on screen
  // until checked against the DB, so a stale pick never flashes as Pending.
  useEffect(() => {
    let cancelled = false;
    let stored: PooledPick[] = [];
    try {
      window.localStorage.removeItem(LEGACY_UNSCOPED_KEY);
      const raw = window.localStorage.getItem(storageKey(userId));
      if (raw) {
        // Any stored shape - the old one included - comes back as a v2 state.
        const parsed = migrateStoredSlip(JSON.parse(raw));
        stored = parsed.picks;
        setExcludedLeagues(parsed.excludedLeagues);
        setLegCountState(Math.min(MAX_PARLAY_LEGS, parsed.legacy.legCount));
        // A target whose game started has nothing left to give: dropped quietly.
        setTargets(unstarted(parsed.targets, Date.now()));
      }
    } catch {
      // Corrupt/unavailable storage - start from an empty slip rather than fail the page.
    }
    if (stored.length === 0) {
      setHydrated(true);
      return;
    }
    // The check takes a round-trip, and the user can add picks before it
    // lands. Its answer replaces only the stored picks it was asked about.
    const storedIds = new Set(stored.map((p) => p.pickId));
    uncheckedStoredRef.current = storedIds;
    const withAddedSince = (checked: PooledPick[]) => (prev: PooledPick[]) => [...checked, ...prev.filter((p) => !storedIds.has(p.pickId))];
    (async () => {
      let states: Awaited<ReturnType<typeof getSlipPickStatesAction>> | null = null;
      try {
        states = await getSlipPickStatesAction(stored.map((p) => p.pickId));
      } catch {
        // Offline / server error - handled below.
      }
      if (cancelled) return;
      uncheckedStoredRef.current = new Set();
      if (states) {
        const { kept, pruned } = reconcileSlip(stored, states);
        setPool(withAddedSince(kept));
        reportPruned(pruned);
      } else {
        // Couldn't reach the DB: show only what can't already be known stale.
        const now = Date.now();
        setPool(withAddedSince(stored.filter((p) => p.status === "PENDING" && new Date(p.gameTime).getTime() > now)));
      }
      lastCheckRef.current = Date.now();
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
      uncheckedStoredRef.current = new Set();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-hydrate when the signed-in user changes
  }, [userId]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const data: SlipStateV2 = {
        version: 2,
        picks: pool,
        targets,
        excludedLeagues,
        legacy: { legCount },
      };
      const json = serializeSlip(data);
      // An unchanged slip isn't rewritten (it would only echo to the other tabs).
      if (window.localStorage.getItem(storageKey(userId)) !== json) window.localStorage.setItem(storageKey(userId), json);
    } catch {
      // Best-effort persistence only - a full localStorage or a private window is not fatal.
    }
  }, [userId, pool, targets, excludedLeagues, legCount, hydrated]);

  // Re-check the slip against the DB. Only picks that were in it when the
  // request went out are touched, so one added mid-flight is left alone.
  const revalidate = useCallback(async (): Promise<boolean> => {
    const live = unstarted(targetsRef.current, Date.now());
    const targetsChanged = live.length !== targetsRef.current.length;
    if (targetsChanged) setTargets(live);
    const checked = poolRef.current;
    if (checked.length === 0 || inFlightRef.current) return targetsChanged;
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
        setPool((prev) => prev.flatMap((p) => (!ids.has(p.pickId) ? [p] : keptById.has(p.pickId) ? [keptById.get(p.pickId)!] : [])));
        reportPruned(pruned);
      }
      return changed || targetsChanged;
    } catch {
      // Transient failure - keep the slip as-is; the next focus retries.
      return targetsChanged;
    } finally {
      inFlightRef.current = false;
    }
  }, [reportPruned]);

  // Another tab changed the slip: take its version, so this tab never writes an
  // older one back over it.
  useEffect(() => {
    if (!hydrated) return;
    function onStorage(e: StorageEvent) {
      if (e.key !== storageKey(userId)) return;
      const next = slipFromStorageEvent(e.newValue, Date.now());
      poolRef.current = next.picks;
      targetsRef.current = next.targets;
      setPool(next.picks);
      setTargets(next.targets);
      setExcludedLeagues(next.excludedLeagues);
      setLegCountState(Math.min(MAX_PARLAY_LEGS, next.legacy.legCount));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hydrated, userId]);

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

  // "Clear all picks" can be undone for a while; then it is final.
  useEffect(() => {
    if (!cleared) return;
    const t = window.setTimeout(() => setCleared(null), UNDO_CLEAR_MS);
    return () => window.clearTimeout(t);
  }, [cleared]);

  const switchOn = (leagues: string[]) => setExcludedLeagues((prev) => (prev.some((l) => leagues.includes(l)) ? prev.filter((l) => !leagues.includes(l)) : prev));
  const modelState = (): SlipStateV2 => ({ version: 2, picks: poolRef.current, targets: targetsRef.current, excludedLeagues: [], legacy: EMPTY_LEGACY });

  const isInPool = useCallback((pickId: string) => pool.some((p) => p.pickId === pickId), [pool]);

  const removeFromPool = useCallback((pickId: string) => {
    poolRef.current = poolRef.current.filter((p) => p.pickId !== pickId);
    setPool(poolRef.current);
  }, []);

  const togglePick = useCallback((pick: PooledPick) => {
    const inSlip = poolRef.current.some((p) => p.pickId === pick.pickId);
    if (!inSlip && poolRef.current.length + uncheckedStoredRef.current.size >= MAX_PARLAY_LEGS) {
      setOverCapBy(1);
      return;
    }
    const change = togglePickIn(modelState(), pick);
    if (change.refused) {
      setOverCapBy(1);
      return;
    }
    setOverCapBy(null);
    poolRef.current = change.state.picks;
    setPool(change.state.picks);
    if (!inSlip) switchOn([pick.leagueName]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the refs, not render state
  }, []);

  const toggleTarget = useCallback((game: SlipGame) => {
    const change = toggleTargetIn(modelState(), game);
    if (change.refused) return false;
    const added = !targetsRef.current.some((g) => g.gameId === game.gameId);
    targetsRef.current = change.state.targets;
    setTargets(change.state.targets);
    if (added) switchOn([game.leagueName]);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the refs, not render state
  }, []);

  const clearTargets = useCallback(() => {
    targetsRef.current = [];
    setTargets([]);
  }, []);

  const leaguesInSlip = useMemo(() => new Set([...pool.map((p) => p.leagueName), ...targets.map((t) => t.leagueName)]), [pool, targets]);
  const isLeagueInScope = useCallback((league: string) => leaguesInSlip.has(league) || !excludedLeagues.includes(league), [excludedLeagues, leaguesInSlip]);
  const isLeagueLocked = useCallback((league: string) => leaguesInSlip.has(league), [leaguesInSlip]);
  const toggleLeague = useCallback(
    (league: string) => {
      if (leaguesInSlip.has(league)) return;
      setExcludedLeagues((prev) => (prev.includes(league) ? prev.filter((l) => l !== league) : [...prev, league]));
    },
    [leaguesInSlip]
  );

  const setLegCount = useCallback((n: number) => setLegCountState(Math.max(1, Math.min(Math.floor(n) || 1, MAX_PARLAY_LEGS))), []);

  const dismissOverCap = useCallback(() => setOverCapBy(null), []);

  const enterSlipMode = useCallback(() => {
    setOverCapBy(null);
    setSlipMode(true);
  }, []);

  const exitSlipMode = useCallback(() => {
    setOverCapBy(null);
    setSlipMode(false);
  }, []);

  // The picks are already in the slip (checkboxes write straight in); sending
  // is just leaving slip mode.
  const sendToGenerator = exitSlipMode;

  const clearSlip = useCallback(() => {
    if (poolRef.current.length > 0 || targetsRef.current.length > 0) setCleared({ picks: poolRef.current, targets: targetsRef.current });
    const empty = clearedSlip(modelState());
    poolRef.current = empty.picks;
    targetsRef.current = empty.targets;
    setPool(empty.picks);
    setTargets(empty.targets);
    setSlipMode(false);
    setOverCapBy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the refs, not render state
  }, []);

  // Brings back what "Clear all picks" removed, under the leg cap and without
  // doubling anything added since.
  const undoClear = useCallback(() => {
    if (!cleared) return;
    const havePicks = new Set(poolRef.current.map((p) => p.pickId));
    const picks = [...poolRef.current, ...cleared.picks.filter((p) => !havePicks.has(p.pickId))].slice(0, MAX_PARLAY_LEGS);
    const haveTargets = new Set(targetsRef.current.map((t) => t.gameId));
    const targets = [...targetsRef.current, ...cleared.targets.filter((t) => !haveTargets.has(t.gameId))];
    poolRef.current = picks;
    targetsRef.current = targets;
    setPool(picks);
    setTargets(targets);
    switchOn(picks.map((p) => p.leagueName));
    setCleared(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the refs, not render state
  }, [cleared]);

  const dismissRemoved = useCallback(() => setRemoved(null), []);
  const refreshSlip = useCallback(() => {
    lastCheckRef.current = Date.now();
    return revalidate();
  }, [revalidate]);

  const targetedGames = useMemo(() => toTargetedGames({ picks: pool, targets }), [pool, targets]);

  const value: ParlayPoolContextValue = {
    pool,
    isInPool,
    removeFromPool,
    togglePick,
    slipSize: pool.length,
    targets,
    targetedGames,
    isTargeted: (gameId) => targetedGames.some((g) => g.gameId === gameId),
    isTargetedViaPicks: (gameId) => pool.some((p) => p.gameId === gameId),
    toggleTarget,
    clearTargets,
    generatorTargets: () => toGeneratorTargets({ targets }),
    isLeagueInScope,
    isLeagueLocked,
    toggleLeague,
    legCount,
    setLegCount,
    slipMode,
    enterSlipMode,
    exitSlipMode,
    sendToGenerator,
    overCapBy,
    dismissOverCap,
    clearSlip,
    undoClear,
    clearedCount: cleared ? cleared.picks.length : 0,
    removed,
    dismissRemoved,
    refreshSlip,
  };

  return <ParlayPoolContext.Provider value={value}>{children}</ParlayPoolContext.Provider>;
}

// For a control that only makes sense with a slip: null, not a throw, where no
// provider is mounted.
export function useOptionalParlayPool() {
  return useContext(ParlayPoolContext);
}

export function useParlayPool() {
  const ctx = useContext(ParlayPoolContext);
  if (!ctx) throw new Error("useParlayPool must be used within a ParlayPoolProvider");
  return ctx;
}
