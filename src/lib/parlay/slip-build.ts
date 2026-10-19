// "Build from slip": My Picks' build (selectConflictFreeLegs, build-my-picks.ts)
// over a slip that holds picks AND games, any of them locked, from a Source:
//
//   - A PICK item is that exact pick.
//   - A GAME item means "the best pick from this game": every pending pick on
//     it is a candidate at its own rank, and the first one that fits is taken
//     (at most one leg from the game - onePerGame).
//   - A LOCKED pick is in the parlay, always. A LOCKED game puts its best pick
//     that fits with the locked picks into the parlay. Locked legs are placed
//     first (selectConflictFreeLegs' seed); a lock that can't be honoured is an
//     error that names it, never a silent drop.
//   - Source SLIP_ONLY builds from the slip's items alone - a shortfall is
//     reported, never filled from outside. SLIP_PLUS_POOL adds the qualified
//     pool - Auto-Generate's in-window games - as one-leg-per-game candidates
//     that compete with the unlocked slip items on the same ranking and fill
//     whatever is left.
//
// One ranking throughout: compareByRecord on bestAvailableRecord, the record
// the pick's own card shows (pick-record.ts) - the same ranking My Picks and
// Parlay A already use. No qualification gate is applied to slip picks.
//
// With only unlocked picks and SLIP_ONLY this is exactly today's My Picks
// build: same ranking, same selectConflictFreeLegs walk, no seed.
//
// Pure - no DB access.
import { blocks, selectConflictFreeLegs, type BuildCandidate, type SkippedPick, type UnverifiedPair } from "@/lib/parlay/build-my-picks";
import { bestAvailableRecord, compareByRecord } from "@/lib/parlay/pick-record";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";
import type { CapperLeagueRecords } from "@/server/data/picks";

export type SlipSource = "SLIP_ONLY" | "SLIP_PLUS_POOL";

export const SLIP_SOURCE_OPTIONS: readonly { key: SlipSource; label: string }[] = [
  { key: "SLIP_ONLY", label: "Slip only" },
  { key: "SLIP_PLUS_POOL", label: "Slip + qualified picks" },
];

// Never trusted as sent: anything unknown is the default.
export function toSlipSource(value: unknown): SlipSource {
  return value === "SLIP_ONLY" ? "SLIP_ONLY" : "SLIP_PLUS_POOL";
}

export type SlipBuildInput = {
  picks: { pick: GeneratorPick; locked: boolean }[];
  // The slip's game items, as the board has them now (pending picks only).
  games: { game: GeneratorGame; locked: boolean }[];
  // The qualified pool's games. Read only for SLIP_PLUS_POOL.
  pool: GeneratorGame[];
  records: CapperLeagueRecords;
  legCount: number;
  source: SlipSource;
};

export type SlipBuild = {
  // In the order they were taken: locked legs first, then best first.
  legs: GeneratorPick[];
  lockedPickIds: string[];
  // Legs that are a slip pick, or a slip game's pick - the rest came from the pool.
  slipPickIds: string[];
  skipped: SkippedPick[];
  unverified: UnverifiedPair[];
  requested: number;
  shortfall: number;
  source: SlipSource;
};

const pickLabel = (p: GeneratorPick) => `${p.capperName} — ${p.betDetail}`;

export function buildFromSlip(input: SlipBuildInput): SlipBuild | ParlayRejection {
  const { records, legCount: n, source } = input;
  const rank = (picks: GeneratorPick[]) =>
    picks
      .map((pick) => ({ pick, pickId: pick.pickId, record: bestAvailableRecord(pick, records) }))
      .sort(compareByRecord)
      .map((r) => r.pick);

  // ---- Locks -------------------------------------------------------------
  const lockedPicks = rank(input.picks.filter((i) => i.locked).map((i) => i.pick));
  const errors: string[] = [];
  for (let i = 0; i < lockedPicks.length; i++) {
    for (let j = i + 1; j < lockedPicks.length; j++) {
      const { blocked, isDuplicate } = blocks(toBuildCandidate(lockedPicks[i]), toBuildCandidate(lockedPicks[j]));
      if (blocked) {
        errors.push(
          `Locked picks ${pickLabel(lockedPicks[i])} and ${pickLabel(lockedPicks[j])} ${isDuplicate ? "are the same bet" : "conflict"} - unlock one.`
        );
      }
    }
  }
  if (errors.length > 0) return { error: errors.join(" ") };

  // A locked game is already satisfied by a locked pick on it.
  const lockedPickGames = new Set(lockedPicks.map((p) => p.gameId));
  const lockedGames = input.games.filter((g) => g.locked && !lockedPickGames.has(g.game.gameId)).map((g) => g.game);
  const lockCount = lockedPicks.length + lockedGames.length;
  if (lockCount > n) {
    return { error: `${lockCount} slip items are locked, but the parlay is only ${n} leg${n === 1 ? "" : "s"} - unlock some or add legs.` };
  }

  // Conflicts and duplicates are same-game only, and a locked game with a
  // locked pick on it was dropped above - so nothing locked can block a
  // locked game's best pick, and that pick is its leg.
  const seed: GeneratorPick[] = [...lockedPicks];
  for (const game of lockedGames) {
    if (game.picks.length === 0) errors.push(`Locked game ${game.gameLabel} has no pending picks from your cappers.`);
    else seed.push(rank(game.picks)[0]);
  }
  if (errors.length > 0) return { error: errors.join(" ") };

  // ---- Candidates ----------------------------------------------------------
  const seedIds = new Set(seed.map((p) => p.pickId));
  const slipPickIds = new Set(input.picks.map((i) => i.pick.pickId));
  const candidates = new Map<string, BuildCandidate>();
  const byId = new Map<string, GeneratorPick>(seed.map((p) => [p.pickId, p]));
  const offer = (p: GeneratorPick, onePerGame: boolean) => {
    if (seedIds.has(p.pickId) || candidates.has(p.pickId)) return;
    byId.set(p.pickId, p);
    candidates.set(p.pickId, { ...toBuildCandidate(p, records), onePerGame });
  };
  // The user's own picks first, so a pick that is also on a game item keeps
  // its standing as the user's pick (not limited to one per game).
  for (const { pick, locked } of input.picks) if (!locked) offer(pick, false);
  const lockedGameIds = new Set(lockedGames.map((g) => g.gameId));
  for (const { game, locked } of input.games) if (!locked && !lockedGameIds.has(game.gameId)) game.picks.forEach((p) => offer(p, true));
  if (source === "SLIP_PLUS_POOL") {
    // A game the slip already speaks for (a pick or a game item on it) is
    // the slip's, not the pool's.
    const slipGames = new Set([...input.picks.map((i) => i.pick.gameId), ...input.games.map((g) => g.game.gameId)]);
    for (const game of input.pool) if (!slipGames.has(game.gameId)) game.picks.forEach((p) => offer(p, true));
  }

  const ranked = rank(Array.from(candidates.keys()).map((id) => byId.get(id)!)).map((p) => candidates.get(p.pickId)!);
  const selection = selectConflictFreeLegs(
    ranked,
    n,
    seed.map((p) => toBuildCandidate(p, records))
  );
  const slipGameIds = new Set(input.games.map((g) => g.game.gameId));
  const legs = selection.legs.map((c) => byId.get(c.pickId)!);

  return {
    legs,
    lockedPickIds: seed.map((p) => p.pickId),
    slipPickIds: legs.filter((p) => slipPickIds.has(p.pickId) || slipGameIds.has(p.gameId)).map((p) => p.pickId),
    // Only the slip's own picks get a note: a game item's or the pool's
    // other picks being passed over is the ranking working, not news.
    skipped: selection.skipped.filter((s) => slipPickIds.has(s.pickId)),
    unverified: selection.unverified,
    requested: selection.requested,
    shortfall: selection.shortfall,
    source,
  };
}

// What a short build says under "Only K of N legs available", above its
// "Build with K legs" choice.
export function slipShortfallText(build: Pick<SlipBuild, "source">): string {
  return build.source === "SLIP_ONLY"
    ? `Slip only never adds picks from outside your slip. Switch Source to "Slip + qualified picks" to fill the rest from your cappers' other picks.`
    : `That counts your cappers' other upcoming picks in your in-scope leagues, one per game.`;
}
