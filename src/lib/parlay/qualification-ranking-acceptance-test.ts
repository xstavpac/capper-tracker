// Proof for qualification-ranking.ts (Sections 3, 5, 7 of docs/parlay-
// white-paper.md). Pure: no DB, no imports beyond the module under test and
// its own dependencies (relationship-classifier.ts, stats.ts, picks.ts -
// none of which are queried, only imported for pure helper functions - see
// qualification-ranking.ts's own header for why that's safe). Run with:
//   npx tsx src/lib/parlay/qualification-ranking-acceptance-test.ts
import {
  wilsonLowerBound,
  qualifies,
  contrarianHeadcountPasses,
  rankCandidates,
  type ParlayLeg,
} from "@/lib/parlay/qualification-ranking";
import type { CategoryBreakdownItem } from "@/server/data/stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function checkClose(label: string, actual: number, expected: number, tolerance: number) {
  const pass = Math.abs(actual - expected) <= tolerance;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${actual} expected=${expected}±${tolerance}`);
  if (!pass) failures++;
}
function checkTrue(label: string, actual: unknown) {
  check(label, Boolean(actual), true);
}
function checkFalse(label: string, actual: unknown) {
  check(label, Boolean(actual), false);
}

const GAME_TIME = new Date("2026-09-01T23:00:00Z");
const HOME = "New York Yankees";
const AWAY = "Boston Red Sox";

function mkLeg(overrides: Partial<ParlayLeg>): ParlayLeg {
  return {
    pickId: "p1",
    capperId: "capper1",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    betDetail: "Yankees ML",
    line: null,
    odds: -150,
    datePosted: new Date("2026-09-01T12:00:00Z"),
    homeTeam: HOME,
    awayTeam: AWAY,
    gameTime: GAME_TIME,
    sportName: "MLB",
    ...overrides,
  };
}

function record(wins: number, losses: number, opts: Partial<CategoryBreakdownItem> = {}): CategoryBreakdownItem {
  const pushes = opts.pushes ?? 0;
  return {
    key: opts.key ?? "OVER",
    label: opts.label ?? "",
    wins,
    losses,
    pushes,
    winPct: opts.winPct ?? (wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0),
    count: wins + losses + pushes,
  };
}

// ============================================================================
// wilsonLowerBound (Section 7 Step 1)
// ============================================================================
{
  checkClose("Wilson 6-2 -> 0.4093", wilsonLowerBound(6, 2), 0.4093, 0.0001);
  checkClose("Wilson 3-0 -> 0.4385", wilsonLowerBound(3, 0), 0.4385, 0.0001);
  checkClose("Wilson 30-20 -> 0.4618", wilsonLowerBound(30, 20), 0.4618, 0.0001);
  checkTrue("Wilson: 30-20 outranks 3-0 despite lower raw win% (60% vs 100%)", wilsonLowerBound(30, 20) > wilsonLowerBound(3, 0));
  check("Wilson 0-0 -> exactly 0", wilsonLowerBound(0, 0), 0);
}

// ============================================================================
// qualifies (Section 3 gate) - boundary behavior
// ============================================================================
{
  checkFalse("gate: 54.9% fails", qualifies(record(549, 451, { winPct: 54.9 })));
  checkTrue("gate: 55.0% passes (boundary, matches Sharp Money's `< 55` skip)", qualifies(record(550, 450, { winPct: 55.0 })));
  checkTrue("gate: 55.1% passes", qualifies(record(551, 449, { winPct: 55.1 })));
  checkFalse("gate: null record fails", qualifies(null));
}

// ============================================================================
// contrarianHeadcountPasses (Section 5(b))
// ============================================================================
{
  const primary = mkLeg({ pickId: "primary", capperId: "primaryCapper", betType: "MONEYLINE", betDetail: "Yankees ML" });

  // Primary alone (no other same-game picks) vs one opposing capper -> 1v1 tie -> fails.
  const oneOpposing = [mkLeg({ pickId: "opp1", capperId: "oppCapper1", betType: "MONEYLINE", betDetail: "Red Sox ML" })];
  checkFalse("headcount: 1 vs 1 tie fails", contrarianHeadcountPasses(primary, oneOpposing));

  // Add a second Yankees-side capper -> 2 vs 1 majority -> passes.
  const majority = [...oneOpposing, mkLeg({ pickId: "yank2", capperId: "yankCapper2", betType: "MONEYLINE", betDetail: "Yankees ML" })];
  checkTrue("headcount: majority (2 vs 1) passes", contrarianHeadcountPasses(primary, majority));

  // Exact duplicate of the primary (different capper, identical market/direction) counts toward the primary's side.
  const dupCapper = mkLeg({ pickId: "dup", capperId: "dupCapper", betType: "MONEYLINE", betDetail: "Yankees ML" });
  checkFalse("headcount: without the duplicate, 1 vs 1 tie fails", contrarianHeadcountPasses(primary, oneOpposing));
  checkTrue("headcount: duplicate of primary counts toward primary's side, breaking the tie (2 vs 1)", contrarianHeadcountPasses(primary, [...oneOpposing, dupCapper]));

  // TOTAL case: Over vs Under.
  const totalPrimary = mkLeg({ pickId: "totalPrimary", capperId: "totalCapper", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 });
  const oneUnder = [mkLeg({ pickId: "under1", capperId: "underCapper1", betType: "TOTAL", betDetail: "Under 8.5", line: 8.5 })];
  checkFalse("headcount TOTAL: 1 Over (primary) vs 1 Under is a tie, fails", contrarianHeadcountPasses(totalPrimary, oneUnder));
  const twoOver = [...oneUnder, mkLeg({ pickId: "over2", capperId: "overCapper2", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 })];
  checkTrue("headcount TOTAL: 2 Over vs 1 Under passes", contrarianHeadcountPasses(totalPrimary, twoOver));

  // NRFI case: NRFI (Under) vs YRFI (Over).
  const nrfiPrimary = mkLeg({ pickId: "nrfiPrimary", capperId: "nrfiCapper", betType: "NRFI", betDetail: "Yankees/Red Sox NRFI", period: "FULL_GAME", line: null });
  const oneYrfi = [mkLeg({ pickId: "yrfi1", capperId: "yrfiCapper1", betType: "NRFI", betDetail: "Yankees/Red Sox YRFI", period: "FULL_GAME", line: null })];
  checkFalse("headcount NRFI: 1 NRFI (primary) vs 1 YRFI is a tie, fails", contrarianHeadcountPasses(nrfiPrimary, oneYrfi));
  const twoNrfi = [...oneYrfi, mkLeg({ pickId: "nrfi2", capperId: "nrfiCapper2", betType: "NRFI", betDetail: "Yankees/Red Sox NRFI", period: "FULL_GAME", line: null })];
  checkTrue("headcount NRFI: 2 NRFI vs 1 YRFI passes", contrarianHeadcountPasses(nrfiPrimary, twoNrfi));

  // "Tracked as of that date" applies uniformly, INCLUDING to the primary -
  // a primary posted AFTER its own game started (a real, fairly common
  // pattern in imported data) gets no automatic pass for its own side. With
  // no other same-game picks at all, that means 0-vs-0, which fails (not a
  // vacuous pass).
  const latePrimary = mkLeg({
    pickId: "latePrimary",
    capperId: "lateCapper",
    betType: "MONEYLINE",
    betDetail: "Yankees ML",
    datePosted: new Date("2026-09-02T00:05:00Z"), // after GAME_TIME (2026-09-01T23:00:00Z)
  });
  checkFalse("headcount: primary posted after its own gameTime doesn't get an automatic pass (0 vs 0)", contrarianHeadcountPasses(latePrimary, []));
}

// ============================================================================
// rankCandidates (Section 7 Steps 1-2) - mode filtering, gate exclusion, tie-break
// ============================================================================
{
  const primary = mkLeg({ pickId: "primary", capperId: "primaryCapper", betType: "MONEYLINE", betDetail: "Yankees ML", odds: -150 });

  const r1 = mkLeg({ pickId: "r1-spread", capperId: "capA", betType: "SPREAD", betDetail: "Yankees -1.5", line: -1.5, odds: -110 }); // R1: same team, different market -> CORRELATED/NEITHER
  const r2 = mkLeg({ pickId: "r2-oppml", capperId: "capB", betType: "MONEYLINE", betDetail: "Red Sox ML", odds: -120 }); // R2: opposing team -> CONTRARIAN
  const r4 = mkLeg({ pickId: "r4-total", capperId: "capC", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5, odds: -110 }); // R4: side vs total -> AUTO_HEDGE
  const r5 = mkLeg({ pickId: "r5-f5ml", capperId: "capD", betType: "MONEYLINE", betDetail: "Yankees F5 ML", period: "FIRST_HALF", odds: -130 }); // R5: nested scope, same direction -> AUTO_HEDGE
  const r6 = mkLeg({ pickId: "r6-oppf5ml", capperId: "capE", betType: "MONEYLINE", betDetail: "Red Sox F5 ML", period: "FIRST_HALF", odds: 110 }); // R6: nested scope, opposite direction -> excluded
  const dup = mkLeg({ pickId: "dup-ml", capperId: "capF", betType: "MONEYLINE", betDetail: "Yankees ML", odds: -150 }); // EXACT_DUPLICATE

  const qualifyingML = record(6, 4, { key: "FAV_ML", winPct: 60 }); // 60%, n=10
  const qualifyingSpread = record(6, 4, { key: "SPREAD_MINUS", winPct: 60 });
  const qualifyingTotal = record(6, 4, { key: "OVER", winPct: 60 });

  const records: Record<string, CategoryBreakdownItem | null> = {
    "capA|SPREAD_MINUS": qualifyingSpread,
    "capB|FAV_ML": qualifyingML,
    "capC|OVER": qualifyingTotal,
    "capD|F5_ML": qualifyingML,
    "capE|F5_ML": record(4, 6, { key: "F5_ML", winPct: 40 }), // irrelevant - R6 is excluded before the gate is even checked
    "capF|FAV_ML": qualifyingML,
  };

  const candidates = [r1, r2, r4, r5, r6, dup];
  // Give the primary a same-game headcount majority so CONTRARIAN's R2 candidate is reachable in that test.
  const sameGamePicksForHeadcount = [...candidates, mkLeg({ pickId: "extraYank", capperId: "extraYankCapper", betType: "MONEYLINE", betDetail: "Yankees ML", odds: -140 })];

  const autoHedgeResult = rankCandidates(primary, candidates, "AUTO_HEDGE", records, sameGamePicksForHeadcount);
  check("ranking AUTO_HEDGE: keeps only R4/R5 candidates", autoHedgeResult.map((r) => r.leg.pickId).sort(), ["r4-total", "r5-f5ml"].sort());
  check("ranking AUTO_HEDGE: rule R4 recorded for the total candidate", autoHedgeResult.find((r) => r.leg.pickId === "r4-total")?.rule, "R4");
  check("ranking AUTO_HEDGE: rule R5 recorded for the F5 ML candidate", autoHedgeResult.find((r) => r.leg.pickId === "r5-f5ml")?.rule, "R5");

  const contrarianResult = rankCandidates(primary, candidates, "CONTRARIAN", records, sameGamePicksForHeadcount);
  check("ranking CONTRARIAN: keeps only the R2 candidate", contrarianResult.map((r) => r.leg.pickId), ["r2-oppml"]);
  check("ranking CONTRARIAN: rule R2 recorded", contrarianResult[0]?.rule, "R2");

  checkFalse("ranking: R1 (same-team, different market) never appears in AUTO_HEDGE", autoHedgeResult.some((r) => r.leg.pickId === "r1-spread"));
  checkFalse("ranking: R1 never appears in CONTRARIAN", contrarianResult.some((r) => r.leg.pickId === "r1-spread"));
  checkFalse("ranking: R6 (excluded) never appears in AUTO_HEDGE", autoHedgeResult.some((r) => r.leg.pickId === "r6-oppf5ml"));
  checkFalse("ranking: R6 never appears in CONTRARIAN", contrarianResult.some((r) => r.leg.pickId === "r6-oppf5ml"));
  checkFalse("ranking: EXACT_DUPLICATE never appears in AUTO_HEDGE", autoHedgeResult.some((r) => r.leg.pickId === "dup-ml"));
  checkFalse("ranking: EXACT_DUPLICATE never appears in CONTRARIAN", contrarianResult.some((r) => r.leg.pickId === "dup-ml"));

  // CONTRARIAN with a failing headcount (no extra Yankees-side capper, and
  // excluding `dup` - another Yankees ML capper that would itself break the
  // tie) -> the R2 candidate is dropped entirely.
  const noHeadcountPool = [r1, r2, r4, r5, r6];
  const contrarianNoHeadcount = rankCandidates(primary, noHeadcountPool, "CONTRARIAN", records, noHeadcountPool);
  check("ranking CONTRARIAN: with only a 1v1 headcount (no majority), no candidates survive", contrarianNoHeadcount, []);

  // Market-specificity: a 60%-qualifying MONEYLINE record must not make a TOTAL candidate qualify - drop the
  // TOTAL candidate's own record and give its capper ONLY a qualifying ML record instead.
  const mlOnlyRecords: Record<string, CategoryBreakdownItem | null> = { "capC|FAV_ML": record(6, 4, { key: "FAV_ML", winPct: 60 }) };
  const marketSpecificResult = rankCandidates(primary, [r4], "AUTO_HEDGE", mlOnlyRecords);
  check("ranking: candidate's own market must have its own qualifying record - a good ML record elsewhere doesn't leak into TOTAL", marketSpecificResult, []);
}

// ============================================================================
// Gate exclusion beats a high hypothetical Wilson score
// ============================================================================
{
  const primary = mkLeg({ pickId: "primary2", capperId: "primaryCapper2", betType: "MONEYLINE", betDetail: "Yankees ML" });
  // Fails the gate (54%) but on a huge sample - would rank #1 by Wilson LB if it were allowed through.
  const bigSampleFailsGate = mkLeg({ pickId: "big-sample-total", capperId: "bigCapper", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 });
  // Qualifies (60%) but on a small sample - genuinely lower Wilson LB than what the failing candidate WOULD have had.
  const smallSamplePasses = mkLeg({ pickId: "small-sample-total", capperId: "smallCapper", betType: "TOTAL", betDetail: "Under 6.5", line: 6.5 });

  const bigFailRecord = record(540, 460, { key: "OVER", winPct: 54 }); // 54% of 1000 - would-be Wilson LB ~0.51, well above any small-sample candidate below
  const smallPassRecord = record(6, 4, { key: "UNDER", winPct: 60 }); // 60% of 10 - genuine Wilson LB ~0.31

  checkTrue(
    "sanity: the gate-failing candidate's hypothetical Wilson LB really is higher than the qualifying one's (so exclusion is the gate, not the score)",
    wilsonLowerBound(bigFailRecord.wins, bigFailRecord.losses) > wilsonLowerBound(smallPassRecord.wins, smallPassRecord.losses)
  );

  const records: Record<string, CategoryBreakdownItem | null> = {
    "bigCapper|OVER": bigFailRecord,
    "smallCapper|UNDER": smallPassRecord,
  };
  const result = rankCandidates(primary, [bigSampleFailsGate, smallSamplePasses], "AUTO_HEDGE", records);
  check("ranking: gate-failing candidate excluded even with a higher would-be Wilson score", result.map((r) => r.leg.pickId), ["small-sample-total"]);
}

// ============================================================================
// Pushes never enter the Wilson computation
// ============================================================================
{
  const primary = mkLeg({ pickId: "primary3", capperId: "primaryCapper3", betType: "MONEYLINE", betDetail: "Yankees ML" });
  const candidateA = mkLeg({ pickId: "push-free", capperId: "capNoPush", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 });
  const candidateB = mkLeg({ pickId: "with-pushes", capperId: "capWithPush", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 });

  const records: Record<string, CategoryBreakdownItem | null> = {
    "capNoPush|OVER": record(6, 4, { key: "OVER", winPct: 60, pushes: 0 }),
    "capWithPush|OVER": record(6, 4, { key: "OVER", winPct: 60, pushes: 25 }), // same wins/losses, many pushes
  };
  const result = rankCandidates(primary, [candidateA, candidateB], "AUTO_HEDGE", records);
  const lbNoPush = result.find((r) => r.leg.pickId === "push-free")?.wilsonLowerBound;
  const lbWithPush = result.find((r) => r.leg.pickId === "with-pushes")?.wilsonLowerBound;
  check("pushes: identical wins/losses give identical Wilson LB regardless of push count", lbNoPush, lbWithPush);
}

// ============================================================================
// Deterministic tie-break: identical Wilson LB (same wins/losses) -> decided-n desc, then pick id asc
// ============================================================================
{
  const primary = mkLeg({ pickId: "primary4", capperId: "primaryCapper4", betType: "MONEYLINE", betDetail: "Yankees ML" });
  const candB = mkLeg({ pickId: "tie-b", capperId: "capTieB", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 });
  const candA = mkLeg({ pickId: "tie-a", capperId: "capTieA", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 });
  const records: Record<string, CategoryBreakdownItem | null> = {
    "capTieB|OVER": record(6, 4, { key: "OVER", winPct: 60 }),
    "capTieA|OVER": record(6, 4, { key: "OVER", winPct: 60 }),
  };
  // Feed them in reverse (b, a) - the tie-break must still resolve to ["tie-a", "tie-b"] by pick id, not input order.
  const result = rankCandidates(primary, [candB, candA], "AUTO_HEDGE", records);
  check("tie-break: identical Wilson LB and identical decided-n sorts by pick id ascending, independent of input order", result.map((r) => r.leg.pickId), ["tie-a", "tie-b"]);
}

// ============================================================================
// Purity / no cross-call leakage: same capperId reused across two disjoint calls
// (simulating two different users' cappers sharing an id) must never mix.
// This is a purity check (no module-level cache/shared state) - the module
// has no DB access to scope in the first place.
// ============================================================================
{
  const primary = mkLeg({ pickId: "primary5", capperId: "primaryCapper5", betType: "MONEYLINE", betDetail: "Yankees ML" });
  const sharedCandidate = mkLeg({ pickId: "shared-total", capperId: "sharedCapper", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5 });

  const call1Records: Record<string, CategoryBreakdownItem | null> = { "sharedCapper|OVER": record(6, 4, { key: "OVER", winPct: 60 }) };
  const call1Result = rankCandidates(primary, [sharedCandidate], "AUTO_HEDGE", call1Records);
  check("purity call 1: shared capperId qualifies with call 1's own record (60%)", call1Result.map((r) => r.leg.pickId), ["shared-total"]);

  const call2Records: Record<string, CategoryBreakdownItem | null> = { "sharedCapper|OVER": record(4, 6, { key: "OVER", winPct: 40 }) };
  const call2Result = rankCandidates(primary, [sharedCandidate], "AUTO_HEDGE", call2Records);
  check("purity call 2: same capperId, independent call with a non-qualifying record (40%) - excluded, no leakage from call 1", call2Result, []);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
