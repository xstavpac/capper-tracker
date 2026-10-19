// The same bet at two lines (duplicateLine, same-game-rules.ts) is one leg,
// never two: Tulane Over 53.5 + Over 52.5 (the 2026-10-16 Memphis @ Tulane
// slip, two cappers), a spread at two numbers, a team total at two lines, a
// prop at two lines. Of the two, the better-ranked pick stays; on equal
// records, the better line. Covers duplicateLine itself, blocks() (every slip
// build), sameGameConflict (Auto-Generate's same-game fill) and the slip build
// end to end. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/duplicate-line-acceptance-test.ts
import { duplicateLine, sameGameConflict } from "@/lib/parlay/same-game-rules";
import { blocks, selectConflictFreeLegs, type BuildCandidate } from "@/lib/parlay/build-my-picks";
import { buildFromSlip, type SlipBuild } from "@/lib/parlay/slip-build";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import type { ParlayCandidate } from "@/lib/parlay/relationship-classifier";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const TULANE = { homeTeam: "Tulane Green Wave", awayTeam: "Memphis Tigers", gameTime: new Date("2026-10-16T23:30:00Z"), sportName: "NCAAF", gameId: "tulane" };
const RAIDERS = { homeTeam: "Las Vegas Raiders", awayTeam: "Buffalo Bills", gameTime: new Date("2026-10-18T20:25:00Z"), sportName: "NFL", gameId: "raiders" };
const CUBS = { homeTeam: "Chicago Cubs", awayTeam: "Tampa Bay Rays", gameTime: new Date("2026-06-01T23:00:00Z"), sportName: "MLB", gameId: "cubs" };

const c = (game: ParlayCandidate["game"], betType: string, betDetail: string, line: number | null, period = "FULL_GAME"): ParlayCandidate => ({
  pick: { betType, period, betDetail, line },
  game,
});

// ============================================================================
// duplicateLine: what counts, and which line is better.
// ============================================================================
{
  const over535 = c(TULANE, "TOTAL", "Over 53.5", 53.5);
  const over525 = c(TULANE, "TOTAL", "Over 52.5", 52.5);
  check("Tulane Over 53.5 vs Over 52.5: a duplicate, the lower Over is better", duplicateLine(over535, over525), { better: "B" });
  check("...symmetric", duplicateLine(over525, over535), { better: "A" });
  check("Under 53.5 vs Under 52.5: the higher Under is better", duplicateLine(c(TULANE, "TOTAL", "Under 53.5", 53.5), c(TULANE, "TOTAL", "Under 52.5", 52.5)), { better: "A" });
  check("Over vs Under: not a duplicate (opposing)", duplicateLine(over535, c(TULANE, "TOTAL", "Under 52.5", 52.5)), null);
  check("same line: not a duplicate line (the classifier's exact duplicate)", duplicateLine(over535, c(TULANE, "TOTAL", "Over 53.5", 53.5)), null);
  check("first-half total vs full-game total: two markets", duplicateLine(over535, c(TULANE, "TOTAL", "1H Over 26.5", 26.5, "FIRST_HALF")), null);
  check("another game: not a duplicate", duplicateLine(over535, c({ ...TULANE, gameId: "other" }, "TOTAL", "Over 52.5", 52.5)), null);

  const tul7 = c(TULANE, "SPREAD", "Tulane Green Wave +7", 7);
  const tul65 = c(TULANE, "SPREAD", "Tulane Green Wave +6.5", 6.5);
  check("Tulane +7 vs +6.5: more points is better", duplicateLine(tul7, tul65), { better: "A" });
  check("Memphis -6.5 vs -7.5: laying fewer is better", duplicateLine(c(TULANE, "SPREAD", "Memphis Tigers -6.5", -6.5), c(TULANE, "SPREAD", "Memphis Tigers -7.5", -7.5)), { better: "A" });
  check("Tulane +7 vs Memphis -6.5: opposing sides, not a duplicate", duplicateLine(tul7, c(TULANE, "SPREAD", "Memphis Tigers -6.5", -6.5)), null);
  check("Tulane ML vs Tulane +7: two markets", duplicateLine(c(TULANE, "MONEYLINE", "Tulane Green Wave ML", null), tul7), null);

  check("Cubs team total Over 4.5 vs Over 3.5: a duplicate", duplicateLine(c(CUBS, "TEAM_TOTAL", "Cubs Over 4.5", 4.5), c(CUBS, "TEAM_TOTAL", "Cubs Over 3.5", 3.5)), { better: "B" });
  check("Cubs Over 4.5 vs Rays Over 3.5: two teams", duplicateLine(c(CUBS, "TEAM_TOTAL", "Cubs Over 4.5", 4.5), c(CUBS, "TEAM_TOTAL", "Rays Over 3.5", 3.5)), null);

  const bowers795 = c(RAIDERS, "PLAYER_PROP", "Brock Bowers Over 79.5 Receiving Yards", 79.5);
  const bowers495 = c(RAIDERS, "PLAYER_PROP", "Brock Bowers Over 49.5 Receiving Yards", 49.5);
  check("Bowers Over 79.5 vs Over 49.5 receiving: a duplicate, the lower Over is better", duplicateLine(bowers795, bowers495), { better: "B" });
  check("Bowers Over vs Under: not a duplicate line", duplicateLine(bowers795, c(RAIDERS, "PLAYER_PROP", "Brock Bowers Under 49.5 Receiving Yards", 49.5)), null);
  check("Bowers receiving vs Allen receiving: two players", duplicateLine(bowers795, c(RAIDERS, "PLAYER_PROP", "Josh Allen Over 49.5 Receiving Yards", 49.5)), null);
  check("two copies of one anytime-TD prop: the same bet", duplicateLine(c(RAIDERS, "PLAYER_PROP", "Josh Allen Anytime Touchdown", null), c(RAIDERS, "PLAYER_PROP", "Josh Allen Anytime Touchdown", null)), { better: "EQUAL" });
  check("the same prop in another game: not a duplicate", duplicateLine(bowers795, { ...bowers495, game: { ...RAIDERS, gameId: "other" } }), null);
  check("a prop vs a game total: not a duplicate",duplicateLine(bowers795, c(RAIDERS, "TOTAL", "Over 49.5", 49.5)), null);
}

// ============================================================================
// sameGameConflict (Auto-Generate's same-game fill): already blocked sides and
// game totals keep their rule; a team total at two lines is now blocked too.
// ============================================================================
{
  check("Tulane Over 53.5 + Over 52.5: still R-B", sameGameConflict(c(TULANE, "TOTAL", "Over 53.5", 53.5), c(TULANE, "TOTAL", "Over 52.5", 52.5))?.rule, "R-B");
  check("Cubs team total at two lines: DUPLICATE", sameGameConflict(c(CUBS, "TEAM_TOTAL", "Cubs Over 4.5", 4.5), c(CUBS, "TEAM_TOTAL", "Cubs Over 3.5", 3.5)), {
    rule: "DUPLICATE",
    reason: "the same bet at another line",
  });
  check("Cubs Over 4.5 + Rays Over 3.5: still allowed", sameGameConflict(c(CUBS, "TEAM_TOTAL", "Cubs Over 4.5", 4.5), c(CUBS, "TEAM_TOTAL", "Rays Over 3.5", 3.5)), null);
}

// ============================================================================
// The real slip: Dorm Room Degenerates Over 53.5 (106-65) and Q9 Over 52.5
// (2-5). The better record stays.
// ============================================================================
function tulanePick(id: string, capper: string, detail: string, line: number): GeneratorPick {
  return {
    pickId: id,
    capperId: "capper-" + id,
    capperName: capper,
    capperColorTag: null,
    capperIsFavorite: false,
    category: null,
    leagueName: "NCAAF",
    gameId: "tulane",
    gameLabel: "Memphis @ Tulane",
    betDetail: detail,
    odds: -110,
    units: 1,
    status: "PENDING",
    betType: "TOTAL",
    period: "FULL_GAME",
    rawBetDetail: detail,
    line,
    homeTeam: TULANE.homeTeam,
    awayTeam: TULANE.awayTeam,
    gameTime: TULANE.gameTime.toISOString(),
    teamGroup: "TOTALS",
    teamLabel: "",
    teamColor: null,
    datePosted: "2026-10-16T12:00:00.000Z",
  } as GeneratorPick;
}
function recordsOf(byId: Record<string, [number, number]>): CapperLeagueRecords {
  const last20: CapperLeagueRecords["last20"] = {};
  for (const [id, [wins, losses]] of Object.entries(byId)) {
    last20["capper-" + id] = { wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses };
  }
  return { records: {}, streaks: {}, last20 };
}
const built = (r: SlipBuild | ParlayRejection): SlipBuild => {
  if ("error" in r) throw new Error("expected a build, got error: " + r.error);
  return r;
};

{
  const dorm = tulanePick("dorm", "Dorm Room Degenerates", "Over 53.5", 53.5);
  const q9 = tulanePick("q9", "Q9", "Over 52.5", 52.5);
  const records = recordsOf({ dorm: [106, 65], q9: [2, 5] });
  check("blocks(): the Tulane pair is blocked as a duplicate", blocks(toBuildCandidate(dorm), toBuildCandidate(q9)), { blocked: true, isDuplicate: true, betterLine: "B" });
  for (const order of [
    [dorm, q9],
    [q9, dorm],
  ]) {
    const r = built(buildFromSlip({ picks: order.map((pick) => ({ pick, locked: false })), games: [], pool: [], records, legCount: 2, source: "SLIP_ONLY" }));
    check(`slip build (order ${order.map((p) => p.pickId).join(",")}): one leg, the better record`, r.legs.map((l) => l.pickId), ["dorm"]);
    check("...the other is skipped as a duplicate of it", r.skipped.map((s) => [s.pickId, s.reason, s.won, s.note]), [
      ["q9", "duplicate", "HIGHER_RANKED", "Skipped Q9 — Over 52.5 — duplicate of Dorm Room Degenerates — Over 53.5 (higher-ranked)"],
    ]);
    check("...and the build is short, never filled with the duplicate", r.shortfall, 1);
  }
  // Locked, both: refused with the same-bet message, as for an exact duplicate.
  const both = buildFromSlip({ picks: [{ pick: dorm, locked: true }, { pick: q9, locked: true }], games: [], pool: [], records, legCount: 2, source: "SLIP_ONLY" });
  check("both locked: refused, they are the same bet", "error" in both && both.error.includes("are the same bet"), true);
  // A locked worse line keeps its leg over a better line.
  const locked = built(buildFromSlip({ picks: [{ pick: dorm, locked: false }, { pick: q9, locked: true }], games: [], pool: [], records, legCount: 2, source: "SLIP_ONLY" }));
  check("a locked Over 52.5 by the weaker capper stays; Over 53.5 is skipped (locked)", [locked.legs.map((l) => l.pickId), locked.skipped.map((s) => s.won)], [["q9"], ["LOCKED"]]);
}

// ============================================================================
// Equal records: the better line wins, whichever ranks first by pick id.
// ============================================================================
{
  const a = tulanePick("a", "Capper A", "Over 53.5", 53.5);
  const b = tulanePick("b", "Capper B", "Over 52.5", 52.5);
  const records = recordsOf({ a: [12, 8], b: [12, 8] });
  const r = built(buildFromSlip({ picks: [a, b].map((pick) => ({ pick, locked: false })), games: [], pool: [], records, legCount: 2, source: "SLIP_ONLY" }));
  check("equal records: Over 52.5 (better line) is the leg, though Over 53.5 ranks first by id", r.legs.map((l) => l.pickId), ["b"]);
  check("...Over 53.5 skipped, the winner's reason is the better line", r.skipped.map((s) => [s.pickId, s.won, s.note]), [
    ["a", "BETTER_LINE", "Skipped Capper A — Over 53.5 — duplicate of Capper B — Over 52.5 (better line)"],
  ]);
  const r2 = built(buildFromSlip({ picks: [b, a].map((pick) => ({ pick, locked: false })), games: [], pool: [], records, legCount: 2, source: "SLIP_ONLY" }));
  check("...same answer in the other slip order", r2.legs.map((l) => l.pickId), ["b"]);

  // A better line that conflicts with another leg never takes over.
  const cand = (p: GeneratorPick, extra: Partial<BuildCandidate> = {}) => ({ ...toBuildCandidate(p, records), ...extra });
  const under = tulanePick("u", "Capper U", "Under 52.5", 52.5);
  const uRecords = recordsOf({ a: [12, 8], b: [12, 8], u: [13, 7] });
  const sel = selectConflictFreeLegs(
    [toBuildCandidate(under, uRecords), toBuildCandidate(a, uRecords), toBuildCandidate(b, uRecords)],
    3
  );
  check("Under 52.5 ranks first; neither Over fits beside it (opposing)", sel.legs.map((l) => l.pickId), ["u"]);
  // Without standing on either (an unranked caller), the better line still wins the tie.
  const plain = selectConflictFreeLegs([cand(a, { standing: undefined }), cand(b, { standing: undefined })], 2);
  check("no standing on either: equal, the better line is the leg", plain.legs.map((l) => l.pickId), ["b"]);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
