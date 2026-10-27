// Heavy Consensus (heavy-consensus.ts): the markets counted, the 8-capper / 80%
// rule on a rounded share, one count per capper, hedgers left out, the
// point-in-time cut, the one-vote-per-capper outcome, one badge per header, the
// per-viewer history and the pooled, de-duplicated hit rate. Pure - no DB. Run with:
//   npx tsx src/lib/heavy-consensus-acceptance-test.ts
import {
  buildHeavyConsensusInstances,
  heavyBadgeDetails,
  heavyBadgeText,
  heavyBadgesForGame,
  heavyBandOf,
  heavyConsensusByHeader,
  pooledHeavyConsensusRate,
  scoreHeavyMarket,
  HEAVY_CONSENSUS_MIN_CAPPERS,
  type ConsensusPick,
  type HistoryPick,
  type StoredHeavyMarket,
} from "@/lib/heavy-consensus";
import type { PickStatus } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const START = "2026-10-20T23:00:00.000Z";
const BEFORE = "2026-10-20T15:00:00.000Z";
const AFTER = "2026-10-21T00:30:00.000Z";

type Opts = Partial<ConsensusPick>;
const ml = (capperId: string, team: "HOME" | "AWAY", status: PickStatus = "PENDING", o: Opts = {}): ConsensusPick => ({
  capperId, betType: "MONEYLINE", period: "FULL_GAME", betDetail: team === "HOME" ? "Bulls ML" : "Knicks ML", teamGroup: team, status, gameTime: START, datePosted: BEFORE, ...o,
});
const spread = (capperId: string, team: "HOME" | "AWAY", status: PickStatus = "PENDING", o: Opts = {}): ConsensusPick => ({
  ...ml(capperId, team, status, o), betType: "SPREAD", betDetail: team === "HOME" ? "Bulls -3.5" : "Knicks +3.5", ...o,
});
const total = (capperId: string, text: string, status: PickStatus = "PENDING", o: Opts = {}): ConsensusPick => ({
  capperId, betType: "TOTAL", period: "FULL_GAME", betDetail: text, teamGroup: "TOTALS", status, gameTime: START, datePosted: BEFORE, ...o,
});
const many = <T>(n: number, make: (i: number) => T, from = 0): T[] => Array.from({ length: n }, (_, i) => make(i + from));

// ---- The rule ----
check("minimum is 8 cappers", HEAVY_CONSENSUS_MIN_CAPPERS, 8);
check("7 cappers, all one side -> not heavy", scoreHeavyMarket("MONEYLINE", many(7, (i) => ml("c" + i, "HOME"))), null);
check(
  "8 cappers, all one side -> 100%",
  (({ side, cappers, heavyCappers, sharePct, band }) => ({ side, cappers, heavyCappers, sharePct, band }))(scoreHeavyMarket("MONEYLINE", many(8, (i) => ml("c" + i, "HOME")))!),
  { side: "HOME", cappers: 8, heavyCappers: 8, sharePct: 100, band: "90+" }
);
check("8 of 10 -> 80% qualifies, band 80-89", scoreHeavyMarket("MONEYLINE", [...many(8, (i) => ml("c" + i, "HOME")), ...many(2, (i) => ml("c" + i, "AWAY"), 8)])?.band, "80-89");
check("7 of 9 (78%) -> not heavy", scoreHeavyMarket("MONEYLINE", [...many(7, (i) => ml("c" + i, "HOME")), ...many(2, (i) => ml("c" + i, "AWAY"), 7)]), null);
// 43 / 48 = 89.58% -> rounds to 90, so it shows 90% and sits in the 90+ band.
const rounded = scoreHeavyMarket("MONEYLINE", [...many(43, (i) => ml("c" + i, "AWAY")), ...many(5, (i) => ml("c" + i, "HOME"), 43)])!;
check("share rounds before the band (43 of 48)", [rounded.side, rounded.sharePct, rounded.band], ["AWAY", 90, "90+"]);
check("bands", [heavyBandOf(80), heavyBandOf(89), heavyBandOf(90), heavyBandOf(100)], ["80-89", "80-89", "90+", "90+"]);

// ---- What counts ----
check("one capper with several posts counts once", scoreHeavyMarket("MONEYLINE", [...many(7, (i) => ml("c" + i, "HOME")), ml("c0", "HOME"), ml("c0", "HOME")]), null);
const hedge = scoreHeavyMarket("MONEYLINE", [...many(8, (i) => ml("c" + i, "HOME")), ml("h", "HOME"), ml("h", "AWAY"), ml("x", "AWAY")])!;
check("a capper on both sides counts on neither (8 of 9, not 9 of 10)", [hedge.cappers, hedge.heavyCappers, hedge.sharePct], [9, 8, 89]);
check("a pick posted after the start does not count", scoreHeavyMarket("MONEYLINE", [...many(7, (i) => ml("c" + i, "HOME")), ml("late", "HOME", "PENDING", { datePosted: AFTER })]), null);
check("a CANCELLED pick does not count", scoreHeavyMarket("MONEYLINE", [...many(7, (i) => ml("c" + i, "HOME")), ml("void", "HOME", "CANCELLED")]), null);
check("a pick with no datePosted counts", scoreHeavyMarket("MONEYLINE", [...many(7, (i) => ml("c" + i, "HOME")), ml("old", "HOME", "PENDING", { datePosted: undefined })])?.cappers, 8);
check("a period pick is a different market (F5 ML ignored)", scoreHeavyMarket("MONEYLINE", [...many(7, (i) => ml("c" + i, "HOME")), ml("f5", "HOME", "PENDING", { period: "FIRST_HALF" })]), null);
check("ML and spread are separate markets", scoreHeavyMarket("SPREAD", many(8, (i) => ml("c" + i, "HOME"))), null);
check("an unmatched team pick (OTHER) has no side", scoreHeavyMarket("MONEYLINE", [...many(7, (i) => ml("c" + i, "HOME")), ml("o", "HOME", "PENDING", { teamGroup: "OTHER" })]), null);
check("a team total is not the game total", scoreHeavyMarket("TOTAL", [...many(7, (i) => total("c" + i, "Over 221.5")), { ...total("tt", "Bulls over 110.5"), betType: "TEAM_TOTAL" }]), null);
check(
  "total sides read from the text, shorthand included",
  scoreHeavyMarket("TOTAL", [...many(4, (i) => total("c" + i, "Under 221.5")), ...many(4, (i) => total("c" + i, "u221.5"), 4), total("o1", "o221.5")])?.side,
  "UNDER"
);
check("an O/U with no side is not counted", scoreHeavyMarket("TOTAL", [...many(7, (i) => total("c" + i, "Over 8.5")), total("ou", "O/U 8.5")]), null);

// ---- Outcome: one vote per heavy-side capper ----
// c0 posts five WINs, c1..c7 one LOSS each: per pick 5-7, per capper 1-7 -> LOSS.
check("one vote per capper (5 wins by one capper vs 7 single losses)", scoreHeavyMarket("MONEYLINE", [...many(5, () => ml("c0", "HOME", "WIN")), ...many(7, (i) => ml("c" + i, "HOME", "LOSS"), 1)])?.outcome, "LOSS");
// c0 splits 1-1 (no vote); c1..c4 WIN, c5..c7 LOSS -> 4-3 WIN.
check(
  "a capper whose own picks tie casts no vote",
  scoreHeavyMarket("MONEYLINE", [ml("c0", "HOME", "WIN"), ml("c0", "HOME", "LOSS"), ...many(4, (i) => ml("c" + i, "HOME", "WIN"), 1), ...many(3, (i) => ml("c" + i, "HOME", "LOSS"), 5)])?.outcome,
  "WIN"
);
check("a tied vote -> no outcome", scoreHeavyMarket("MONEYLINE", [...many(4, (i) => ml("c" + i, "HOME", "WIN")), ...many(4, (i) => ml("c" + i, "HOME", "LOSS"), 4)])?.outcome, null);
check("pushes and pending have no vote", scoreHeavyMarket("MONEYLINE", [...many(4, (i) => ml("c" + i, "HOME", "PUSH")), ...many(3, (i) => ml("c" + i, "HOME", "PENDING"), 4), ml("w", "HOME", "WIN")])?.outcome, "WIN");
check(
  "the minority side's grades never vote",
  scoreHeavyMarket("MONEYLINE", [...many(8, (i) => ml("c" + i, "HOME", i < 5 ? "WIN" : "LOSS")), ml("a1", "AWAY", "LOSS"), ml("a2", "AWAY", "LOSS")])?.outcome,
  "WIN"
);

// ---- One badge per header ----
const header = heavyConsensusByHeader([
  ...many(9, (i) => ml("m" + i, "HOME")), ml("m9", "AWAY"), // ML: 90% HOME
  ...many(8, (i) => spread("s" + i, "HOME")), // spread: 100% HOME
  ...many(8, (i) => total("t" + i, "Over 221.5")), // total: 100% OVER
]);
check("ML 90% and spread 100% on one team -> the spread shows", [header.HOME?.market, header.HOME?.sharePct], ["SPREAD", 100]);
check("the minority team gets no badge", header.AWAY, undefined);
check("the total's side gets its own badge", [header.OVER?.market, header.OVER?.sharePct], ["TOTAL", 100]);
check("no badge on the other total side", header.UNDER, undefined);
const tieShare = heavyConsensusByHeader([...many(10, (i) => ml("m" + i, "AWAY")), ...many(8, (i) => spread("s" + i, "AWAY"))]);
check("equal share -> more cappers wins", [tieShare.AWAY?.market, tieShare.AWAY?.cappers], ["MONEYLINE", 10]);
const tieAll = heavyConsensusByHeader([...many(8, (i) => ml("m" + i, "AWAY")), ...many(8, (i) => spread("s" + i, "AWAY"))]);
check("equal share and cappers -> the moneyline", tieAll.AWAY?.market, "MONEYLINE");
check("nothing heavy -> no badges", heavyConsensusByHeader([...many(5, (i) => ml("c" + i, "HOME")), ...many(5, (i) => ml("c" + i, "AWAY"), 5)]), {});

// ---- History ----
const game: Pick<HistoryPick, "sport" | "homeTeam" | "awayTeam" | "gameNumber"> = { sport: "NBA", homeTeam: "Chicago Bulls", awayTeam: "New York Knicks", gameNumber: null };
const hist = (userId: string, p: ConsensusPick, g: Partial<typeof game> = {}): HistoryPick => ({ ...p, ...game, ...g, userId });
const instances = buildHeavyConsensusInstances([
  ...many(9, (i) => hist("A", ml("a" + i, "HOME", "WIN"))),
  ...many(6, (i) => hist("B", ml("b" + i, "HOME", "WIN"))),
  // A's 6 Overs on the same game - a different market.
  ...many(6, (i) => hist("A", total("t" + i, "Over 221.5", "LOSS"))),
  // A's ML picks on a different game the next night.
  ...many(5, (i) => hist("A", ml("n" + i, "AWAY", "LOSS", { gameTime: "2026-10-21T23:00:00.000Z", datePosted: "2026-10-21T15:00:00.000Z" }))),
]);
check(
  "history: per viewer, per market, at the stored floor of 6",
  instances.map((i) => [i.userId, i.market, i.side, i.cappers, i.outcome]),
  [["A", "MONEYLINE", "HOME", 9, "WIN"], ["B", "MONEYLINE", "HOME", 6, "WIN"], ["A", "TOTAL", "OVER", 6, "LOSS"]]
);
check("history: Eastern date (23:00Z is 7 pm ET on the 20th)", instances[0].gameDate, "2026-10-20");
check("history: the real-world key", instances[0].worldKey, "NBA|New York Knicks|Chicago Bulls|2026-10-20|-|MONEYLINE|HOME");
check("history: two viewers on one game share the key", instances[0].worldKey === instances[1].worldKey, true);
check(
  "history: doubleheader game numbers are separate games",
  buildHeavyConsensusInstances([...many(6, (i) => hist("A", ml("g" + i, "HOME"), { gameNumber: 1 })), ...many(6, (i) => hist("A", ml("g" + i, "HOME"), { gameNumber: 2 }))]).length,
  2
);

// ---- The pooled rate ----
const row = (userId: string, worldKey: string, cappers: number, sharePct: number, outcome: "WIN" | "LOSS" | null): StoredHeavyMarket => ({ userId, worldKey, cappers, sharePct, outcome });
check("no markets -> no rate", pooledHeavyConsensusRate([]), { hitRatePct: null, games: 0 });
check(
  "one real-world market counts once; the viewer with the most cappers stands for it",
  pooledHeavyConsensusRate([row("A", "g1", 9, 90, "LOSS"), row("B", "g1", 12, 85, "WIN"), row("C", "g2", 8, 100, "LOSS")]),
  { hitRatePct: 50, games: 2 }
);
check(
  "below the minimum is filtered before de-dup (B's 6 cappers never displace A's 8)",
  pooledHeavyConsensusRate([row("A", "g1", 8, 100, "WIN"), row("B", "g1", 6, 100, "LOSS")]),
  { hitRatePct: 100, games: 1 }
);
check("equal cappers -> the higher share", pooledHeavyConsensusRate([row("A", "g1", 10, 80, "LOSS"), row("B", "g1", 10, 90, "WIN")]), { hitRatePct: 100, games: 1 });
check("equal cappers and share -> the lower userId", pooledHeavyConsensusRate([row("B", "g1", 10, 90, "WIN"), row("A", "g1", 10, 90, "LOSS")]), { hitRatePct: 0, games: 1 });
check("no-outcome markets are left out", pooledHeavyConsensusRate([row("A", "g1", 9, 90, null), row("A", "g2", 9, 90, "WIN"), row("A", "g3", 9, 90, "LOSS"), row("A", "g4", 9, 90, "LOSS")]), { hitRatePct: 33, games: 3 });
check("minimum is overridable (10)", pooledHeavyConsensusRate([row("A", "g1", 9, 90, "WIN"), row("A", "g2", 10, 90, "LOSS")], 10), { hitRatePct: 0, games: 1 });

// ---- The Live badge ----
const rate = { hitRatePct: 46, games: 92 };
// Live picks: betDetail is the display label, rawBetDetail the stored text (the total's side is read from it).
const live = [
  ...many(9, (i) => ({ ...ml("m" + i, "HOME"), rawBetDetail: "Bulls ML" })),
  { ...ml("m9", "AWAY"), rawBetDetail: "Knicks ML" },
  ...many(8, (i) => ({ ...total("t" + i, "Total 221.5"), rawBetDetail: "u221.5" })),
];
const badges = heavyBadgesForGame(live, rate);
check("badge: the team header", badges.HOME, { market: "MONEYLINE", sharePct: 90, heavyCappers: 9, cappers: 10, hitRatePct: 46, games: 92 });
check("badge: the total's side is read from rawBetDetail, not the label", [badges.UNDER?.market, badges.OVER], ["TOTAL", undefined]);
check("badge: no rate behind it -> no badges", [heavyBadgesForGame(live, null), heavyBadgesForGame(live, { hitRatePct: null, games: 0 })], [{}, {}]);
check("badge text, exactly", heavyBadgeText({ sharePct: 82, hitRatePct: 46 }), "HEAVY CONS 82% · HIT RATE 46%");
check("badge details", heavyBadgeDetails(badges.HOME!), "Moneyline · 9 of 10 cappers · Based on 92 games");
check("badge details, spread / one game", heavyBadgeDetails({ market: "SPREAD", sharePct: 100, heavyCappers: 8, cappers: 8, hitRatePct: 0, games: 1 }), "Spread · 8 of 8 cappers · Based on 1 game");

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll heavy-consensus checks passed.");
