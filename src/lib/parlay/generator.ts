// The Parlay Generator's one engine: your slip picks, plus the best legs from
// the games you targeted (or the full slate), as one parlay with its Hedge and
// Contrarian. Replaces Auto-Generate's Parlay A + alternates and the slip's
// "Build from slip"; nothing here reads the database.
//
// It runs over a SNAPSHOT - the pool of games and picks plus both record maps,
// loaded once by the server action. Generate, Regenerate, Hedge and Contrarian
// all run on the same snapshot: Regenerate is this function again with a new
// seed and history, never a new fetch (snapshotIsStale says when a refetch is
// due instead).
//
// Rules, in order:
//   1. Slip picks are always in the parlay, whatever the filters or the leg
//      count. Two slip picks that can't both be legs (opposing, or the same bet,
//      at any line - blocks(), build-my-picks.ts) compete: the better record
//      stays, then the better line. The other is listed in `dropped`. A slip
//      pick whose game has started is dropped too.
//   2. Targets: with any, generated legs come only from the targeted games
//      plus the games of your picks. Without, from every game in the snapshot.
//   3. A generated leg must clear the 55% gate on its capper's all-leagues
//      record in its market (qualifies, qualification-ranking.ts) - the same
//      gate Hedge and Contrarian use - and pass the Include Picks filter
//      (include-picks.ts: All Picks, or any of Moneyline / Spread / Totals /
//      Props - betCategory, period ignored). Slip picks are never gated or
//      filtered. No minimum sample: candidates are
//      ranked by Wilson lower bound (compareByWilson), which puts a small
//      sample below a large one at the same win %, and every leg carries its
//      record so the sample size shows.
//   4. One generated leg per game first, best games first. Only when games run
//      out are same-game legs added, up to "max legs per game" counted with any
//      slip picks on that game - across every category and every period (a
//      1H / F5 / quarter pick is on its game's board card, so it counts toward
//      that game). A generated leg never breaks a same-game rule
//      (same-game-rules.ts) against any leg on its game - not opposing, not a
//      duplicate at any line, not a second side or game total.
//   5. A Pick Mix (two or more categories selected) splits the whole parlay
//      between them by share, scaled to the leg count by largest remainder.
//      The slip's own legs count toward their category's share, the generated
//      legs fill what is left of each, then any shortfall from the other
//      selected categories by normal ranking - a mix never shortens a parlay
//      and never beats max legs per game or a same-game rule. A category that
//      came up short is said (mixNotes). An unclassified pick (All Picks only)
//      counts toward no share.
//
// Generate (no `variation`) is deterministic: the same snapshot and settings
// always give the same parlay. Regenerate (`variation`) gives another parlay of
// comparable strength: games are drawn from those whose best leg is close to
// the cut, each game's leg from the picks in a near-tie band of its best, all
// weighted toward the stronger, and legs used in the last few parlays weigh
// less. Nothing outside the gate is ever drawn. Slip picks and targets are the
// same in every build.
import type { CapperLeagueRecords } from "@/server/data/picks";
import { categoryRecordKey } from "@/lib/record-keys";
import type { CategoryBreakdownItem } from "@/server/data/stats";
import type { GeneratorGame, GeneratorPick, SwapMode } from "@/lib/parlay/auto-generate";
import { bestAvailableRecord, rankPoolPicks, type RankRecordSource } from "@/lib/parlay/pick-record";
import {
  compareByWilson,
  contrarianHeadcountPasses,
  qualifies,
  rankCandidatesBy,
  toParlayCandidate,
  toParlayLeg,
  wilsonLowerBound,
} from "@/lib/parlay/qualification-core";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { selectConflictFreeLegs } from "@/lib/parlay/build-my-picks";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import { betCategory, type BetCategoryResult } from "@/lib/parlay/bet-category";
import {
  keepsPick,
  mixCounts,
  mixShortNote,
  selectedCategories,
  toIncludeSelection,
  toPickMix,
  type IncludeSelection,
  type PickMix,
} from "@/lib/parlay/include-picks";
import { MAX_LEGS_PER_GAME, MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { legSetKey } from "@/lib/parlay/parlay-set";
import type { Rule } from "@/lib/parlay/relationship-classifier";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
export type FillFrom = "BEST_AVAILABLE" | "YOUR_PICKS_ONLY";

export type GeneratorSnapshot = {
  // When the pool was read, for snapshotIsStale.
  builtAt: string;
  // Every game generated legs may come from: the in-scope leagues' unstarted
  // games, the targeted games, and the games of the slip's picks. Pending
  // picks only.
  games: GeneratorGame[];
  // The slip's picks, read server-side.
  slipPicks: GeneratorPick[];
  // Targeted game ids. A target missing from `games` (started, or off the
  // board) is reported in `unavailableTargets`.
  targets: string[];
  // Slip picks' records (bestAvailableRecord - what their cards show).
  leagueRecords: CapperLeagueRecords;
  // Every candidate's all-leagues market record (the gate and the ranking).
  categoryRecords: Record<string, CategoryBreakdownItem | null>;
};

export type GeneratorSettings = {
  legCount: number;
  maxLegsPerGame: number;
  include: IncludeSelection;
  // A Pick Mix's share per selected category, or null. Read only with two or
  // more categories selected.
  mix: PickMix | null;
  fillFrom: FillFrom;
};

// A Regenerate: the seed to draw with, and the generated legs (pick ids) of
// the parlays already shown, newest first.
export type Variation = { seed: number; history: string[][] };

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
export type LegRecord = { wins: number; losses: number; n: number; winPct: number };

export type EngineLeg = {
  pick: GeneratorPick;
  gameId: string;
  gameLabel: string;
  gameTime: string;
  source: "SLIP" | "GENERATED";
  // A slip pick: the record its card shows (bestAvailableRecord, `basis` says
  // which). A generated leg: the market record it was gated and ranked on.
  record: LegRecord | null;
  basis: RankRecordSource | "MARKET" | null;
  // Generated legs only.
  wilsonLowerBound: number | null;
  // True when its game has another leg in this parlay (an SGP).
  sameGame: boolean;
};

export type DroppedSlipPick = {
  pickId: string;
  label: string;
  reason: "duplicate" | "opposes" | "started";
  // The slip pick that stayed (duplicate / opposes).
  against: { pickId: string; label: string } | null;
  // "duplicates Capper — Over 53.5 — not used"
  note: string;
};

export type EngineSwapLeg = {
  original: EngineLeg;
  swap: {
    pick: GeneratorPick;
    rule: Rule;
    record: LegRecord;
    wilsonLowerBound: number;
  } | null;
  // A slip pick is never swapped.
  unchangedReason: "SLIP_PICK" | "NO_ALTERNATE" | "NOT_MAJORITY" | null;
};

export type EngineSwap = { mode: SwapMode; legs: EngineSwapLeg[]; swapCount: number };

export type GeneratedParlay = {
  // Grouped by game (earliest first), slip picks first within a game.
  legs: EngineLeg[];
  // The leg count asked for - or the slip's size, when the slip alone is more.
  requested: number;
  fromSlip: number;
  generated: number;
  gamesUsed: number;
  // Games with two or more legs.
  sameGameGames: number;
  // The most legs this snapshot can supply with these settings (an upper
  // bound: same-game rules can still leave it short), and why.
  capacity: number;
  capacityText: string;
  // Why the parlay is short of `requested` - empty when it isn't - and, with
  // targets, every targeted game that had nothing to give.
  shortfall: string[];
  // Each Pick Mix category that couldn't fill its share (the other selected
  // categories made up the rest).
  mixNotes: string[];
  // Targeted game ids that are not in the snapshot (started or off the board).
  unavailableTargets: string[];
  dropped: DroppedSlipPick[];
  hedge: EngineSwap;
  contrarian: EngineSwap;
  // BEST: Generate's parlay. VARIED: a Regenerate that differs from the parlays
  // in its history. NO_ALTERNATIVE: a Regenerate that found nothing else of
  // comparable strength (its legs are Generate's; the UI keeps what it shows
  // and says so).
  variety: "BEST" | "VARIED" | "NO_ALTERNATIVE";
  // legSetKey of the generated legs - what the client adds to its history.
  generatedKey: string;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
// Picks within this many Wilson points of their game's best are interchangeable.
export const PICK_TIE_BAND = 0.03;
// Games whose best leg is within this of the last game that makes the cut can rotate in.
export const GAME_BAND = 0.05;
// How many recent parlays' legs weigh less, and by how much.
export const RECENT_PARLAYS = 3;
export const RECENT_WEIGHT = 0.35;
// Draws a Regenerate tries before settling for one that only differs from the last parlay.
const VARIATION_TRIES = 12;
// A snapshot older than this is reloaded before the next build.
export const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 1000;

// Reload when the pool is old, or a game in it has started.
export function snapshotIsStale(snapshot: Pick<GeneratorSnapshot, "builtAt" | "games" | "slipPicks">, now: Date): boolean {
  const t = now.getTime();
  if (t - new Date(snapshot.builtAt).getTime() > SNAPSHOT_MAX_AGE_MS) return true;
  return snapshot.games.some((g) => new Date(g.gameTime).getTime() <= t) || snapshot.slipPicks.some((p) => new Date(p.gameTime).getTime() <= t);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
type Rng = () => number;

// mulberry32: small, seedable, good enough to shuffle a slate.
function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Weighted order without replacement (Efraimidis-Spirakis keys).
function weightedOrder<T>(items: T[], weight: (t: T) => number, rng: Rng): T[] {
  return items
    .map((item) => ({ item, key: Math.pow(Math.max(rng(), 1e-12), 1 / Math.max(weight(item), 1e-6)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

type Candidate = {
  pick: GeneratorPick;
  game: GeneratorGame;
  record: LegRecord;
  wilsonLowerBound: number;
  category: BetCategoryResult;
};

const byWilson = (a: Candidate, b: Candidate) =>
  compareByWilson({ pickId: a.pick.pickId, wilsonLowerBound: a.wilsonLowerBound, record: a.record }, { pickId: b.pick.pickId, wilsonLowerBound: b.wilsonLowerBound, record: b.record });

const asCandidate = (p: GeneratorPick) => toParlayCandidate(toParlayLeg(p));
const pickLabel = (p: GeneratorPick) => `${p.capperName} — ${p.betDetail}`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// A doubleheader's board can't tell which game a pick with no game number is
// on, so two legs are only paired on such a game when both say (sureOfGame in
// auto-generate.ts).
const sureOfGame = (game: GeneratorGame | undefined, pick: GeneratorPick) => !game?.doubleheader || pick.gameNumber != null;

function marketRecord(pick: GeneratorPick, records: Record<string, CategoryBreakdownItem | null>): CategoryBreakdownItem | null {
  return pick.category ? (records[categoryRecordKey(pick.capperId, pick.category)] ?? null) : null;
}

const toLegRecord = (r: { wins: number; losses: number; winPct: number }): LegRecord => ({ wins: r.wins, losses: r.losses, n: r.wins + r.losses, winPct: r.winPct });

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------
export function buildGeneratedParlay(snapshot: GeneratorSnapshot, settings: GeneratorSettings, variation: Variation | null, now: Date): GeneratedParlay {
  const nowMs = now.getTime();
  const started = (iso: string) => new Date(iso).getTime() <= nowMs;
  const include = toIncludeSelection(settings.include);
  const categories = selectedCategories(include);
  const mix = toPickMix(settings.mix, categories);
  const maxPerGame = Math.min(MAX_LEGS_PER_GAME, Math.max(1, Math.floor(settings.maxLegsPerGame) || 1));
  const legCount = Math.min(MAX_PARLAY_LEGS, Math.max(1, Math.floor(settings.legCount) || 1));

  // ---- 1. Slip picks ------------------------------------------------------
  const dropped: DroppedSlipPick[] = [];
  const liveSlip: GeneratorPick[] = [];
  for (const p of snapshot.slipPicks) {
    if (started(p.gameTime)) dropped.push({ pickId: p.pickId, label: pickLabel(p), reason: "started", against: null, note: "game started — not used" });
    else liveSlip.push(p);
  }
  const slipById = new Map(liveSlip.map((p) => [p.pickId, p]));
  const settled = selectConflictFreeLegs(
    rankPoolPicks(liveSlip, snapshot.leagueRecords).map((p) => toBuildCandidate(p, snapshot.leagueRecords)),
    Number.POSITIVE_INFINITY
  );
  for (const s of settled.skipped) {
    const reason = s.reason === "duplicate" ? "duplicate" : "opposes";
    dropped.push({
      pickId: s.pickId,
      label: s.label,
      reason,
      against: s.conflictsWith,
      note: `${reason === "duplicate" ? "duplicates" : "opposes"} ${s.conflictsWith.label} — not used`,
    });
  }
  const slipLegs: GeneratorPick[] = settled.legs.map((c) => slipById.get(c.pickId)!);
  const target = Math.max(legCount, slipLegs.length);
  const fillFrom: FillFrom = slipLegs.length === 0 ? "BEST_AVAILABLE" : settings.fillFrom;

  // ---- 2. Games -----------------------------------------------------------
  const allSlipIds = new Set(snapshot.slipPicks.map((p) => p.pickId));
  const gameById = new Map(snapshot.games.filter((g) => !started(g.gameTime)).map((g) => [g.gameId, g]));
  const slipGameIds = new Set(slipLegs.map((p) => p.gameId));
  const targeted = snapshot.targets.length > 0;
  const unavailableTargets = targeted ? snapshot.targets.filter((id) => !gameById.has(id)) : [];
  const eligible: GeneratorGame[] = targeted
    ? Array.from(new Set([...snapshot.targets, ...slipGameIds]))
        .map((id) => gameById.get(id))
        .filter((g): g is GeneratorGame => g !== undefined)
    : Array.from(gameById.values());

  // ---- 3. Candidates: gated, filtered, ranked by Wilson ---------------------
  const slipOnGame = new Map<string, GeneratorPick[]>();
  for (const p of slipLegs) slipOnGame.set(p.gameId, [...(slipOnGame.get(p.gameId) ?? []), p]);
  const candidatesOf = new Map<string, Candidate[]>();
  for (const game of eligible) {
    const onGame = slipOnGame.get(game.gameId) ?? [];
    const list: Candidate[] = [];
    for (const pick of game.picks) {
      if (allSlipIds.has(pick.pickId) || !keepsPick(include, pick)) continue;
      const record = marketRecord(pick, snapshot.categoryRecords);
      if (!record || !qualifies(record)) continue;
      // Never against a slip pick on its game.
      if (onGame.some((s) => !(sureOfGame(game, s) && sureOfGame(game, pick)) || sameGameConflict(asCandidate(pick), asCandidate(s)) !== null)) continue;
      list.push({ pick, game, record: toLegRecord(record), wilsonLowerBound: wilsonLowerBound(record.wins, record.losses), category: betCategory(pick) });
    }
    list.sort(byWilson);
    candidatesOf.set(game.gameId, list);
  }

  // ---- 4. Capacity ----------------------------------------------------------
  const roomOn = (gameId: string) => Math.max(0, maxPerGame - (slipOnGame.get(gameId)?.length ?? 0));
  const gamesWithCandidates = eligible.filter((g) => (candidatesOf.get(g.gameId)?.length ?? 0) > 0);
  const generatable = fillFrom === "YOUR_PICKS_ONLY" ? 0 : eligible.reduce((s, g) => s + Math.min(roomOn(g.gameId), candidatesOf.get(g.gameId)!.length), 0);
  const capacity = Math.max(slipLegs.length, Math.min(MAX_PARLAY_LEGS, slipLegs.length + generatable));
  const capacityText =
    fillFrom === "YOUR_PICKS_ONLY"
      ? `${capacity} max from your picks only`
      : targeted
        ? `${capacity} max with ${plural(snapshot.targets.length, "game")} targeted`
        : `${capacity} max from ${plural(gamesWithCandidates.length, "game")} with qualified picks`;

  // ---- 5. Selection -----------------------------------------------------------
  const need = fillFrom === "YOUR_PICKS_ONLY" ? 0 : target - slipLegs.length;
  const slipCounts = new Map<BetCategoryResult, number>();
  for (const p of slipLegs) slipCounts.set(betCategory(p), (slipCounts.get(betCategory(p)) ?? 0) + 1);
  const mixTarget = mix && mixCounts(target, mix, categories);
  const quota: Partial<Record<BetCategoryResult, number>> | null = mixTarget
    ? Object.fromEntries(categories.map((c) => [c, Math.max(0, mixTarget[c] - (slipCounts.get(c) ?? 0))]))
    : null;

  const select = (rng: Rng | null, recent: ReadonlySet<string>): Candidate[] => {
    const chosen: Candidate[] = [];
    if (need <= 0) return chosen;
    const onGame = new Map<string, GeneratorPick[]>(Array.from(slipOnGame.entries()).map(([k, v]) => [k, [...v]]));
    const left = quota ? { ...quota } : null;
    const penalty = (c: Candidate) => (recent.has(c.pick.pickId) ? RECENT_WEIGHT : 1);
    const fits = (c: Candidate) => {
      const legs = onGame.get(c.game.gameId) ?? [];
      if (legs.length >= maxPerGame) return false;
      return legs.every((l) => sureOfGame(c.game, l) && sureOfGame(c.game, c.pick) && sameGameConflict(asCandidate(c.pick), asCandidate(l)) === null);
    };
    const take = (c: Candidate) => {
      chosen.push(c);
      onGame.set(c.game.gameId, [...(onGame.get(c.game.gameId) ?? []), c.pick]);
      if (left && left[c.category] !== undefined) left[c.category]!--;
    };
    const passes: boolean[] = left ? [true, false] : [false];
    // A strict pass takes only what a share still wants. An unclassified pick
    // has no share, so it waits for the open pass.
    const allows = (c: Candidate, strict: boolean) => !strict || (left![c.category] ?? 0) > 0;

    // Pass 1: one leg per game that has none yet, best games first.
    const open = eligible
      .filter((g) => !onGame.has(g.gameId) && (candidatesOf.get(g.gameId)?.length ?? 0) > 0)
      .map((g) => ({ game: g, top: candidatesOf.get(g.gameId)![0] }))
      .sort((a, b) => byWilson(a.top, b.top));
    let order = open;
    if (rng && open.length > need) {
      // Games close to the cut rotate; the rest stay in rank order behind them.
      const cut = open[Math.min(need, open.length) - 1].top.wilsonLowerBound - GAME_BAND;
      const rotating = open.filter((o) => o.top.wilsonLowerBound >= cut);
      const behind = open.filter((o) => o.top.wilsonLowerBound < cut);
      const gamePenalty = (o: (typeof open)[number]) => (candidatesOf.get(o.game.gameId)!.some((c) => recent.has(c.pick.pickId)) ? RECENT_WEIGHT : 1);
      order = [...weightedOrder(rotating, (o) => o.top.wilsonLowerBound * gamePenalty(o), rng), ...behind];
    }
    for (const strict of passes) {
      for (const { game } of order) {
        if (chosen.length >= need) break;
        if (onGame.has(game.gameId)) continue;
        const options = candidatesOf.get(game.gameId)!.filter((c) => allows(c, strict) && fits(c));
        if (options.length === 0) continue;
        if (!rng) take(options[0]);
        else {
          const band = options.filter((c) => c.wilsonLowerBound >= options[0].wilsonLowerBound - PICK_TIE_BAND);
          take(weightedOrder(band, (c) => c.wilsonLowerBound * penalty(c), rng)[0]);
        }
      }
    }

    // Pass 2: same-game legs, only when games ran out.
    if (chosen.length < need && maxPerGame > 1) {
      const taken = new Set(chosen.map((c) => c.pick.pickId));
      let rest = eligible.flatMap((g) => candidatesOf.get(g.gameId)!).filter((c) => !taken.has(c.pick.pickId)).sort(byWilson);
      if (rng && rest.length > 0) {
        const band = rest.filter((c) => c.wilsonLowerBound >= rest[0].wilsonLowerBound - PICK_TIE_BAND);
        const outside = rest.filter((c) => c.wilsonLowerBound < rest[0].wilsonLowerBound - PICK_TIE_BAND);
        rest = [...weightedOrder(band, (c) => c.wilsonLowerBound * penalty(c), rng), ...outside];
      }
      for (const strict of passes) {
        for (const c of rest) {
          if (chosen.length >= need) break;
          if (chosen.includes(c) || !allows(c, strict) || !fits(c)) continue;
          take(c);
        }
      }
    }
    return chosen;
  };

  const keyOf = (cs: Candidate[]) => legSetKey(cs.map((c) => c.pick.pickId));
  let chosen: Candidate[];
  let variety: GeneratedParlay["variety"] = "BEST";
  if (!variation) {
    chosen = select(null, new Set());
  } else {
    const shown = variation.history.map((ids) => legSetKey(ids));
    const recent = new Set(variation.history.slice(0, RECENT_PARLAYS).flat());
    let fallback: Candidate[] | null = null;
    let found: Candidate[] | null = null;
    for (let i = 0; i < VARIATION_TRIES && !found; i++) {
      const draw = select(seededRng(variation.seed + i * 7919), recent);
      const key = keyOf(draw);
      if (!shown.includes(key)) found = draw;
      else if (!fallback && key !== shown[0]) fallback = draw;
    }
    chosen = found ?? fallback ?? select(null, new Set());
    variety = found || fallback ? "VARIED" : "NO_ALTERNATIVE";
  }

  // ---- 6. Assemble ------------------------------------------------------------
  const legs: EngineLeg[] = [
    ...slipLegs.map((p): EngineLeg => {
      const r = bestAvailableRecord(p, snapshot.leagueRecords);
      return {
        pick: p,
        gameId: p.gameId,
        gameLabel: p.gameLabel,
        gameTime: p.gameTime,
        source: "SLIP",
        record: r ? { wins: r.wins, losses: r.losses, n: r.n, winPct: r.winPct } : null,
        basis: r?.source ?? null,
        wilsonLowerBound: null,
        sameGame: false,
      };
    }),
    ...chosen.map(
      (c): EngineLeg => ({
        pick: c.pick,
        gameId: c.game.gameId,
        gameLabel: c.game.gameLabel,
        gameTime: c.game.gameTime,
        source: "GENERATED",
        record: c.record,
        basis: "MARKET",
        wilsonLowerBound: c.wilsonLowerBound,
        sameGame: false,
      })
    ),
  ];
  const perGame = new Map<string, number>();
  for (const l of legs) perGame.set(l.gameId, (perGame.get(l.gameId) ?? 0) + 1);
  for (const l of legs) l.sameGame = (perGame.get(l.gameId) ?? 0) > 1;
  const firstStart = new Map<string, number>();
  for (const l of legs) firstStart.set(l.gameId, Math.min(firstStart.get(l.gameId) ?? Infinity, new Date(l.gameTime).getTime()));
  legs.sort(
    (a, b) =>
      firstStart.get(a.gameId)! - firstStart.get(b.gameId)! ||
      (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0) ||
      (a.source === b.source ? 0 : a.source === "SLIP" ? -1 : 1) ||
      (b.wilsonLowerBound ?? 0) - (a.wilsonLowerBound ?? 0)
  );

  // ---- 7. What it couldn't do -------------------------------------------------
  const shortfall: string[] = [];
  const gamesUsed = perGame.size;
  if (legs.length < target) {
    if (fillFrom === "YOUR_PICKS_ONLY") {
      shortfall.push(`Your picks only: ${plural(slipLegs.length, "pick")} in your slip. Switch Fill from to Best available to add legs.`);
    } else if (targeted) {
      shortfall.push(`${legs.length} of ${target} legs: the targeted games have no more picks that clear 55% and fit.`);
    } else {
      shortfall.push(
        `${legs.length} of ${target} legs: only ${plural(gamesWithCandidates.length, "game")} ${gamesWithCandidates.length === 1 ? "has" : "have"} picks that clear 55%` +
          (maxPerGame === 1 && gamesWithCandidates.length < need ? ". Raise Max legs per game to add same-game legs." : ".")
      );
    }
  }
  const mixNotes: string[] = [];
  if (mixTarget && fillFrom === "BEST_AVAILABLE") {
    for (const c of categories) {
      const got = legs.filter((l) => betCategory(l.pick) === c).length;
      if (got < mixTarget[c]) mixNotes.push(mixShortNote(c, got, mixTarget[c]));
    }
  }
  if (targeted && fillFrom === "BEST_AVAILABLE") {
    for (const id of snapshot.targets) {
      const game = gameById.get(id);
      if (!game || (candidatesOf.get(id)?.length ?? 0) > 0 || slipOnGame.has(id)) continue;
      shortfall.push(`${game.gameLabel}: no qualified picks — ${gamesUsed} of ${eligible.length} games used`);
    }
  }

  return {
    legs,
    requested: target,
    fromSlip: slipLegs.length,
    generated: chosen.length,
    gamesUsed,
    sameGameGames: Array.from(perGame.values()).filter((n) => n > 1).length,
    capacity,
    capacityText,
    shortfall,
    mixNotes,
    unavailableTargets,
    dropped,
    hedge: buildSwap(legs, gameById, include, snapshot, "AUTO_HEDGE"),
    contrarian: buildSwap(legs, gameById, include, snapshot, "CONTRARIAN"),
    variety,
    generatedKey: keyOf(chosen),
  };
}

// ---------------------------------------------------------------------------
// Hedge / Contrarian: each generated leg searched for an alternate on its own
// game with rankCandidates (qualification-ranking.ts - classifier, 55% gate,
// Contrarian headcount, Wilson order), exactly as before. Slip picks are never
// swapped. An alternate is never one of the parlay's own picks or a slip pick,
// and never breaks a same-game rule against the other legs on its game (as
// they stand after any swap already made there).
// ---------------------------------------------------------------------------
function buildSwap(
  legs: EngineLeg[],
  gameById: Map<string, GeneratorGame>,
  include: IncludeSelection,
  snapshot: GeneratorSnapshot,
  mode: SwapMode
): EngineSwap {
  const inParlay = new Set([...legs.map((l) => l.pick.pickId), ...snapshot.slipPicks.map((p) => p.pickId)]);
  const current = new Map<string, GeneratorPick>(legs.map((l) => [l.pick.pickId, l.pick]));
  const out: EngineSwapLeg[] = legs.map((leg) => {
    if (leg.source === "SLIP") return { original: leg, swap: null, unchangedReason: "SLIP_PICK" };
    const gamePicks = (gameById.get(leg.gameId)?.picks ?? []).filter((p) => keepsPick(include, p));
    const siblings = legs.filter((l) => l !== leg && l.gameId === leg.gameId).map((l) => current.get(l.pick.pickId)!);
    const others = gamePicks.filter((p) => !inParlay.has(p.pickId) && siblings.every((s) => sameGameConflict(asCandidate(p), asCandidate(s)) === null));
    const primary = toParlayLeg(leg.pick);
    const categoryOf = new Map(gamePicks.map((p) => [p.pickId, p.category]));
    const ranked = rankCandidatesBy(primary, others.map(toParlayLeg), mode, snapshot.categoryRecords, (l) => categoryOf.get(l.pickId) ?? null, gamePicks.map(toParlayLeg));
    const best = ranked[0];
    const bestPick = best ? others.find((p) => p.pickId === best.leg.pickId) : undefined;
    if (!best || !bestPick) {
      const notMajority = mode === "CONTRARIAN" && !contrarianHeadcountPasses(primary, gamePicks.map(toParlayLeg));
      return { original: leg, swap: null, unchangedReason: notMajority ? "NOT_MAJORITY" : "NO_ALTERNATE" };
    }
    inParlay.add(bestPick.pickId);
    current.set(leg.pick.pickId, bestPick);
    return { original: leg, swap: { pick: bestPick, rule: best.rule, record: best.record, wilsonLowerBound: best.wilsonLowerBound }, unchangedReason: null };
  });
  return { mode, legs: out, swapCount: out.filter((l) => l.swap !== null).length };
}
