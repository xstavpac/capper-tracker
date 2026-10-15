"use server";

// Auto Hedge / Contrarian for the Select-Your-Own-Picks flow (/parlay's "My
// Picks" section - see docs/parlay-white-paper.md Section 2.1, three modes
// over one primary pool). Mirrors autoGenerateParlayAction's shape
// (parlay-generator.ts) closely on purpose: same getLiveBoardData/
// getCapperCategoryRecords calls, same buildSwapParlay call - the only new
// piece is buildPoolPrimary (lib/parlay/pool-swap.ts), which builds the
// primary parlay from the user's pool instead of the full slate's top pick
// per game. Runs server-side because buildPoolPrimary/buildSwapParlay's
// module graph reaches server/data/picks + prisma.
//
// The slip lives in the browser, so the request names its picks by id only.
// Every pick this builds from is read here (parlay-slip-picks.ts): the row
// scoped to the signed-in user, its game from the Live board. Nothing about
// a pick - its capper, bet, odds, teams or kickoff - is taken from the client.
import { requireUser } from "@/server/auth";
import { getCapperCategoryRecords, getCapperLeagueRecords, type CapperLeagueRecords } from "@/server/data/picks";
import { getOwnedSlipPickRows, loadSlipBoards, offBoardSlipPick, picksOnBoards, type SlipBoard } from "@/server/data/parlay-slip-picks";
import { LIVE_SPORTS } from "@/server/data/odds";
import { autoGenerateWindow } from "@/lib/parlay/auto-generate-window";
import { buildFromSlip, toSlipSource, type SlipBuild, type SlipSource } from "@/lib/parlay/slip-build";
import type { PickCategoryKey } from "@/server/data/stats";
import { buildPoolPrimary, excludeSelectedPicks } from "@/lib/parlay/pool-swap";
import { legCapRejection, MAX_POOL_REQUEST_PICKS, type ParlayRejection } from "@/lib/parlay/leg-cap";
import type { SkippedPick, UnverifiedPair } from "@/lib/parlay/build-my-picks";
import {
  buildSwapParlay,
  type AutoParlay,
  type GeneratorGame,
  type GeneratorPick,
  type SwapMode,
  type SwapParlay,
} from "@/lib/parlay/auto-generate";

export type PoolSwapResult = {
  parlayA: AutoParlay; // the primary legs Hedge/Contrarian swapped from - same construction as My Picks
  swap: SwapParlay;
  skipped: SkippedPick[];
  unverified: UnverifiedPair[];
  requested: number;
  shortfall: number;
  // For PickCard's record block on every rendered pick.
  records: CapperLeagueRecords;
  leaguesSearched: string[];
};

const INVALID_REQUEST = "That request isn't valid - refresh the page and try again.";
const TOO_MANY_PICKS = `Too many picks in one request - ${MAX_POOL_REQUEST_PICKS} at most.`;
const SLIP_CHANGED = "Your slip has changed - a pick was graded or removed. Refresh the page and try again.";
const MAX_PICK_ID_LENGTH = 64;

// The request's pick ids, de-duplicated - or why it is refused. Checked
// before anything is read: the arguments arrive from the browser, so their
// declared types are only what an honest client sends.
function requestedPickIds(pickIds: unknown): string[] | ParlayRejection {
  if (!Array.isArray(pickIds)) return { error: INVALID_REQUEST };
  if (pickIds.length > MAX_POOL_REQUEST_PICKS) return { error: TOO_MANY_PICKS };
  if (!pickIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_PICK_ID_LENGTH)) {
    return { error: INVALID_REQUEST };
  }
  return Array.from(new Set(pickIds as string[]));
}

// `pickIds` are the slip picks the caller wants considered - already filtered
// to in-scope leagues by the caller (ParlayPoolSection), same convention as
// buildMyPicks() there. Bounded by however many conflict-free legs they can
// supply (see build-my-picks.ts) and by MAX_PARLAY_LEGS, the same ceiling
// Auto-Generate has: more than that is refused outright, never built smaller
// than asked (see leg-cap.ts). A request that names a pick which isn't this
// user's own pending pick is refused the same way - never built without it.
export async function generatePoolSwapAction(
  pickIds: string[],
  legCount: number,
  mode: SwapMode
): Promise<PoolSwapResult | ParlayRejection> {
  const user = await requireUser();
  const rejection = legCapRejection(legCount);
  if (rejection) return rejection;
  if (mode !== "AUTO_HEDGE" && mode !== "CONTRARIAN") return { error: INVALID_REQUEST };
  const ids = requestedPickIds(pickIds);
  if (!Array.isArray(ids)) return ids;
  const requested = Math.max(1, Math.floor(legCount) || 1);

  const rows = await getOwnedSlipPickRows(user.id, ids);
  if (rows.length !== ids.length || rows.some((r) => r.status !== "PENDING")) return { error: SLIP_CHANGED };

  // One board per league on the slip: each pick is placed on its game here,
  // and the same boards supply the alternates below.
  const boards = await loadSlipBoards(user.id, rows);
  const onBoard = picksOnBoards(boards, ids);
  // In the order the slip sent them, so nothing below depends on DB order.
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const poolPicks: GeneratorPick[] = ids.map((id) => onBoard.get(id) ?? offBoardSlipPick(rowById.get(id)!));

  const records = await getCapperLeagueRecords(
    user.id,
    poolPicks.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }))
  );

  const primary = buildPoolPrimary(poolPicks, records, requested);

  // Alternates only from leagues actually present in the built primary legs -
  // buildSwapParlay only ever looks up a leg's own gameId, so any other
  // league's slate would never be read.
  const leaguesInPrimary = new Set(primary.parlayA.legs.map((l) => l.top.pick.leagueName));
  const primaryBoards = boards.filter((b) => leaguesInPrimary.has(b.label));

  const now = new Date();
  const games: GeneratorGame[] = [];
  for (const { label, board } of primaryBoards) {
    board.odds.forEach((game, i) => {
      const start = new Date(game.commenceTime);
      // Only an unstarted game can offer a substitution. A primary leg whose
      // game already started, or whose gameId never appears in this fetched
      // slate at all, simply has no entry in `games` - buildSwapParlay
      // already treats a missing gameId as "no alternates" and keeps that
      // leg unchanged (auto-generate.ts: `picksByGame.get(leg.gameId) ?? []`).
      if (start.getTime() <= now.getTime()) return;
      const picks = board.expanderPicksByGame[i].filter(
        (p): p is GeneratorPick => p.status === "PENDING" && typeof p.datePosted === "string"
      );
      games.push({
        gameId: game.id,
        gameLabel: picks[0]?.gameLabel ?? game.awayTeam + " @ " + game.homeTeam,
        gameTime: game.commenceTime,
        leagueName: label,
        picks,
      });
    });
  }

  // See excludeSelectedPicks' own comment (lib/parlay/pool-swap.ts): a
  // pool-driven primary can have two legs from the same game, so a sibling
  // leg's own pick must never resurface as a "swap" suggestion for another
  // leg in that game.
  const gamesForSwap = excludeSelectedPicks(games, primary.parlayA);

  const allPicks = gamesForSwap.flatMap((g) => g.picks);
  const categoryRecords = await getCapperCategoryRecords(
    user.id,
    allPicks
      .filter((p): p is GeneratorPick & { category: PickCategoryKey } => p.category !== null)
      .map((p) => ({ capperId: p.capperId, category: p.category }))
  );

  // The `records` fetched above only covers the pool's own picks (what
  // buildPoolPrimary needed to rank them) - a swap's alternate pick belongs
  // to a different capper entirely, so PickCard would render it with no
  // record at all without also covering the catalog. Re-fetch over the
  // union, same shape autoGenerateParlayAction fetches for its own full
  // slate (parlay-generator.ts).
  const renderRecords = await getCapperLeagueRecords(
    user.id,
    [...poolPicks, ...allPicks].map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }))
  );

  return {
    parlayA: primary.parlayA,
    swap: buildSwapParlay(primary.parlayA, gamesForSwap, mode, categoryRecords),
    skipped: primary.skipped,
    unverified: primary.unverified,
    requested: primary.requested,
    shortfall: primary.shortfall,
    records: renderRecords,
    leaguesSearched: primaryBoards.map((b) => b.label),
  };
}

// ---------------------------------------------------------------------------
// Build from slip (My Picks' build - see lib/parlay/slip-build.ts). The slip
// sends what it holds by id: its picks, its games, which are locked, plus the
// Source and the in-scope leagues the qualified pool fills from. Everything
// about a pick or a game is read here, the same way as above.
// ---------------------------------------------------------------------------
export type SlipRequestItem =
  | { kind: "PICK"; pickId: string; locked: boolean }
  | { kind: "GAME"; gameId: string; leagueName: string; locked: boolean };

export type SlipBuildResult = SlipBuild & {
  // For each leg's record line.
  records: CapperLeagueRecords;
};

const LOCKED_GAME_GONE = "A locked game has started or is no longer on the board - remove it from your slip and try again.";
const LIVE_LABELS = new Set(LIVE_SPORTS.map((s) => s.label));

// The request's items - or why it is refused. Checked before anything is
// read, like requestedPickIds above.
function requestedSlipItems(items: unknown): SlipRequestItem[] | ParlayRejection {
  if (!Array.isArray(items)) return { error: INVALID_REQUEST };
  if (items.length > MAX_POOL_REQUEST_PICKS) return { error: TOO_MANY_PICKS };
  const out: SlipRequestItem[] = [];
  const seen = new Set<string>();
  for (const raw of items as unknown[]) {
    if (typeof raw !== "object" || raw === null) return { error: INVALID_REQUEST };
    const item = raw as Record<string, unknown>;
    const locked = item.locked === true;
    if (item.kind === "PICK") {
      const id = item.pickId;
      if (typeof id !== "string" || id.length === 0 || id.length > MAX_PICK_ID_LENGTH) return { error: INVALID_REQUEST };
      if (seen.has("p:" + id)) continue;
      seen.add("p:" + id);
      out.push({ kind: "PICK", pickId: id, locked });
    } else if (item.kind === "GAME") {
      const { gameId, leagueName } = item;
      if (typeof gameId !== "string" || gameId.length === 0 || gameId.length > MAX_PICK_ID_LENGTH) return { error: INVALID_REQUEST };
      if (typeof leagueName !== "string" || !LIVE_LABELS.has(leagueName)) return { error: INVALID_REQUEST };
      if (seen.has("g:" + gameId)) continue;
      seen.add("g:" + gameId);
      out.push({ kind: "GAME", gameId, leagueName, locked });
    } else {
      return { error: INVALID_REQUEST };
    }
  }
  return out;
}

// A board's games that pass `keep`, each with its pending picks - the same
// shape autoGenerateParlayAction builds (parlay-generator.ts).
function boardGames(label: string, board: SlipBoard["board"], keep: (commenceTime: string) => boolean): GeneratorGame[] {
  const games: GeneratorGame[] = [];
  board.odds.forEach((game, i) => {
    if (!keep(game.commenceTime)) return;
    const picks = board.expanderPicksByGame[i].filter(
      (p): p is GeneratorPick => p.status === "PENDING" && typeof p.datePosted === "string"
    );
    games.push({
      gameId: game.id,
      gameLabel: picks[0]?.gameLabel ?? game.awayTeam + " @ " + game.homeTeam,
      gameTime: game.commenceTime,
      leagueName: label,
      picks,
    });
  });
  return games;
}

// `leagues` are the slip's in-scope leagues: the qualified pool is their
// games in Auto-Generate's own window (auto-generate-window.ts). Ignored for
// SLIP_ONLY. Bounded by MAX_PARLAY_LEGS like every other build.
export async function buildSlipParlayAction(
  items: SlipRequestItem[],
  legCount: number,
  source: SlipSource,
  leagues: string[]
): Promise<SlipBuildResult | ParlayRejection> {
  const user = await requireUser();
  const rejection = legCapRejection(legCount);
  if (rejection) return rejection;
  const parsed = requestedSlipItems(items);
  if (!Array.isArray(parsed)) return parsed;
  if (!Array.isArray(leagues) || !leagues.every((l) => typeof l === "string")) return { error: INVALID_REQUEST };
  const src = toSlipSource(source);
  const requested = Math.max(1, Math.floor(legCount) || 1);

  const pickItems = parsed.filter((i): i is Extract<SlipRequestItem, { kind: "PICK" }> => i.kind === "PICK");
  const gameItems = parsed.filter((i): i is Extract<SlipRequestItem, { kind: "GAME" }> => i.kind === "GAME");
  const ids = pickItems.map((i) => i.pickId);
  const rows = await getOwnedSlipPickRows(user.id, ids);
  if (rows.length !== ids.length || rows.some((r) => r.status !== "PENDING")) return { error: SLIP_CHANGED };

  const poolLeagues = src === "SLIP_PLUS_POOL" ? leagues.filter((l) => LIVE_LABELS.has(l)) : [];
  const boards = await loadSlipBoards(user.id, rows, [...gameItems.map((g) => g.leagueName), ...poolLeagues]);
  const onBoard = picksOnBoards(boards, ids);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const picks = pickItems.map((i) => ({ pick: onBoard.get(i.pickId) ?? offBoardSlipPick(rowById.get(i.pickId)!), locked: i.locked }));

  const now = new Date();
  const unstarted = (commenceTime: string) => new Date(commenceTime).getTime() > now.getTime();
  const games: { game: GeneratorGame; locked: boolean }[] = [];
  for (const item of gameItems) {
    const board = boards.find((b) => b.label === item.leagueName);
    const game = board ? boardGames(board.label, board.board, unstarted).find((g) => g.gameId === item.gameId) : undefined;
    // An unlocked game that has started simply has nothing to offer; a
    // locked one can't be honoured, and says so.
    if (!game) {
      if (item.locked) return { error: LOCKED_GAME_GONE };
      continue;
    }
    games.push({ game, locked: item.locked });
  }

  const pool: GeneratorGame[] = [];
  for (const { label, board } of boards) {
    if (!poolLeagues.includes(label)) continue;
    const inWindow = autoGenerateWindow(label, board.odds.map((g) => g.commenceTime), now);
    pool.push(...boardGames(label, board, inWindow));
  }

  const allPicks = [...picks.map((i) => i.pick), ...games.flatMap((g) => g.game.picks), ...pool.flatMap((g) => g.picks)];
  const records = await getCapperLeagueRecords(
    user.id,
    allPicks.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }))
  );

  const built = buildFromSlip({ picks, games, pool, records, legCount: requested, source: src });
  if ("error" in built) return built;
  return { ...built, records };
}
