// What the server knows about the picks on a Parlay slip. The slip itself
// lives in the browser (parlay-pool-context.tsx), so everything it sends is
// only a list of pick ids to look up here: the rows are read scoped to the
// signed-in user, and each pick's game - its teams, its id and above all its
// real kickoff - comes from the same Live board the pick was added from
// (getLiveBoardData), never from the client and never from the pick row's own
// gameTime. That stored time is the game's start only when the import matched
// a game; when it didn't, it is the import time.
import type { Capper, Pick } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { LIVE_SPORTS } from "@/server/data/odds";
import { getLiveBoardData, type LiveBoardData } from "@/server/data/live-board-picks";
import { toExpanderPick, gameStatusFor } from "@/server/data/expander-pick";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import { OFF_BOARD_GAME_PREFIX } from "@/lib/parlay/game-over";
import { findBoardGameForPick } from "@/lib/parlay/off-board-game";
import { MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";
import { SPORT_LABEL_TO_KEY } from "@/lib/sport-seasons";

export type SlipPickRow = Pick & { capper: Capper; sport: { name: string } };

// An id that isn't this user's pick (someone else's, deleted, made up) is
// simply absent from the result.
export async function getOwnedSlipPickRows(userId: string, pickIds: string[]): Promise<SlipPickRow[]> {
  if (pickIds.length === 0) return [];
  return prisma.pick.findMany({
    where: { userId, id: { in: pickIds } },
    include: { capper: true, sport: { select: { name: true } } },
  });
}

export type SlipBoard = { key: string; label: string; board: LiveBoardData };

function liveSportFor(row: SlipPickRow) {
  return LIVE_SPORTS.find((s) => s.label.toLowerCase() === row.sport.name.toLowerCase());
}

// One board per league among `rows`. Sequential, not Promise.all: each
// league's board load runs its own picks query, and firing all of them at
// once is the connection-pool pressure getPicksForGames' own comment warns
// about.
// `alsoLeagues` (Live league labels) adds boards no row needs - a slip game
// item's league, or the leagues Build from slip fills from.
export async function loadSlipBoards(userId: string, rows: SlipPickRow[], alsoLeagues: string[] = []): Promise<SlipBoard[]> {
  const boards: SlipBoard[] = [];
  for (const sport of LIVE_SPORTS) {
    if (!rows.some((r) => liveSportFor(r) === sport) && !alsoLeagues.includes(sport.label)) continue;
    boards.push({ key: sport.key, label: sport.label, board: await getLiveBoardData(userId, sport.key, sport.label) });
  }
  return boards;
}

// Each wanted pick as the board shows it, under the game the board put it on.
// Its gameTime is that game's commenceTime - the real kickoff. A pick the
// board has no game for is absent.
export function picksOnBoards(boards: SlipBoard[], pickIds: Iterable<string>): Map<string, GeneratorPick> {
  const wanted = new Set(pickIds);
  const found = new Map<string, GeneratorPick>();
  for (const { board } of boards) {
    for (const picks of board.expanderPicksByGame) {
      for (const p of picks) {
        if (wanted.has(p.pickId) && typeof p.datePosted === "string") found.set(p.pickId, p as GeneratorPick);
      }
    }
  }
  return found;
}

// A pick the board has no pick-to-game match for, built from its own row: its
// stored teams and time stand in for the game's. Given the boards, it is first
// keyed to the real game by teams and time (findBoardGameForPick), so the
// generator's max legs per game and same-game rules count it against that game.
// Only with no such game does it get an id of its own ("pick:<id>"), never taken
// for the same game as another leg's, and no board game offers it an alternate.
export function offBoardSlipPick(row: SlipPickRow, boards: SlipBoard[] = []): GeneratorPick {
  const sport = liveSportFor(row);
  const board = boards.find((b) => b.label === sport?.label);
  const real = board ? findBoardGameForPick(row, board.board.odds, SPORT_LABEL_TO_KEY[board.label], MAX_GAME_TIME_DRIFT_MS) : null;
  return toExpanderPick(
    row,
    real
      ? { id: real.id, homeTeam: real.homeTeam, awayTeam: real.awayTeam, commenceTime: real.commenceTime }
      : { id: OFF_BOARD_GAME_PREFIX + row.id, homeTeam: row.homeTeam, awayTeam: row.awayTeam, commenceTime: row.gameTime.toISOString() },
    sport?.key ?? "",
    sport?.label ?? row.sport.name,
    real && board ? gameStatusFor(board.board.scores, real, SPORT_LABEL_TO_KEY[board.label]) : null
  );
}
