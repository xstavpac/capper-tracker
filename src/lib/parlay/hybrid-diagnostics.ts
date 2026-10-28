// Consensus Hybrid's "Why only N games?": for every game with at least one pending
// pick that the parlay does not use, the FIRST gate it failed, in plain words with
// the numbers behind it. Pure and client-safe: it reads only what a generation
// already holds - the snapshot (and the games it skipped), the positions, the
// candidate events, the ladder notes and the optimizer's box report - so it adds
// no database read and no Odds API call. Never changes what is selected.
//
// Gates, in order (the first one a game fails is its reason):
//   a. started / outside the slate window          (generator-snapshot.ts)
//   b. no full-game side or total picks            (consensus.ts readPost)
//   c. no side picks / no total picks
//   d. the best capper on the side / total is below the win-rate gate
//   e. no capper left on one side only: every gated capper took both sides (hedged) -
//      or, with a minimum above HYBRID_MIN_SUPPORTERS (1), too few agree
//   f. past the per-generation pricing limit       (ladderGameCount, hybrid.ts)
//   g. FanDuel lines not available                 (the ladder notes)
//   h. no usable FanDuel line                      (-600 floor / per-leg range)
//   i. built but not used                          (the Total legs cap, or ranked lower)
import { diagnoseConsensusGame, HYBRID_MIN_SUPPORTERS, type ConsensusPosition, type FamilyDiagnosis } from "@/lib/parlay/consensus";
import type { GeneratorGame } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";
import type { HybridBoxReport, HybridResult } from "@/lib/parlay/hybrid";
import { isWeeklySlateLeague } from "@/lib/live-category-picks";
import type { HybridEventNote } from "@/server/data/hybrid-generate";
import type { SnapshotSkippedGame } from "@/server/data/generator-snapshot";

export type HybridSkipReason =
  | "started"
  | "outside-window"
  | "no-eligible-picks"
  | "no-side-picks"
  | "no-total-picks"
  | "below-gate"
  | "not-enough-supporters"
  | "beyond-ladder-limit"
  | "ladder-unavailable"
  | "no-usable-line"
  | "not-used";

// Gate order: counts and rows are listed in it.
export const SKIP_REASON_ORDER: HybridSkipReason[] = [
  "started",
  "outside-window",
  "no-eligible-picks",
  "no-side-picks",
  "no-total-picks",
  "below-gate",
  "not-enough-supporters",
  "beyond-ladder-limit",
  "ladder-unavailable",
  "no-usable-line",
  "not-used",
];

export function skipReasonLabel(reason: HybridSkipReason, minSupporters = HYBRID_MIN_SUPPORTERS): string {
  switch (reason) {
    case "started":
      return "Already started";
    case "outside-window":
      return "Not on the slate yet";
    case "no-eligible-picks":
      return "No full-game side or total picks";
    case "no-side-picks":
      return "No side picks";
    case "no-total-picks":
      return "No total picks";
    case "below-gate":
      return "Best capper below your win rate";
    case "not-enough-supporters":
      return minSupporters <= 1 ? "Cappers took both sides" : `Fewer than ${minSupporters} cappers agree`;
    case "beyond-ladder-limit":
      return "Past the pricing limit";
    case "ladder-unavailable":
      return "FanDuel lines not available";
    case "no-usable-line":
      return "No FanDuel line within limits";
    case "not-used":
      return "Not needed";
  }
}

export type HybridSkip = { eventId: string; gameLabel: string; leagueName: string; picks: number; reason: HybridSkipReason; text: string };

export type HybridDiagnostics = {
  // Games with at least one pending pick in scope (used or not).
  gamesWithPicks: number;
  // Games in the primary parlay.
  gamesUsed: number;
  // One row per game with picks the result does not use (alternates are used), in gate order.
  skipped: HybridSkip[];
  // Rows per reason, in gate order; only reasons that occur.
  counts: { reason: HybridSkipReason; label: string; count: number }[];
};

export type ExplainInput = {
  // The games the positions were built from (Include Picks and targets applied).
  games: GeneratorGame[];
  // Pending picks per game before Include Picks: what the row says the game had.
  pickCounts: Record<string, number>;
  snapshotSkipped: SnapshotSkippedGame[];
  records: Pick<GeneratorSnapshot, "leagueRecords" | "categoryRecords" | "propMarketRecords">;
  minWinPct: number;
  // True when Include Picks leaves something out ("in your Bet types").
  filtered: boolean;
  positions: ConsensusPosition[];
  candidateEvents: string[];
  notes: HybridEventNote[];
  report: HybridBoxReport;
  result: HybridResult;
  minSupporters?: number;
};

const s = (n: number) => (n === 1 ? "" : "s");
const pct = (x: number) => `${Math.round(x)}%`;
const directionLabel = (d: string) => (d === "OVER" ? "Over" : d === "UNDER" ? "Under" : d);

function noteText(note: HybridEventNote): string {
  if (note.kind === "alt-lines-not-posted") return "FanDuel hasn't posted alternate lines for this game yet";
  if (note.kind === "pricing-in-progress") return "Another request is pricing this game - try again in a moment";
  if (note.cause === "budget" || note.cause === "usage-gate") return "Today's FanDuel price lookups are used up";
  return "FanDuel prices are unavailable right now";
}

// The first of gates b-e a game fails, or null when it has a side and a total position.
function consensusGate(
  game: GeneratorGame,
  input: ExplainInput,
  minSupporters: number
): { reason: HybridSkipReason; text: string } | null {
  const d = diagnoseConsensusGame(game, input.records, { minWinPct: input.minWinPct });
  const scope = input.filtered ? " in your Bet types" : "";
  if (d.side.posts + d.total.posts === 0) {
    const other = d.otherPicks;
    return { reason: "no-eligible-picks", text: `No full-game spread, moneyline or total picks${scope}` + (other > 0 ? ` (${other} other pick${s(other)}: props, periods or team totals)` : "") };
  }
  if (d.side.posts === 0) return { reason: "no-side-picks", text: `No full-game side picks (spread or moneyline)${scope}` };
  if (d.total.posts === 0) return { reason: "no-total-picks", text: `No full-game total picks${scope}` };
  const gate = input.minWinPct;
  // At 0% the gate is "has a record", so "at 0%+" would read oddly.
  const who = gate === 0 ? "with a record" : `at ${gate}%+`;
  const families: [string, FamilyDiagnosis][] = [
    ["side", d.side],
    ["total", d.total],
  ];
  for (const [noun, f] of families) {
    const gated = Object.values(f.gatedByDirection).reduce((a, b) => a + b, 0) + f.hedged;
    if (gated > 0) continue;
    if (!f.best) return { reason: "below-gate", text: gate === 0 ? `No ${noun} capper has a graded record in this bet yet` : `No ${noun} capper has a record in this bet yet (needs ${gate}%)` };
    return { reason: "below-gate", text: `Best ${directionLabel(f.best.direction)} capper ${pct(f.best.winPct)} (${f.best.wins}-${f.best.losses}), needs ${gate}%` };
  }
  for (const [noun, f] of families) {
    const entries = Object.entries(f.gatedByDirection).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return { reason: "not-enough-supporters", text: `Cappers ${who} took both sides of the ${noun}, so neither side counts` };
    const [direction, count] = entries[0];
    if (count < minSupporters) return { reason: "not-enough-supporters", text: `Only ${count} capper${s(count)} ${who} on the ${noun} (${directionLabel(direction)}); needs ${minSupporters}` };
  }
  const has = (family: "SIDE" | "TOTAL") => input.positions.some((p) => p.eventId === game.gameId && p.family === family);
  if (!has("SIDE") || !has("TOTAL")) return { reason: "not-enough-supporters", text: `No ${has("SIDE") ? "total" : "side"} that enough cappers agree on` };
  return null;
}

export function explainSkips(input: ExplainInput): HybridDiagnostics {
  const minSupporters = input.minSupporters ?? HYBRID_MIN_SUPPORTERS;
  const used = new Set((input.result.primary?.legs ?? []).map((l) => l.eventId));
  const alternates = new Set(input.result.alternates.flatMap((h) => h.legs.map((l) => l.eventId)));
  const candidates = new Set(input.candidateEvents);
  const noteOf = new Map(input.notes.map((n) => [n.eventId, n]));
  const noLine = new Map(input.report.noLine.map((x) => [x.eventId, x.leg]));
  const leftOut = new Map(input.report.leftOut.map((x) => [x.eventId, x.why]));
  const notReached = new Set(input.report.notReached);
  const rows: HybridSkip[] = [];

  for (const s0 of input.snapshotSkipped) {
    const text = s0.reason === "started" ? "Already started" : isWeeklySlateLeague(s0.leagueName) ? "Not in this week's slate" : "Not on today's slate";
    rows.push({ eventId: s0.gameId, gameLabel: s0.gameLabel, leagueName: s0.leagueName, picks: s0.picks, reason: s0.reason, text });
  }

  let gamesWithPicks = input.snapshotSkipped.length;
  for (const game of input.games) {
    const picks = input.pickCounts[game.gameId] ?? game.picks.length;
    if (picks === 0) continue;
    gamesWithPicks++;
    if (used.has(game.gameId) || alternates.has(game.gameId)) continue;
    const row = (reason: HybridSkipReason, text: string) => rows.push({ eventId: game.gameId, gameLabel: game.gameLabel, leagueName: game.leagueName, picks, reason, text });

    const gate = consensusGate(game, input, minSupporters);
    if (gate) {
      row(gate.reason, gate.text);
      continue;
    }
    if (!candidates.has(game.gameId)) {
      row("beyond-ladder-limit", `Not priced: each generation prices the top ${input.candidateEvents.length} qualifying game${s(input.candidateEvents.length)}`);
      continue;
    }
    const note = noteOf.get(game.gameId);
    if (note && !leftOut.has(game.gameId)) {
      row("ladder-unavailable", noteText(note));
      continue;
    }
    const leg = noLine.get(game.gameId);
    if (leg) {
      row("no-usable-line", `No usable FanDuel ${leg} line (none within -600 or your per-leg range)`);
      continue;
    }
    const why = leftOut.get(game.gameId);
    if (why === "cap") row("not-used", "Total legs cap reached");
    else if (why === "ranked" || notReached.has(game.gameId)) row("not-used", "Ranked below the games shown");
    else row("not-used", "Not used in this parlay");
  }

  const order = (r: HybridSkip) => SKIP_REASON_ORDER.indexOf(r.reason);
  rows.sort((a, b) => order(a) - order(b) || (a.gameLabel < b.gameLabel ? -1 : a.gameLabel > b.gameLabel ? 1 : 0));
  const counts = SKIP_REASON_ORDER.map((reason) => ({ reason, label: skipReasonLabel(reason, minSupporters), count: rows.filter((r) => r.reason === reason).length })).filter((c) => c.count > 0);
  return { gamesWithPicks, gamesUsed: used.size, skipped: rows, counts };
}
