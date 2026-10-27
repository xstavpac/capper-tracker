// Consensus Hybrid's position builder: which side of each game the cappers
// agree on, and how strongly. Capper consensus picks the side of each leg; the
// later stages move each leg to a forgiving FanDuel alternate line and place
// the edges. This file only answers "what do the cappers back" - it reads the
// Parlay Generator's snapshot (generator.ts GeneratorSnapshot: pending picks on
// the in-scope games, plus both record maps), so it needs no database read of
// its own. Pure and client-safe.
//
// Markets: full-game spread, moneyline and game total (Over / Under). Props,
// team totals, NRFI and every period market (1H / F5 / quarters / hockey
// periods / regulation) are left out: the FanDuel ladders are full-game.
//
// Positions:
//   - Team side: a game + a team. Moneyline and spread supporters of the same
//     team merge into ONE position.
//   - Total: a game + Over, or a game + Under.
//
// Supporters are DISTINCT cappers. A post counts when its capper's record in
// that bet clears the generator's gate (pick-record.ts leagueFirstRecord: the
// league-specific category record, else the all-time category record - not yet
// the Standard generator's best-of-two recordForGate; the
// win-% gate of gate.ts, 55 by default). A capper's score is the Wilson lower
// bound of that record at the generator's own softer z (GENERATOR_Z, #324), so
// a mid-volume record sits close to a huge one. Only gated posts count at all:
// an ungated post is neither a supporter nor an opposer, and never moves the
// anchor.
//
// A capper with several posts on one position counts once. Their endorsed line
// is their HARDEST gated post, since a capper on -3 also endorses -2.5. For a
// team side, a moneyline is the pick'em line (0): it wins when the team wins
// outright, which is the same threshold as the spread at 0. For an Over the
// hardest post is the highest line; for an Under, the lowest.
//
// Anchor = the EASIEST endorsed line among the position's supporters: every
// supporter endorses that line and anything more forgiving. For a team side
// that is the largest of the supporters' endorsed lines (+7 beats -3, a
// moneyline-backed side anchors at 0 - its ladder starts at +1.5, never -1.5);
// for an Over the smallest, for an Under the largest.
//
// Opposers are gated cappers on the other side of the same family in the same
// game (the other team's ML or spread; the other direction of the total).
// A capper who posted BOTH sides of a family on one game has hedged, not
// endorsed: they are on neither side (they would otherwise add to the
// supporters' headcount and be subtracted from the same position's score).
//
// Score = the supporters' scores minus the opposers' scores. A position
// qualifies with at least HYBRID_MIN_SUPPORTERS supporters; positions come back
// best score first.
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { GENERATOR_Z, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { GATE_DEFAULT, normalizeMinWinPct } from "@/lib/parlay/gate";
import { hasKickedOff, isGameOver, OFF_BOARD_GAME_PREFIX } from "@/lib/parlay/game-over";
import { leagueFirstRecord } from "@/lib/parlay/pick-record";
import { qualifies, wilsonLowerBound } from "@/lib/parlay/qualification-core";
import { describePick } from "@/lib/parlay/relationship-classifier";

// Supporters a position needs. Tuned after the sparsity report (B6).
export const HYBRID_MIN_SUPPORTERS = 2;

export type HybridMarket = "SPREAD" | "MONEYLINE" | "TOTAL";
export type HybridFamily = "SIDE" | "TOTAL";

export type HybridRecord = {
  wins: number;
  losses: number;
  n: number;
  winPct: number;
  // The shipped hierarchy: the league-specific category record, else the all-time one.
  source: "LEAGUE" | "OVERALL";
};

export type PositionCapper = {
  capperId: string;
  capperName: string;
  record: HybridRecord;
  // The market of the post whose record this is (the capper's best-scoring post on the position).
  recordMarket: HybridMarket;
  // Wilson lower bound of `record` at the generator's z - what the score sums.
  score: number;
  // The hardest gated post on the position, as posted: its market and number
  // (null for a moneyline).
  postedMarket: HybridMarket;
  postedLine: number | null;
  // The same post on the position's own line scale (a team side: a moneyline is
  // 0; a total: the line), the number the anchor is taken from.
  endorsedLine: number;
  // Gated posts the capper has on the position.
  posts: number;
};

export type ConsensusPosition = {
  key: string;
  // The board game: its id is the Odds API event id.
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  sport: string;
  family: HybridFamily;
  // The team name (family SIDE), or "OVER" / "UNDER".
  direction: string;
  // The easiest endorsed line (see the header). A team side on a moneyline is 0.
  anchorLine: number;
  // True when the anchor is a moneyline: the side's ladder starts at +1.5.
  anchorIsMoneyline: boolean;
  // The supporters' endorsed lines, hardest to easiest (easiest is the anchor).
  postedLines: { hardest: number; easiest: number };
  lineSpread: number;
  supporters: PositionCapper[];
  opposers: PositionCapper[];
  score: number;
};

export type ConsensusOptions = {
  now: Date;
  // The win-% gate (gate.ts); absent or invalid is 55.
  minWinPct?: number;
  minSupporters?: number;
  z?: number;
};

type Post = {
  pick: GeneratorPick;
  family: HybridFamily;
  direction: string;
  market: HybridMarket;
  postedLine: number | null;
  endorsedLine: number;
  record: HybridRecord;
  score: number;
};

const MARKET_BY_BET_TYPE: Record<string, HybridMarket> = { SPREAD: "SPREAD", MONEYLINE: "MONEYLINE", TOTAL: "TOTAL" };

// The pick as a Post, or null when it is not one a hybrid position can use: not
// a full-game spread / moneyline / game total, the side or line cannot be read,
// or no gated record.
function toPost(pick: GeneratorPick, game: GeneratorGame, snapshot: Pick<GeneratorSnapshot, "leagueRecords" | "categoryRecords">, gate: number, z: number): Post | null {
  const market = MARKET_BY_BET_TYPE[pick.betType];
  if (!market || pick.period !== "FULL_GAME") return null;
  // The board cannot tell which game of a doubleheader a pick with no game number is on.
  if (game.doubleheader && pick.gameNumber == null) return null;

  const desc = describePick(
    { betType: pick.betType, period: pick.period, betDetail: pick.rawBetDetail, line: pick.line },
    { homeTeam: pick.homeTeam, awayTeam: pick.awayTeam, gameTime: new Date(pick.gameTime), sportName: pick.leagueName }
  );
  if (desc.status !== "OK" || desc.direction === null) return null;

  let family: HybridFamily;
  let postedLine: number | null;
  let endorsedLine: number;
  if (market === "TOTAL") {
    if (desc.direction !== "OVER" && desc.direction !== "UNDER") return null;
    if (desc.line === null || !Number.isFinite(desc.line)) return null;
    family = "TOTAL";
    postedLine = desc.line;
    endorsedLine = desc.line;
  } else {
    if (desc.direction !== pick.homeTeam && desc.direction !== pick.awayTeam) return null;
    family = "SIDE";
    if (market === "MONEYLINE") {
      postedLine = null;
      endorsedLine = 0;
    } else {
      if (desc.line === null || !Number.isFinite(desc.line)) return null;
      postedLine = desc.line;
      endorsedLine = desc.line;
    }
  }

  const record = leagueFirstRecord(pick, snapshot.leagueRecords, snapshot.categoryRecords);
  if (!record || !qualifies(record, gate)) return null;
  return {
    pick,
    family,
    direction: desc.direction,
    market,
    postedLine,
    endorsedLine,
    record: { wins: record.wins, losses: record.losses, n: record.n, winPct: record.winPct, source: record.source },
    score: wilsonLowerBound(record.wins, record.losses, z),
  };
}

// The line a post endorses is harder the further it is from the forgiving end:
// lower for a team side and an Over, higher for an Under.
function harder(a: Post, b: Post): boolean {
  if (a.family === "TOTAL" && a.direction === "UNDER") return a.endorsedLine < b.endorsedLine;
  if (a.family === "TOTAL") return a.endorsedLine > b.endorsedLine;
  return a.endorsedLine < b.endorsedLine;
}

// Best record first: higher score, then the larger sample, then pick id.
function betterRecord(a: Post, b: Post): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.record.n !== b.record.n) return a.record.n > b.record.n;
  return a.pick.pickId < b.pick.pickId;
}

// One capper's gated posts on one position, as a PositionCapper: their best
// record, and the hardest post as the endorsed line.
function toCapper(posts: Post[]): PositionCapper {
  let best = posts[0];
  let hardest = posts[0];
  for (const p of posts) {
    if (betterRecord(p, best)) best = p;
    if (harder(p, hardest) || (p.endorsedLine === hardest.endorsedLine && p.market === "MONEYLINE" && hardest.market !== "MONEYLINE")) hardest = p;
  }
  return {
    capperId: best.pick.capperId,
    capperName: best.pick.capperName,
    record: best.record,
    recordMarket: best.market,
    score: best.score,
    postedMarket: hardest.market,
    postedLine: hardest.postedLine,
    endorsedLine: hardest.endorsedLine,
    posts: posts.length,
  };
}

const byCapperScore = (a: PositionCapper, b: PositionCapper) =>
  b.score !== a.score ? b.score - a.score : b.record.n !== a.record.n ? b.record.n - a.record.n : a.capperId < b.capperId ? -1 : a.capperId > b.capperId ? 1 : 0;

export function buildConsensusPositions(
  snapshot: Pick<GeneratorSnapshot, "games" | "leagueRecords" | "categoryRecords">,
  opts: ConsensusOptions
): ConsensusPosition[] {
  const gate = normalizeMinWinPct(opts.minWinPct ?? GATE_DEFAULT);
  const minSupporters = opts.minSupporters ?? HYBRID_MIN_SUPPORTERS;
  const z = opts.z ?? GENERATOR_Z;
  const positions: ConsensusPosition[] = [];

  for (const game of snapshot.games) {
    // Unstarted games only; a slip pick's off-board game has no kickoff.
    if (game.gameId.startsWith(OFF_BOARD_GAME_PREFIX) || hasKickedOff(game.gameTime, opts.now) || isGameOver(game, opts.now)) continue;

    // direction -> capperId -> gated posts, per family.
    const sides: Record<HybridFamily, Map<string, Map<string, Post[]>>> = { SIDE: new Map(), TOTAL: new Map() };
    for (const pick of game.picks) {
      const post = toPost(pick, game, snapshot, gate, z);
      if (!post) continue;
      const byCapper = sides[post.family].get(post.direction) ?? new Map<string, Post[]>();
      byCapper.set(pick.capperId, [...(byCapper.get(pick.capperId) ?? []), post]);
      sides[post.family].set(post.direction, byCapper);
    }

    for (const family of ["SIDE", "TOTAL"] as const) {
      const directions = Array.from(sides[family].keys());
      // A capper on more than one direction of the family has hedged.
      const seen = new Map<string, number>();
      for (const d of directions) for (const id of sides[family].get(d)!.keys()) seen.set(id, (seen.get(id) ?? 0) + 1);
      const cappersOf = (direction: string): PositionCapper[] =>
        Array.from(sides[family].get(direction)?.entries() ?? [])
          .filter(([id]) => seen.get(id) === 1)
          .map(([, posts]) => toCapper(posts))
          .sort(byCapperScore);

      for (const direction of directions) {
        const supporters = cappersOf(direction);
        if (supporters.length < minSupporters) continue;
        const opposite = family === "TOTAL" ? (direction === "OVER" ? "UNDER" : "OVER") : null;
        const opposers = family === "TOTAL" ? cappersOf(opposite!) : directions.filter((d) => d !== direction).flatMap(cappersOf);

        const lines = supporters.map((s) => s.endorsedLine);
        // Easiest = the largest for a team side and an Under, the smallest for an Over.
        const easiestIsMin = family === "TOTAL" && direction === "OVER";
        const anchorLine = easiestIsMin ? Math.min(...lines) : Math.max(...lines);
        const hardestLine = easiestIsMin ? Math.max(...lines) : Math.min(...lines);
        const score = supporters.reduce((s, c) => s + c.score, 0) - opposers.reduce((s, c) => s + c.score, 0);
        const sample = game.picks[0];
        positions.push({
          key: game.gameId + "|" + family + "|" + direction,
          eventId: game.gameId,
          homeTeam: sample.homeTeam,
          awayTeam: sample.awayTeam,
          commenceTime: game.gameTime,
          sport: game.leagueName,
          family,
          direction,
          anchorLine,
          anchorIsMoneyline: family === "SIDE" && supporters.some((s) => s.endorsedLine === anchorLine && s.postedMarket === "MONEYLINE"),
          postedLines: { hardest: hardestLine, easiest: anchorLine },
          lineSpread: Math.abs(anchorLine - hardestLine),
          supporters,
          opposers,
          score,
        });
      }
    }
  }

  return positions.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.supporters.length !== a.supporters.length ? b.supporters.length - a.supporters.length : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
