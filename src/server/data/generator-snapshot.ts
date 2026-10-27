// The Parlay Generator's snapshot: the pool of games and pending picks in scope,
// the slip's picks, and both record maps. One loader for both generators -
// Standard (actions/parlay-generate.ts) and Consensus Hybrid
// (actions/parlay-hybrid.ts) - so the pool, the window and the record hierarchy
// can never drift apart.
//
// Reads, per call: the slip's own rows (getOwnedSlipPickRows - none for an empty
// slip), one board per league needed (getLiveBoardData - sequential, as
// everywhere), and ONE record bundle (getCapperRecordBundle: every slip pick's
// and candidate's card - its in-league and all-time market record - in a single
// query). Nothing about a pick or a game is taken from the client: the request
// names picks and games by id.
import { getCapperRecordBundle } from "@/server/data/picks";
import { gameStatusFor } from "@/server/data/expander-pick";
import { isGameOver } from "@/lib/parlay/game-over";
import { getOwnedSlipPickRows, loadSlipBoards, offBoardSlipPick, picksOnBoards } from "@/server/data/parlay-slip-picks";
import type { PickCategoryKey } from "@/server/data/stats";
import { autoGenerateWindow } from "@/lib/parlay/auto-generate-window";
import { doubleheaderGameIds } from "@/lib/parlay/doubleheader";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";

export const SLIP_CHANGED = "Your slip has changed - a pick was graded or removed. Refresh the page and try again.";

export type SnapshotScope = {
  // League scope: the full slate (no targets) is these leagues' games in
  // Auto-Generate's window (auto-generate-window.ts).
  leagues: string[];
  slipPickIds: string[];
  targets: { gameId: string; leagueName: string }[];
};

export type LoadedSnapshot = {
  snapshot: GeneratorSnapshot;
  // The Odds API sport key each game lists under (gameId -> key), from its board
  // row: the key its event-level odds are asked for under.
  eventSportKeys: Record<string, string>;
};

export async function loadGeneratorSnapshot(userId: string, scope: SnapshotScope, now: Date): Promise<LoadedSnapshot | ParlayRejection> {
  const rows = await getOwnedSlipPickRows(userId, scope.slipPickIds);
  if (rows.length !== scope.slipPickIds.length || rows.some((r) => r.status !== "PENDING")) return { error: SLIP_CHANGED };

  // Every league anything comes from: the scope, the targets, the slip.
  const boards = await loadSlipBoards(userId, rows, [...scope.leagues, ...scope.targets.map((t) => t.leagueName)]);
  const onBoard = picksOnBoards(boards, scope.slipPickIds);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const slipPicks: GeneratorPick[] = scope.slipPickIds.map((id) => onBoard.get(id) ?? offBoardSlipPick(rowById.get(id)!, boards));
  const slipGameIds = new Set(slipPicks.map((p) => p.gameId));
  const targetIds = new Set(scope.targets.map((t) => t.gameId));
  const fullSlate = scope.targets.length === 0;

  const games: GeneratorGame[] = [];
  const eventSportKeys: Record<string, string> = {};
  for (const { key, label, board } of boards) {
    const inWindow = autoGenerateWindow(label, board.odds.map((g) => g.commenceTime), now);
    // From the whole board: the other game of a doubleheader may already be under way.
    const doubleheaders = doubleheaderGameIds(board.odds, board.scores);
    board.odds.forEach((game, i) => {
      // A live game is fine for a target or a slip pick (it is priced as posted);
      // only a game that is over is skipped, and the full slate never reaches
      // for a game already under way (inWindow).
      const gameStatus = gameStatusFor(board.scores, game, key);
      if (isGameOver({ gameTime: game.commenceTime, gameStatus }, now)) return;
      const wanted =
        targetIds.has(game.id) || slipGameIds.has(game.id) || (fullSlate && scope.leagues.includes(label) && inWindow(game.commenceTime));
      if (!wanted) return;
      const picks = board.expanderPicksByGame[i].filter(
        (p): p is GeneratorPick => p.status === "PENDING" && typeof p.datePosted === "string"
      );
      games.push({
        gameId: game.id,
        gameLabel: picks[0]?.gameLabel ?? game.awayTeam + " @ " + game.homeTeam,
        gameTime: game.commenceTime,
        gameStatus,
        leagueName: label,
        picks,
        doubleheader: doubleheaders.has(game.id),
      });
      eventSportKeys[game.id] = game.sportKey ?? key;
    });
  }

  // ONE record bundle: every slip pick's and candidate's card. A slip pick's
  // is what its row shows and how two conflicting slip picks are ranked; a
  // candidate's in-league record (all-time when it has none) is the 55% gate,
  // the Wilson ranking, Hedge and Contrarian (recordForGate). The all-leagues
  // market records cover a pick with no card, and LEGACY_RULES.
  const candidates = games.flatMap((g) => g.picks);
  const { leagueRecords, categoryRecords } = await getCapperRecordBundle(userId, {
    leagueEntries: [...slipPicks, ...candidates].map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category })),
    categoryPairs: candidates
      .filter((p): p is GeneratorPick & { category: PickCategoryKey } => p.category !== null)
      .map((p) => ({ capperId: p.capperId, category: p.category })),
  });

  return {
    snapshot: {
      builtAt: now.toISOString(),
      games,
      slipPicks,
      targets: scope.targets.map((t) => t.gameId),
      leagueRecords,
      categoryRecords,
    },
    eventSportKeys,
  };
}
