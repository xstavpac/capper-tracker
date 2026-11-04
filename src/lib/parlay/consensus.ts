// Consensus Hybrid's position builder: which side of each game, and which
// direction of its total, the strongest capper backs. One strong capper is enough
// for a leg (the side and the total may come from different cappers); the later
// stages move each leg to a forgiving FanDuel alternate line and place the edges. This file only answers "what do the cappers back" - it reads the
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
// Supporters are DISTINCT cappers. Two scorers, picked by `scorer` (HYBRID_SCORER):
//
//   SCORING (the default): scoring.ts's best of two (scorePickBestOfTwo). The GATE is the
//   capper's actual record: the post counts when the raw win % of EITHER record - this
//   league alone, or every league - reaches the win-% lever (so an 8-0 in-league capper
//   with a bad overall record counts, and so does 30-20 overall with 2-8 in-league). No
//   shrinkage, no price and no long-shot rule: a 0-for-N capper fails at every lever
//   above 0, and lowering the lever never removes anyone. The SCORE only orders: the
//   better rankScore (an edge at the capper's OWN posted price, which can be negative; a
//   FanDuel ladder rung never reaches this file) among only the records that cleared the
//   gate. Ties: the larger decided sample, then id.
//   WILSON (rollback, deleted in PR 9): pick-record.ts recordForGate - the league and the
//   all-time category record, each by its Wilson lower bound at z, the higher kept, a tie
//   to the league one; the raw win-% gate on that record only; the score is that Wilson
//   lower bound at GENERATOR_Z (#324). Ties: the record's n, then id.
//
// Either way the record shown (PositionCapper.record) is recordForGate's. Only gated
// posts count at all: an ungated post is neither a supporter nor an opposer, and never
// moves the anchor.
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
// One position per family per game: the direction whose single strongest
// gated capper is strongest (byCapperScore: their score, then the larger sample,
// then capper id). The other direction - the other
// team's ML or spread, the other side of the total - yields no position; its
// gated cappers are kept as opposers, for display only. A capper who posted BOTH
// sides of a family on one game has hedged, not endorsed: they are on neither
// side.
//
// Score = the strongest supporter's score. Other cappers agreeing with them never
// qualify a position and never decide the direction; they only break ties when
// positions are ranked (more supporters first). A position qualifies with at
// least HYBRID_MIN_SUPPORTERS (1) supporter; positions come back best score first.
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { GENERATOR_Z, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { GATE_DEFAULT, normalizeMinWinPct } from "@/lib/parlay/gate";
import { hasKickedOff, isGameOver, OFF_BOARD_GAME_PREFIX } from "@/lib/parlay/game-over";
import { recordForGate } from "@/lib/parlay/pick-record";
import { qualifies, wilsonLowerBound } from "@/lib/parlay/qualification-core";
import { describePick } from "@/lib/parlay/relationship-classifier";
import { EMPTY_PLATFORM_RATES, scorePickBestOfTwo, type BestOfTwoScore, type ScoreModel, type ScoringContext } from "@/lib/parlay/scoring";

// Supporters a position needs: one strong capper is enough.
export const HYBRID_MIN_SUPPORTERS = 1;

// Which scorer gates and ranks posts (see the header). WILSON is the rollback: flipping
// this back restores the output and the run-log version from before scoring.ts.
export type HybridScorer = "SCORING" | "WILSON";
export const HYBRID_SCORER: HybridScorer = "SCORING";

export type HybridMarket = "SPREAD" | "MONEYLINE" | "TOTAL";
export type HybridFamily = "SIDE" | "TOTAL";

export type HybridRecord = {
  wins: number;
  losses: number;
  n: number;
  winPct: number;
  // Which of the two records recordForGate kept: the league-specific category record or the all-time one.
  source: "LEAGUE" | "OVERALL";
};

export type PositionCapper = {
  capperId: string;
  capperName: string;
  record: HybridRecord;
  // The market of the post whose record this is (the capper's best-scoring post on the position).
  recordMarket: HybridMarket;
  // SCORING: the post's best-of-two rankScore (an edge at the capper's posted price).
  // WILSON: the Wilson lower bound of `record` at the generator's z.
  score: number;
  // SCORING only: what scored the post - decided picks behind the score (the tie-break),
  // which record won the best of two, and the model.
  scoring?: { decided: number; from: NonNullable<BestOfTwoScore["chosenFrom"]>; model: ScoreModel };
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
  // The strongest supporter's score. Null only on a 3-leg box's third leg (hybrid.ts
  // oppositeTotal), which has no consensus: it is skipped in every sum, never read as 0.
  score: number | null;
};

export type ConsensusOptions = {
  now: Date;
  // The win-% gate (gate.ts); absent or invalid is 55.
  minWinPct?: number;
  minSupporters?: number;
  z?: number;
  // Absent: HYBRID_SCORER.
  scorer?: HybridScorer;
};

// What consensus reads from the snapshot. platformRates: SCORING's fallback rates (absent: the defaults).
export type ConsensusRecords = Pick<GeneratorSnapshot, "leagueRecords" | "categoryRecords" | "propMarketRecords" | "platformRates">;

type Post = {
  pick: GeneratorPick;
  family: HybridFamily;
  direction: string;
  market: HybridMarket;
  postedLine: number | null;
  endorsedLine: number;
  record: HybridRecord;
  score: number;
  // SCORING only.
  scored?: BestOfTwoScore;
};

// How a build scores: the scorer, the gate, the z, and SCORING's context.
type Scoring = { scorer: HybridScorer; gate: number; z: number; ctx: ScoringContext };

function scoringOf(snapshot: ConsensusRecords, opts: Pick<ConsensusOptions, "minWinPct" | "z" | "scorer">): Scoring {
  const gate = normalizeMinWinPct(opts.minWinPct ?? GATE_DEFAULT);
  return {
    scorer: opts.scorer ?? HYBRID_SCORER,
    gate,
    z: opts.z ?? GENERATOR_Z,
    ctx: { leagueRecords: snapshot.leagueRecords, categoryRecords: snapshot.categoryRecords, propMarketRecords: snapshot.propMarketRecords, platformRates: snapshot.platformRates ?? EMPTY_PLATFORM_RATES, minWinPct: gate },
  };
}

// The post's gate verdict under its build's scorer.
function postPasses(read: ReadPost, s: Scoring): boolean {
  if (!read.record) return false;
  if (s.scorer === "WILSON") return qualifies(read.record, s.gate);
  return !!read.scored && read.scored.passes;
}

// The tie-break sample: SCORING's decided picks, WILSON's record n.
const sampleOf = (decided: number | undefined, record: HybridRecord) => decided ?? record.n;
const decidedOf = (p: { scored?: BestOfTwoScore }) => (p.scored?.chosen?.status === "SCORED" ? p.scored.chosen.decided : undefined);

const MARKET_BY_BET_TYPE: Record<string, HybridMarket> = { SPREAD: "SPREAD", MONEYLINE: "MONEYLINE", TOTAL: "TOTAL" };

// A full-game spread / moneyline / game-total pick read as a post, with its
// record (null when the capper has none) - before the win-% gate. Null when it is
// not one a hybrid position can use: not one of those markets, or the side or
// line cannot be read.
type ReadPost = Omit<Post, "record" | "score"> & { record: HybridRecord | null; score: number };

function readPost(pick: GeneratorPick, game: GeneratorGame, snapshot: ConsensusRecords, s: Scoring): ReadPost | null {
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

  // The record shown: chosen at the same z WILSON's score uses.
  const record = recordForGate(pick, snapshot.leagueRecords, snapshot.categoryRecords, s.z, snapshot.propMarketRecords);
  const base = {
    pick,
    family,
    direction: desc.direction,
    market,
    postedLine,
    endorsedLine,
    record: record && { wins: record.wins, losses: record.losses, n: record.n, winPct: record.winPct, source: record.source },
  };
  if (s.scorer === "WILSON") return { ...base, score: record ? wilsonLowerBound(record.wins, record.losses, s.z) : 0 };
  // At the capper's posted price: the pick as posted is all scoring.ts is handed.
  const scored = scorePickBestOfTwo(pick, s.ctx);
  // A post that cleared neither record has no chosen score; it never passes the gate, so this number is never ranked.
  return { ...base, score: scored.chosen?.status === "SCORED" ? scored.chosen.rankScore : Number.NEGATIVE_INFINITY, scored };
}

// The pick as a Post, or null when it is not one a hybrid position can use (readPost)
// or it does not clear the gate.
function toPost(pick: GeneratorPick, game: GeneratorGame, snapshot: ConsensusRecords, s: Scoring): Post | null {
  const read = readPost(pick, game, snapshot, s);
  if (!read || !postPasses(read, s)) return null;
  return read as Post;
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
  const an = sampleOf(decidedOf(a), a.record);
  const bn = sampleOf(decidedOf(b), b.record);
  if (an !== bn) return an > bn;
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
    ...(best.scored?.chosen?.status === "SCORED" && best.scored.chosenFrom ? { scoring: { decided: best.scored.chosen.decided, from: best.scored.chosenFrom, model: best.scored.chosen.model } } : {}),
    postedMarket: hardest.market,
    postedLine: hardest.postedLine,
    endorsedLine: hardest.endorsedLine,
    posts: posts.length,
  };
}

const byCapperScore = (a: PositionCapper, b: PositionCapper) => {
  if (b.score !== a.score) return b.score - a.score;
  const an = sampleOf(a.scoring?.decided, a.record);
  const bn = sampleOf(b.scoring?.decided, b.record);
  if (bn !== an) return bn - an;
  return a.capperId < b.capperId ? -1 : a.capperId > b.capperId ? 1 : 0;
};

export function buildConsensusPositions(snapshot: Pick<GeneratorSnapshot, "games"> & ConsensusRecords, opts: ConsensusOptions): ConsensusPosition[] {
  const scoring = scoringOf(snapshot, opts);
  const minSupporters = opts.minSupporters ?? HYBRID_MIN_SUPPORTERS;
  const positions: ConsensusPosition[] = [];

  for (const game of snapshot.games) {
    // Unstarted games only; a slip pick's off-board game has no kickoff.
    if (game.gameId.startsWith(OFF_BOARD_GAME_PREFIX) || hasKickedOff(game.gameTime, opts.now) || isGameOver(game, opts.now)) continue;

    // direction -> capperId -> gated posts, per family.
    const sides: Record<HybridFamily, Map<string, Map<string, Post[]>>> = { SIDE: new Map(), TOTAL: new Map() };
    for (const pick of game.picks) {
      const post = toPost(pick, game, snapshot, scoring);
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

      // The direction whose strongest capper is strongest; the other one yields no position.
      const contenders = directions.map((d) => ({ direction: d, supporters: cappersOf(d) })).filter((c) => c.supporters.length >= minSupporters);
      contenders.sort((a, b) => byCapperScore(a.supporters[0], b.supporters[0]));
      for (const { direction, supporters } of contenders.slice(0, 1)) {
        const opposers = directions.filter((d) => d !== direction).flatMap(cappersOf).sort(byCapperScore);

        const lines = supporters.map((s) => s.endorsedLine);
        // Easiest = the largest for a team side and an Under, the smallest for an Over.
        const easiestIsMin = family === "TOTAL" && direction === "OVER";
        const anchorLine = easiestIsMin ? Math.min(...lines) : Math.max(...lines);
        const hardestLine = easiestIsMin ? Math.max(...lines) : Math.min(...lines);
        const score = supporters[0].score;
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

  // Every position built here has a supporter, so a score.
  return positions.sort((a, b) => (b.score !== a.score ? b.score! - a.score! :b.supporters.length !== a.supporters.length ? b.supporters.length - a.supporters.length : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---- Why a game has no position (the "Why only N games?" diagnostic) ----
//
// What buildConsensusPositions saw on one game, per family, before and after the
// gate - read with the same readPost / gate / hedge rules, so it can say which of
// them stopped the game. Never used to build a position.

export type FamilyDiagnosis = {
  // Full-game posts of the family that could be read, gated or not.
  posts: number;
  // The highest win % among those posts' records (then the larger sample); null when none had a record.
  best: { direction: string; winPct: number; wins: number; losses: number } | null;
  // Distinct cappers clearing the gate on each direction, hedged cappers set aside.
  gatedByDirection: Record<string, number>;
  // Cappers who cleared the gate on both directions of the family (hedged), set aside.
  hedged: number;
};

export type GameDiagnosis = { gameId: string; side: FamilyDiagnosis; total: FamilyDiagnosis; otherPicks: number };

export function diagnoseConsensusGame(game: GeneratorGame, snapshot: ConsensusRecords, opts: Pick<ConsensusOptions, "minWinPct" | "z" | "scorer"> = {}): GameDiagnosis {
  const scoring = scoringOf(snapshot, opts);
  const read: ReadPost[] = [];
  let otherPicks = 0;
  for (const pick of game.picks) {
    const post = readPost(pick, game, snapshot, scoring);
    if (post) read.push(post);
    else otherPicks++;
  }
  const family = (f: HybridFamily): FamilyDiagnosis => {
    const posts = read.filter((p) => p.family === f);
    let best: FamilyDiagnosis["best"] = null;
    for (const p of posts) {
      if (!p.record) continue;
      if (!best || p.record.winPct > best.winPct || (p.record.winPct === best.winPct && p.record.wins + p.record.losses > best.wins + best.losses)) {
        best = { direction: p.direction, winPct: p.record.winPct, wins: p.record.wins, losses: p.record.losses };
      }
    }
    // The same verdict toPost reads, so the diagnostic matches selection.
    const gated = posts.filter((p) => postPasses(p, scoring));
    const directionsOf = new Map<string, Set<string>>();
    for (const p of gated) directionsOf.set(p.pick.capperId, (directionsOf.get(p.pick.capperId) ?? new Set<string>()).add(p.direction));
    const gatedByDirection: Record<string, number> = {};
    for (const dirs of directionsOf.values()) {
      if (dirs.size !== 1) continue;
      const d = Array.from(dirs)[0];
      gatedByDirection[d] = (gatedByDirection[d] ?? 0) + 1;
    }
    const hedged = Array.from(directionsOf.values()).filter((d) => d.size > 1).length;
    return { posts: posts.length, best, gatedByDirection, hedged };
  };
  return { gameId: game.gameId, side: family("SIDE"), total: family("TOTAL"), otherPicks };
}
