"use server";

// The Parlay Generator's one server action (PR 4 of the consolidation). It
// loads the generator's SNAPSHOT - the pool of games and picks, the slip's
// picks and both record maps - and answers with it plus the Primary built from
// it (buildGeneratedParlay, lib/parlay/generator.ts).
//
// The snapshot goes back to the browser on purpose: Regenerate, and any
// setting that doesn't change the pool (leg count, max per game, Include
// Picks, Pick Mix, Fill from), runs the same pure engine there on the snapshot
// it already holds - no request, no database read. The browser only comes
// back here when the pool itself changes (slip picks, targets, leagues) or the
// snapshot goes stale (generator-session.ts decides).
//
// Reads, per call: the slip's own rows (getOwnedSlipPickRows), one board per
// league needed (getLiveBoardData - sequential, as everywhere), and ONE record
// bundle (getCapperRecordBundle: every slip pick's and candidate's card - its
// in-league and all-time market record - in a single query). Nothing about a pick or a game
// is taken from the client: the request names picks and games by id.
import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { getCapperRecordBundle } from "@/server/data/picks";
import { gameStatusFor } from "@/server/data/expander-pick";
import { isGameOver } from "@/lib/parlay/game-over";
import { getOwnedSlipPickRows, loadSlipBoards, offBoardSlipPick, picksOnBoards } from "@/server/data/parlay-slip-picks";
import type { PickCategoryKey } from "@/server/data/stats";
import { autoGenerateWindow } from "@/lib/parlay/auto-generate-window";
import { doubleheaderGameIds } from "@/lib/parlay/doubleheader";
import { normalizeMinWinPct } from "@/lib/parlay/gate";
import { legCapRejection, MAX_POOL_REQUEST_PICKS, type ParlayRejection } from "@/lib/parlay/leg-cap";
import { selectedCategories, toIncludeSelection, toPickMix } from "@/lib/parlay/include-picks";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import {
  buildGeneratedParlay,
  type FillFrom,
  type GeneratedParlay,
  type GeneratorSettings,
  type GeneratorSnapshot,
} from "@/lib/parlay/generator";

export type GenerateTarget = { gameId: string; leagueName: string };

export type GenerateRequest = {
  // League scope: the full slate (no targets) is these leagues' games in
  // Auto-Generate's window (auto-generate-window.ts).
  leagues: string[];
  slipPickIds: string[];
  targets: GenerateTarget[];
  settings: GeneratorSettings;
};

export type GenerateResponse = { snapshot: GeneratorSnapshot; parlay: GeneratedParlay };

const INVALID_REQUEST = "That request isn't valid - refresh the page and try again.";
const TOO_MANY = `Too many picks or games in one request - ${MAX_POOL_REQUEST_PICKS} at most.`;
const SLIP_CHANGED = "Your slip has changed - a pick was graded or removed. Refresh the page and try again.";
const MAX_ID_LENGTH = 64;
const LIVE_LABELS = new Set(LIVE_SPORTS.map((s) => s.label));
const okId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;

// Never trusted as sent: ids only, bounded, leagues from the Live list.
function parseRequest(raw: unknown): GenerateRequest | ParlayRejection {
  if (typeof raw !== "object" || raw === null) return { error: INVALID_REQUEST };
  const { leagues, slipPickIds, targets, settings } = raw as Record<string, unknown>;
  if (!Array.isArray(leagues) || !leagues.every((l) => typeof l === "string" && LIVE_LABELS.has(l))) return { error: INVALID_REQUEST };
  if (!Array.isArray(slipPickIds) || !Array.isArray(targets)) return { error: INVALID_REQUEST };
  if (slipPickIds.length > MAX_POOL_REQUEST_PICKS || targets.length > MAX_POOL_REQUEST_PICKS) return { error: TOO_MANY };
  if (!slipPickIds.every(okId)) return { error: INVALID_REQUEST };
  const parsedTargets: GenerateTarget[] = [];
  for (const t of targets) {
    if (typeof t !== "object" || t === null) return { error: INVALID_REQUEST };
    const { gameId, leagueName } = t as Record<string, unknown>;
    if (!okId(gameId) || typeof leagueName !== "string" || !LIVE_LABELS.has(leagueName)) return { error: INVALID_REQUEST };
    if (!parsedTargets.some((p) => p.gameId === gameId)) parsedTargets.push({ gameId, leagueName });
  }
  if (typeof settings !== "object" || settings === null) return { error: INVALID_REQUEST };
  const s = settings as Record<string, unknown>;
  const legCount = typeof s.legCount === "number" ? s.legCount : NaN;
  if (!Number.isFinite(legCount)) return { error: INVALID_REQUEST };
  const rejection = legCapRejection(legCount);
  if (rejection) return rejection;
  const fillFrom: FillFrom = s.fillFrom === "YOUR_PICKS_ONLY" ? "YOUR_PICKS_ONLY" : "BEST_AVAILABLE";
  const include = toIncludeSelection(s.include);
  return {
    leagues: Array.from(new Set(leagues as string[])),
    slipPickIds: Array.from(new Set(slipPickIds as string[])),
    targets: parsedTargets,
    settings: {
      legCount,
      maxLegsPerGame: typeof s.maxLegsPerGame === "number" ? s.maxLegsPerGame : 1,
      include,
      mix: toPickMix(s.mix, selectedCategories(include)),
      fillFrom,
      // Anything but a whole step in range is the 55% default.
      minWinPct: normalizeMinWinPct(s.minWinPct),
    },
  };
}

export async function generateParlayAction(request: GenerateRequest): Promise<GenerateResponse | ParlayRejection> {
  const user = await requireUser();
  const req = parseRequest(request);
  if ("error" in req) return req;

  const rows = await getOwnedSlipPickRows(user.id, req.slipPickIds);
  if (rows.length !== req.slipPickIds.length || rows.some((r) => r.status !== "PENDING")) return { error: SLIP_CHANGED };

  // Every league anything comes from: the scope, the targets, the slip.
  const boards = await loadSlipBoards(user.id, rows, [...req.leagues, ...req.targets.map((t) => t.leagueName)]);
  const now = new Date();
  const onBoard = picksOnBoards(boards, req.slipPickIds);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const slipPicks: GeneratorPick[] = req.slipPickIds.map((id) => onBoard.get(id) ?? offBoardSlipPick(rowById.get(id)!, boards));
  const slipGameIds = new Set(slipPicks.map((p) => p.gameId));
  const targetIds = new Set(req.targets.map((t) => t.gameId));
  const fullSlate = req.targets.length === 0;

  const games: GeneratorGame[] = [];
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
        targetIds.has(game.id) || slipGameIds.has(game.id) || (fullSlate && req.leagues.includes(label) && inWindow(game.commenceTime));
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
    });
  }

  // ONE record bundle: every slip pick's and candidate's card. A slip pick's
  // is what its row shows and how two conflicting slip picks are ranked; a
  // candidate's in-league record (all-time when it has none) is the 55% gate,
  // the Wilson ranking, Hedge and Contrarian (recordForGate). The all-leagues
  // market records cover a pick with no card, and LEGACY_RULES.
  const candidates = games.flatMap((g) => g.picks);
  const { leagueRecords, categoryRecords } = await getCapperRecordBundle(user.id, {
    leagueEntries: [...slipPicks, ...candidates].map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category })),
    categoryPairs: candidates
      .filter((p): p is GeneratorPick & { category: PickCategoryKey } => p.category !== null)
      .map((p) => ({ capperId: p.capperId, category: p.category })),
  });

  const snapshot: GeneratorSnapshot = {
    builtAt: now.toISOString(),
    games,
    slipPicks,
    targets: req.targets.map((t) => t.gameId),
    leagueRecords,
    categoryRecords,
  };
  return { snapshot, parlay: buildGeneratedParlay(snapshot, req.settings, null, now) };
}
