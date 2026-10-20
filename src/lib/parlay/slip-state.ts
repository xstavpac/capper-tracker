// The Parlay slip's state model (PR 5 of the generator consolidation): what
// the slip holds, how it is stored, and the rules the generator and Live's
// slip mode build on. Pure and client-safe; parlay-pool-context.tsx holds it
// in React state and persists it.
//
//   - picks: the slip's picks. Every one goes into every generated parlay.
//   - targets: games the user targeted on purpose ("Target game" on Live). With
//     any, the generator builds only from them plus the games of the picks;
//     with none, from the full slate. A pick's game is always in play - it
//     shows as "targeted via your picks" - but is NOT a target: picks alone
//     never switch the generator off the full slate.
//   - slip mode (Live's checkboxes) is NOT stored: it lives in memory, survives
//     a client-side nav, turns off on Send to generator, and a reload never
//     brings it back (it used to, and checkboxes reappeared on Live after sending).
//
// Stored under the same localStorage key as before ("parlay-pool:<userId>"),
// now with `version: 2`. A slip saved by the old code (no version) is read
// through migrateStoredSlip: its `pool` becomes `picks`, its game items
// ("best pick from this game") become targets, its leg count is carried in
// `legacy` (the generator's leg count), and its add mode, unconfirmed ticks,
// locks and Source - which only the old Confirm flow and /parlay sections had -
// are dropped.
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { MAX_PARLAY_LEGS, MAX_POOL_REQUEST_PICKS } from "@/lib/parlay/leg-cap";

export type SlipPick = ExpanderPick;
export type SlipTarget = { gameId: string; gameLabel: string; gameTime: string; leagueName: string };

// What only the old /parlay sections read. Dropped with them.
export type LegacySlipFields = {
  legCount: number;
};

export type SlipStateV2 = {
  version: 2;
  picks: SlipPick[];
  targets: SlipTarget[];
  excludedLeagues: string[];
  legacy: LegacySlipFields;
};

export const SLIP_STATE_VERSION = 2;
// The most targets one slip holds - the same bound generateParlayAction puts
// on a request.
export const MAX_SLIP_TARGETS = MAX_POOL_REQUEST_PICKS;

export const EMPTY_LEGACY: LegacySlipFields = { legCount: 2 };
export const EMPTY_SLIP_STATE: SlipStateV2 = { version: 2, picks: [], targets: [], excludedLeagues: [], legacy: EMPTY_LEGACY };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPick = (v: unknown): v is SlipPick => isObject(v) && typeof v.pickId === "string" && typeof v.gameId === "string";
const isTarget = (v: unknown): v is SlipTarget =>
  isObject(v) && typeof v.gameId === "string" && typeof v.gameLabel === "string" && typeof v.gameTime === "string" && typeof v.leagueName === "string";
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const uniqueBy = <T>(xs: T[], key: (x: T) => string): T[] => {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};
const toTarget = (t: SlipTarget): SlipTarget => ({ gameId: t.gameId, gameLabel: t.gameLabel, gameTime: t.gameTime, leagueName: t.leagueName });

// Any stored value -> a valid v2 state. Unknown, corrupt or empty input is the
// empty slip; nothing here throws.
export function migrateStoredSlip(raw: unknown): SlipStateV2 {
  if (!isObject(raw)) return EMPTY_SLIP_STATE;
  const v2 = raw.version === SLIP_STATE_VERSION;
  const legacyIn: Record<string, unknown> = v2 && isObject(raw.legacy) ? raw.legacy : raw;
  const picks = uniqueBy((Array.isArray(v2 ? raw.picks : raw.pool) ? ((v2 ? raw.picks : raw.pool) as unknown[]) : []).filter(isPick), (p) => p.pickId);
  const targets = uniqueBy((Array.isArray(v2 ? raw.targets : raw.games) ? ((v2 ? raw.targets : raw.games) as unknown[]) : []).filter(isTarget), (t) => t.gameId)
    .slice(0, MAX_SLIP_TARGETS)
    .map(toTarget);
  const legCount = typeof legacyIn.legCount === "number" && legacyIn.legCount >= 1 ? Math.floor(legacyIn.legCount) : EMPTY_LEGACY.legCount;
  const state: SlipStateV2 = {
    version: 2,
    picks,
    targets,
    // An old slip with a `leagueScope` map instead is not read: its "off"
    // entries were the old MLB-only default, not the user's choice.
    excludedLeagues: strings(raw.excludedLeagues),
    legacy: { legCount },
  };
  return state;
}

export function serializeSlip(state: SlipStateV2): string {
  return JSON.stringify(state);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
export type TargetedGame = SlipTarget & {
  // Targeted on purpose (the Live checkbox / a chip with ×).
  explicit: boolean;
  // A slip pick is on it: always in play, can't be untargeted while the pick is there.
  viaPicks: boolean;
};

// Every game in play, in the order they joined: explicit targets first as
// added, then any game that only a pick brings in.
export function targetedGames(state: Pick<SlipStateV2, "picks" | "targets">): TargetedGame[] {
  const pickGames = new Set(state.picks.map((p) => p.gameId));
  const out: TargetedGame[] = state.targets.map((t) => ({ ...t, explicit: true, viaPicks: pickGames.has(t.gameId) }));
  for (const p of state.picks) {
    if (out.some((g) => g.gameId === p.gameId)) continue;
    out.push({ gameId: p.gameId, gameLabel: p.gameLabel, gameTime: p.gameTime, leagueName: p.leagueName, explicit: false, viaPicks: true });
  }
  return out;
}

export function isTargetedViaPicks(state: Pick<SlipStateV2, "picks">, gameId: string): boolean {
  return state.picks.some((p) => p.gameId === gameId);
}

// What generateParlayAction is told: the explicit targets only. The picks'
// games are in play anyway (the engine adds them), and sending them as
// targets would turn a full-slate build into a targeted one.
export function generatorTargets(state: Pick<SlipStateV2, "targets">): { gameId: string; leagueName: string }[] {
  return state.targets.map((t) => ({ gameId: t.gameId, leagueName: t.leagueName }));
}

export type SlipChange = { state: SlipStateV2; refused?: "PICK_CAP" | "TARGET_CAP" | "VIA_PICKS" };

// Targets and untargets a game. A game a pick is on can't be untargeted (it
// stays in play through the pick) - refused, nothing changes. Over
// MAX_SLIP_TARGETS is refused whole.
export function toggleTarget(state: SlipStateV2, game: SlipTarget): SlipChange {
  const has = state.targets.some((t) => t.gameId === game.gameId);
  if (has) return { state: { ...state, targets: state.targets.filter((t) => t.gameId !== game.gameId) } };
  if (isTargetedViaPicks(state, game.gameId)) return { state, refused: "VIA_PICKS" };
  if (state.targets.length >= MAX_SLIP_TARGETS) return { state, refused: "TARGET_CAP" };
  return { state: { ...state, targets: [...state.targets, toTarget(game)], excludedLeagues: switchOn(state.excludedLeagues, [game.leagueName]) } };
}

// ---------------------------------------------------------------------------
// Picks (Live's checkboxes write straight into the slip - no Confirm)
// ---------------------------------------------------------------------------
const switchOn = (excluded: string[], leagues: string[]) => (excluded.some((l) => leagues.includes(l)) ? excluded.filter((l) => !leagues.includes(l)) : excluded);

// Adds a pick, or removes it if it is already there. Past MAX_PARLAY_LEGS
// picks it is refused, nothing added. A new pick switches its league on.
export function togglePick(state: SlipStateV2, pick: SlipPick): SlipChange {
  if (state.picks.some((p) => p.pickId === pick.pickId)) return { state: removePick(state, pick.pickId) };
  if (state.picks.length >= MAX_PARLAY_LEGS) return { state, refused: "PICK_CAP" };
  return { state: { ...state, picks: [...state.picks, pick], excludedLeagues: switchOn(state.excludedLeagues, [pick.leagueName]) } };
}

export function removePick(state: SlipStateV2, pickId: string): SlipStateV2 {
  return { ...state, picks: state.picks.filter((p) => p.pickId !== pickId) };
}

// After Send to FanDuel: the slip starts over. The league scope stays.
export function clearedSlip(state: SlipStateV2): SlipStateV2 {
  return { ...state, picks: [], targets: [] };
}

// ---------------------------------------------------------------------------
// "3 picks removed — games started": the one quiet line Your Picks shows, in
// place of the old banner on every tab. It clears itself.
// ---------------------------------------------------------------------------
export const REMOVED_LINE_MS = 30_000;

export type RemovedLine = { count: number; until: number };

export function addRemoved(line: RemovedLine | null, count: number, now: number): RemovedLine | null {
  if (count <= 0) return line;
  const live = line && line.until > now ? line.count : 0;
  return { count: live + count, until: now + REMOVED_LINE_MS };
}

export function removedLineText(line: RemovedLine | null, now: number): string | null {
  if (!line || line.until <= now) return null;
  return `${line.count} pick${line.count === 1 ? "" : "s"} removed — games started`;
}
