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
// client-side nav between /live and /parlay (or between leagues on /live)
// without a remount. It's also persisted to localStorage (scoped by userId)
// purely so an accidental refresh doesn't silently wipe a slip the user was
// still building - the confirmed legs and the add-mode selection both. The
// stored legs are only a list of pick ids to look up, though: on hydrate and
// on every tab focus they are revalidated against the DB
// (getSlipPickStatesAction), so status, odds and whether the game has started
// always come from current data and any leg that has started, been graded, or
// been deleted is pruned (with a one-time notice).
//
// League scope: every league with a pick in the slip is ON unless the user
// switched it off. Confirming a new pick from a league switches that league
// back on; nothing else does. Only the switched-off leagues are stored.
//
// The slip holds at most MAX_PARLAY_LEGS items (lib/parlay/leg-cap.ts).
// confirmAdd refuses a selection that would take it past that - it adds
// nothing and says so, rather than adding only the picks that fit.
//
// Besides picks (`pool`), the slip holds GAMES ("the best pick from this
// game", see lib/parlay/slip-build.ts), and any item can be LOCKED. `pool`
// stays picks only - everything that reads it (Send to FanDuel, Hedge /
// Contrarian) is unchanged. A game item is pruned once its game starts, by
// the kickoff captured when it was added; the build re-checks it server-side.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { getSlipPickStatesAction } from "@/server/actions/parlay-slip";
import { reconcileSlip, type PrunedLeg } from "@/lib/parlay/slip-reconcile";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import type { SlipSource } from "@/lib/parlay/slip-build";
import {
  addRemoved,
  clearedSlip,
  generatorTargets as toGeneratorTargets,
  migrateStoredSlip,
  removedLineText,
  serializeSlip,
  targetedGames as toTargetedGames,
  toggleTarget as toggleTargetIn,
  togglePick as togglePickIn,
  type RemovedLine,
  type SlipStateV2,
  type TargetedGame,
} from "@/lib/parlay/slip-state";

// The slip's state model and stored format live in lib/parlay/slip-state.ts.
// The new parts (targets, Live's direct-write picks, Send to generator, the
// quiet "games started" line) sit beside the old ones until the generator
// redesign and Live's slip mode replace the old /parlay sections and Confirm.

export type PooledPick = ExpanderPick;

export type SlipGame = { gameId: string; gameLabel: string; gameTime: string; leagueName: string };

// Locks are kept by item key: a pick's id, or "game:" + a game item's id.
export const gameItemKey = (gameId: string) => "game:" + gameId;

function startedGames(games: SlipGame[], now: number): { kept: SlipGame[]; pruned: PrunedLeg[] } {
  const kept = games.filter((g) => new Date(g.gameTime).getTime() > now);
  const pruned = games
    .filter((g) => !kept.includes(g))
    .map((g) => ({ pickId: gameItemKey(g.gameId), label: g.gameLabel + " - best pick from this game", result: "Started" as const }));
  return { kept, pruned };
}

const STORAGE_PREFIX = "parlay-pool:";
const LEGACY_UNSCOPED_KEY = "parlay-pool";
const REVALIDATE_MIN_INTERVAL_MS = 60_000;

type ParlayPoolContextValue = {
  // ---- The state model (lib/parlay/slip-state.ts) ----
  // Games targeted on purpose - the same items as `games` below.
  targets: SlipGame[];
  // Every game in play: the targets plus the games of the slip's picks.
  targetedGames: TargetedGame[];
  isTargeted: (gameId: string) => boolean;
  // A pick is on it: in play, and can't be untargeted while the pick is there.
  isTargetedViaPicks: (gameId: string) => boolean;
  // Refused (returns false) for a game a pick is on, or past the target cap.
  toggleTarget: (game: SlipGame) => boolean;
  // Live's checkbox in slip mode: adds or removes the pick at once, no
  // Confirm. Refused past the leg cap (overCapBy says so).
  togglePick: (pick: PooledPick) => void;
  // What the generator is told: the explicit targets only.
  generatorTargets: () => { gameId: string; leagueName: string }[];
  // Live's checkboxes (the old add mode, until Live's slip mode lands).
  slipMode: boolean;
  // Confirms anything still ticked the old way, then turns slip mode off.
  sendToGenerator: () => void;
  // After Send to FanDuel: picks and targets cleared, slip mode off.
  clearSlip: () => void;
  // "3 picks removed — games started" for a while after a prune, else null.
  removedLine: string | null;

  // ---- The old /parlay sections' API ----

  pool: PooledPick[];
  isInPool: (pickId: string) => boolean;
  removeFromPool: (pickId: string) => void;

  games: SlipGame[];
  isGameInSlip: (gameId: string) => boolean;
  addGame: (game: SlipGame) => void;
  removeGame: (gameId: string) => void;
  // Picks plus games - what the slip holds, against MAX_PARLAY_LEGS.
  slipSize: number;

  // Keyed by pick id or gameItemKey(gameId).
  isLocked: (key: string) => boolean;
  toggleLock: (key: string) => void;

  // What "Build from slip" builds from (see lib/parlay/slip-build.ts).
  source: SlipSource;
  setSource: (source: SlipSource) => void;

  addMode: boolean;
  checkedPicks: Map<string, PooledPick>;
  enterAddMode: () => void;
  toggleChecked: (pick: PooledPick) => void;
  confirmAdd: () => void;
  discardAdd: () => void;
  // How many picks the last confirmAdd was over MAX_PARLAY_LEGS by - set when
  // it was refused, null otherwise. Cleared as soon as the selection changes.
  overCapBy: number | null;
  dismissOverCap: () => void;

  leaguesInPool: string[];
  isLeagueInScope: (league: string) => boolean;
  toggleLeague: (league: string) => void;

  legCount: number;
  setLegCount: (n: number) => void;
  // In-scope slip items (picks and games), capped at MAX_PARLAY_LEGS.
  maxLegCount: number;
  // The most legs a build may ask for: maxLegCount, or the cap when the
  // Source lets the qualified pool fill in.
  maxBuildLegs: number;

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
  const [excludedLeagues, setExcludedLeagues] = useState<string[]>([]);
  const [legCount, setLegCountState] = useState(2);
  const [addMode, setAddMode] = useState(false);
  const [checkedPicks, setCheckedPicks] = useState<Map<string, PooledPick>>(new Map());
  const [overCapBy, setOverCapBy] = useState<number | null>(null);
  const [games, setGames] = useState<SlipGame[]>([]);
  const [locked, setLocked] = useState<string[]>([]);
  const [source, setSource] = useState<SlipSource>("SLIP_PLUS_POOL");
  const gamesRef = useRef<SlipGame[]>([]);
  gamesRef.current = games;
  // Guards the persist effect below - without it, that effect's own first
  // run (on mount, before hydration below has applied) fires with the
  // empty initial state and immediately overwrites a real saved pool with
  // {pool: []}, wiping it out before it's ever read back.
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState<PrunedLeg[] | null>(null);
  const poolRef = useRef<PooledPick[]>([]);
  poolRef.current = pool;
  // Stored legs still being checked against the DB on hydrate: not in `pool`
  // yet, but about to be, so confirmAdd counts them toward the cap.
  const uncheckedStoredRef = useRef<Set<string>>(new Set());
  const lastCheckRef = useRef(0);
  const inFlightRef = useRef(false);
  // Pick ids already reported in a notice this session, so the same leg is
  // never announced twice (e.g. two overlapping revalidations).
  const noticedRef = useRef<Set<string>>(new Set());

  const [removed, setRemoved] = useState<RemovedLine | null>(null);
  const reportPruned = useCallback((pruned: PrunedLeg[]) => {
    const fresh = pruned.filter((l) => !noticedRef.current.has(l.pickId));
    if (fresh.length === 0) return;
    fresh.forEach((l) => noticedRef.current.add(l.pickId));
    setNotice((prev) => [...(prev ?? []), ...fresh]);
    // The quiet line counts what left because its game started (or finished);
    // a deleted pick ("Removed") isn't a game starting.
    const started = fresh.filter((l) => l.result !== "Removed").length;
    if (started > 0) setRemoved((prev) => addRemoved(prev, started, Date.now()));
  }, []);

  // Hydrate once per userId (a different account signing in on the same
  // browser gets its own, empty pool rather than inheriting the previous
  // user's). The stored pool is NOT put on screen until it has been checked
  // against the DB, so a stale leg never flashes as Pending or counts in the
  // nav badge. addMode/checkedPicks come back as they were saved: they are an
  // unconfirmed selection, checked like any other leg once confirmed.
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
        setLegCountState(parsed.legacy.legCount);
        if (parsed.legacy.addMode) setAddMode(true);
        if (parsed.legacy.checkedPicks.length > 0) setCheckedPicks(new Map(parsed.legacy.checkedPicks.map((p) => [p.pickId, p])));
        const { kept, pruned } = startedGames(parsed.targets, Date.now());
        setGames(kept);
        reportPruned(pruned);
        setLocked(parsed.legacy.locked);
        setSource(parsed.legacy.source);
      }
    } catch {
      // Corrupt/unavailable storage - start from an empty pool rather than fail the page.
    }
    if (stored.length === 0) {
      setHydrated(true);
      return;
    }
    // The check below takes a round-trip, and the user can confirm picks
    // before it lands. Its answer replaces only the stored legs it was asked
    // about - anything confirmed in the meantime stays.
    const storedIds = new Set(stored.map((p) => p.pickId));
    uncheckedStoredRef.current = storedIds;
    const withConfirmedSince = (checked: PooledPick[]) => (prev: PooledPick[]) =>
      [...checked, ...prev.filter((p) => !storedIds.has(p.pickId))];
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
        setPool(withConfirmedSince(kept));
        reportPruned(pruned);
      } else {
        // Couldn't reach the DB: show only what can't already be known stale
        // (still pending, not started per the client clock). The next focus
        // revalidation replaces these with real values.
        const now = Date.now();
        setPool(withConfirmedSince(stored.filter((p) => p.status === "PENDING" && new Date(p.gameTime).getTime() > now)));
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
        targets: games,
        excludedLeagues,
        legacy: { addMode, legCount, checkedPicks: Array.from(checkedPicks.values()), locked, source },
      };
      window.localStorage.setItem(storageKey(userId), serializeSlip(data));
    } catch {
      // Best-effort persistence only - a full localStorage or a private window is not fatal.
    }
  }, [userId, pool, excludedLeagues, legCount, addMode, checkedPicks, games, locked, source, hydrated]);

  // Re-check the live pool against the DB. Only legs that were in the pool
  // when the request went out are touched, so a pick added mid-flight is left alone.
  const revalidate = useCallback(async () => {
    const gameCheck = startedGames(gamesRef.current, Date.now());
    if (gameCheck.pruned.length > 0) {
      const gone = new Set(gameCheck.pruned.map((g) => g.pickId));
      setGames((prev) => prev.filter((g) => !gone.has(gameItemKey(g.gameId))));
      reportPruned(gameCheck.pruned);
    }
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
    setLocked((prev) => prev.filter((k) => k !== pickId));
  }, []);

  const isGameInSlip = useCallback((gameId: string) => games.some((g) => g.gameId === gameId), [games]);

  // Same cap as confirmAdd: refused whole, and said so on the slip button.
  const addGame = useCallback((game: SlipGame) => {
    if (gamesRef.current.some((g) => g.gameId === game.gameId)) return;
    if (poolRef.current.length + uncheckedStoredRef.current.size + gamesRef.current.length >= MAX_PARLAY_LEGS) {
      setOverCapBy(1);
      return;
    }
    setGames((prev) => [...prev, { gameId: game.gameId, gameLabel: game.gameLabel, gameTime: game.gameTime, leagueName: game.leagueName }]);
    // Like a new pick, a new game switches its league on.
    setExcludedLeagues((prev) => (prev.includes(game.leagueName) ? prev.filter((l) => l !== game.leagueName) : prev));
  }, []);

  const removeGame = useCallback((gameId: string) => {
    setGames((prev) => prev.filter((g) => g.gameId !== gameId));
    setLocked((prev) => prev.filter((k) => k !== gameItemKey(gameId)));
  }, []);

  const isLocked = useCallback((key: string) => locked.includes(key), [locked]);

  const toggleLock = useCallback((key: string) => {
    setLocked((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const dismissOverCap = useCallback(() => setOverCapBy(null), []);

  const enterAddMode = useCallback(() => {
    setCheckedPicks(new Map());
    setOverCapBy(null);
    setAddMode(true);
  }, []);

  const toggleChecked = useCallback((pick: PooledPick) => {
    setOverCapBy(null);
    setCheckedPicks((prev) => {
      const next = new Map(prev);
      if (next.has(pick.pickId)) next.delete(pick.pickId);
      else next.set(pick.pickId, pick);
      return next;
    });
  }, []);

  const confirmAdd = useCallback(() => {
    const held = new Set(poolRef.current.map((p) => p.pickId));
    uncheckedStoredRef.current.forEach((id) => held.add(id));
    const adding = Array.from(checkedPicks.values()).filter((p) => !held.has(p.pickId));
    const over = held.size + gamesRef.current.length + adding.length - MAX_PARLAY_LEGS;
    if (adding.length > 0 && over > 0) {
      // Stay in add mode with the selection intact, so the user can untick
      // down to the cap instead of starting over.
      setOverCapBy(over);
      return;
    }
    setOverCapBy(null);
    setPool((prev) => {
      const existingIds = new Set(prev.map((p) => p.pickId));
      const additions = Array.from(checkedPicks.values()).filter((p) => !existingIds.has(p.pickId));
      // A new pick switches its league on, even one the user had switched
      // off. A pick already in the slip is not new and changes nothing.
      const added = new Set(additions.map((p) => p.leagueName));
      setExcludedLeagues((prevExcluded) =>
        prevExcluded.some((l) => added.has(l)) ? prevExcluded.filter((l) => !added.has(l)) : prevExcluded
      );
      return [...prev, ...additions];
    });
    setCheckedPicks(new Map());
    setAddMode(false);
  }, [checkedPicks]);

  const discardAdd = useCallback(() => {
    setOverCapBy(null);
    setCheckedPicks(new Map());
    setAddMode(false);
  }, []);

  const leaguesInPool = useMemo(
    () => Array.from(new Set([...pool.map((p) => p.leagueName), ...games.map((g) => g.leagueName)])),
    [pool, games]
  );

  const isLeagueInScope = useCallback((league: string) => !excludedLeagues.includes(league), [excludedLeagues]);

  const toggleLeague = useCallback((league: string) => {
    setExcludedLeagues((prev) => (prev.includes(league) ? prev.filter((l) => l !== league) : [...prev, league]));
  }, []);

  // A slip saved before the cap existed can hold more than MAX_PARLAY_LEGS
  // picks; it still builds at most that many legs.
  const maxLegCount = useMemo(
    () =>
      Math.min(
        pool.filter((p) => isLeagueInScope(p.leagueName)).length + games.filter((g) => isLeagueInScope(g.leagueName)).length,
        MAX_PARLAY_LEGS
      ),
    [pool, games, isLeagueInScope]
  );
  // With the qualified pool filling in, the slip's own size no longer bounds
  // the leg count - only the cap does.
  const maxBuildLegs = source === "SLIP_PLUS_POOL" && maxLegCount > 0 ? MAX_PARLAY_LEGS : maxLegCount;

  const setLegCount = useCallback(
    (n: number) => {
      setLegCountState(Math.max(1, Math.min(n, Math.max(maxBuildLegs, 1))));
    },
    [maxBuildLegs]
  );

  // ---- The state model's actions ----
  // The quiet line clears itself: re-render when it runs out.
  useEffect(() => {
    if (!removed) return;
    const t = window.setTimeout(() => setRemoved((r) => (r && r.until <= Date.now() ? null : r)), Math.max(0, removed.until - Date.now()) + 50);
    return () => window.clearTimeout(t);
  }, [removed]);

  const modelState = (): SlipStateV2 => ({
    version: 2,
    picks: poolRef.current,
    targets: gamesRef.current,
    excludedLeagues: [],
    legacy: { addMode: false, legCount: 1, checkedPicks: [], locked: [], source: "SLIP_PLUS_POOL" },
  });

  const toggleTarget = useCallback((game: SlipGame) => {
    const change = toggleTargetIn(modelState(), game);
    if (change.refused) return false;
    const added = !gamesRef.current.some((g) => g.gameId === game.gameId);
    gamesRef.current = change.state.targets;
    setGames(change.state.targets);
    if (added) {
      setExcludedLeagues((prev) => (prev.includes(game.leagueName) ? prev.filter((l) => l !== game.leagueName) : prev));
    } else {
      setLocked((prev) => prev.filter((k) => k !== gameItemKey(game.gameId)));
    }
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the refs, not render state
  }, []);

  const togglePick = useCallback((pick: PooledPick) => {
    const inSlip = poolRef.current.some((p) => p.pickId === pick.pickId);
    // Stored legs still being checked on hydrate count toward the cap too.
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
    // The ref moves now, not on the next render: two toggles in one event must
    // each see the other.
    poolRef.current = change.state.picks;
    setPool(change.state.picks);
    if (inSlip) setLocked((prev) => prev.filter((k) => k !== pick.pickId));
    else setExcludedLeagues((prev) => (prev.includes(pick.leagueName) ? prev.filter((l) => l !== pick.leagueName) : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the refs, not render state
  }, []);

  const sendToGenerator = useCallback(() => {
    if (checkedPicks.size > 0) confirmAdd();
    else discardAdd();
  }, [checkedPicks, confirmAdd, discardAdd]);

  const clearSlip = useCallback(() => {
    const empty = clearedSlip(modelState());
    setPool(empty.picks);
    setGames(empty.targets);
    setLocked([]);
    setCheckedPicks(new Map());
    setAddMode(false);
    setOverCapBy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the refs, not render state
  }, []);

  const targetedGames = useMemo(() => toTargetedGames({ picks: pool, targets: games }), [pool, games]);

  const value: ParlayPoolContextValue = {
    targets: games,
    targetedGames,
    isTargeted: (gameId) => targetedGames.some((g) => g.gameId === gameId),
    isTargetedViaPicks: (gameId) => pool.some((p) => p.gameId === gameId),
    toggleTarget,
    togglePick,
    generatorTargets: () => toGeneratorTargets({ targets: games }),
    slipMode: addMode,
    sendToGenerator,
    clearSlip,
    removedLine: removedLineText(removed, Date.now()),
    pool,
    isInPool,
    removeFromPool,
    games,
    isGameInSlip,
    addGame,
    removeGame,
    slipSize: pool.length + games.length,
    isLocked,
    toggleLock,
    source,
    setSource,
    addMode,
    checkedPicks,
    enterAddMode,
    toggleChecked,
    confirmAdd,
    discardAdd,
    overCapBy,
    dismissOverCap,
    leaguesInPool,
    isLeagueInScope,
    toggleLeague,
    legCount: Math.max(1, Math.min(legCount, Math.max(maxBuildLegs, 1))),
    setLegCount,
    maxLegCount,
    maxBuildLegs,
    notice,
    dismissNotice,
  };

  return <ParlayPoolContext.Provider value={value}>{children}</ParlayPoolContext.Provider>;
}

// For a control that only makes sense with a slip ("+ Add game"): null, not
// a throw, where no provider is mounted.
export function useOptionalParlayPool() {
  return useContext(ParlayPoolContext);
}

export function useParlayPool() {
  const ctx = useContext(ParlayPoolContext);
  if (!ctx) throw new Error("useParlayPool must be used within a ParlayPoolProvider");
  return ctx;
}
