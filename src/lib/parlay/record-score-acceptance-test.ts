// Proof for the record score (record-score.ts): the combined win % formula, its gate and
// its ranking, and that the Standard generator gates and ranks on it.
// Pure - no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/lib/parlay/record-score-acceptance-test.ts
import { combinedWinProb, RECORD_SCORE_CONFIG, recordGatePasses, scorePickByRecord } from "@/lib/parlay/record-score";
import { compareScores, EMPTY_PLATFORM_RATES, passesGate, type ScoringContext } from "@/lib/parlay/scoring";
import { buildGeneratedParlay, legSwapOptions, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}
const r1 = (x: number) => Math.round(x * 1000) / 10;
const wl = (wins: number, losses: number) => ({ wins, losses });

// ---- The config: one object, the defaults asked for ---------------------------
check("defaults: K = 15, F = 0.10, prior 0.50", [RECORD_SCORE_CONFIG.k, RECORD_SCORE_CONFIG.f, RECORD_SCORE_CONFIG.prior], [15, 0.1, 0.5]);
check("the config is frozen", Object.isFrozen(RECORD_SCORE_CONFIG), true);

// ---- Today's four real picks (2026-11-18): all-time / league / last 20 -> combined (K 15, F 0.10) --------
const real: [string, [number, number], [number, number], [number, number], number][] = [
  ["CALEB PICKS Florida ML", [25, 17], [5, 0], [14, 6], 65],
  ["The Gambling GAWD 76ers ML", [54, 49], [5, 2], [13, 7], 58],
  ["This Girl BETZ 76ers ML", [160, 128], [12, 8], [10, 10], 57],
  ["KIMSPICKS Magic ML", [23, 15], [3, 4], [10, 10], 54],
];
for (const [label, cat, lg, l20, want] of real) {
  const c = combinedWinProb({ category: wl(...cat), league: wl(...lg), last20: wl(...l20) });
  check(`${label}: ${cat.join("-")} / ${lg.join("-")} / ${l20.join("-")} -> ~${want}%`, Math.round(c.combined * 100), want);
}
{
  // Worked by hand: CALEB. Other leagues 20-17: p_other = (20 + 7.5) / 52, p_league = (5 + 15 p_other) / 20,
  // combined = .9 p_league + .1 * .70.
  const c = combinedWinProb({ category: wl(25, 17), league: wl(5, 0), last20: wl(14, 6) });
  const pOther = 27.5 / 52;
  const pLg = (5 + 15 * pOther) / 20;
  check("CALEB by hand: p_other, p_league, combined", [r1(c.pOther), r1(c.pLeague), r1(c.combined)], [r1(pOther), r1(pLg), r1(0.9 * pLg + 0.1 * 0.7)]);
  check("N_cat is the category's decided picks", c.nCat, 42);
}
// The 76ers @ Magic outcome at the default 55% gate: GAWD and This Girl BETZ qualify, KIMSPICKS does not.
{
  const at = (cat: [number, number], lg: [number, number], l20: [number, number]) => combinedWinProb({ category: wl(...cat), league: wl(...lg), last20: wl(...l20) }).combined;
  check("76ers @ Magic at 55: GAWD, TGB pass; KIMS fails", [recordGatePasses(at([54, 49], [5, 2], [13, 7]), 55), recordGatePasses(at([160, 128], [12, 8], [10, 10]), 55), recordGatePasses(at([23, 15], [3, 4], [10, 10]), 55)], [true, true, false]);
}

// ---- The formula's edges -------------------------------------------------------
check("no league record: p_league = p_other", (() => { const c = combinedWinProb({ category: wl(12, 8), league: null, last20: null }); return c.pLeague === c.pOther; })(), true);
check("league record 0-0: p_league = p_other", (() => { const c = combinedWinProb({ category: wl(12, 8), league: wl(0, 0), last20: null }); return c.pLeague === c.pOther; })(), true);

// ---- Each pick counted once: a record scores the same in this league or elsewhere ---------------
// The middle level is all-time minus the league. Shrinking toward all-time (which holds the league
// picks) counted them twice: 3-0 in-league was 70.4% that way, 61.5% elsewhere (K 10).
const RECS: [string, number, number][] = [["3-0", 3, 0], ["1-0", 1, 0], ["18-4", 18, 4], ["60-30", 60, 30], ["19-15", 19, 15]];
const inLeague = (w: number, l: number) => combinedWinProb({ category: wl(w, l), league: wl(w, l), last20: null }).combined;
const elsewhere = (w: number, l: number) => combinedWinProb({ category: wl(w, l), league: wl(0, 0), last20: null }).combined;
check("identical in-league and elsewhere, every record", RECS.map(([, w, l]) => Math.abs(inLeague(w, l) - elsewhere(w, l)) < 1e-12), [true, true, true, true, true]);
check("18-4 with 10-2 in league: 71.5% at K 15", r1(combinedWinProb({ category: wl(18, 4), league: wl(10, 2), last20: null }).combined), 71.5);
// ---- Pinned at K 15, F 0.10, no Last 20 (combined = p_league) --------------------------------
const pct = (w: number, l: number) => Math.round(inLeague(w, l) * 1e4) / 100;
check("pinned combined %: 3-0, 1-0, 18-4, 60-30, 19-15", RECS.map(([, w, l]) => pct(w, l)), [58.33, 53.13, 68.92, 64.29, 54.08]);
check("60-30 beats 3-0", inLeague(60, 30) > inLeague(3, 0), true);
check("19-15 beats 1-0 (strictly: K 10 tied them at 6/11 = 24/44)", inLeague(19, 15) > inLeague(1, 0), true);
check("18-4 beats 60-30", inLeague(18, 4) > inLeague(60, 30), true);
{
  const k10 = (w: number, l: number) => combinedWinProb({ category: wl(w, l), league: null, last20: null }, { ...RECORD_SCORE_CONFIG, k: 10 }).combined;
  check("K 10 would tie 1-0 and 19-15 exactly", k10(1, 0) === k10(19, 15), true);
}
check("no Last 20: combined = p_league", (() => { const c = combinedWinProb({ category: wl(12, 8), league: wl(4, 1), last20: null }); return c.combined === c.pLeague; })(), true);
check("0-0 category is the prior, 50%", combinedWinProb({ category: wl(0, 0), league: null, last20: null }).combined, 0.5);
check("F moves only the Last 20 weight", r1(combinedWinProb({ category: wl(10, 10), league: null, last20: wl(20, 0) }, { ...RECORD_SCORE_CONFIG, f: 0.3 }).combined), r1(0.7 * 0.5 + 0.3 * 1));
check("K changes the shrinkage: K = 0 is the raw record", combinedWinProb({ category: wl(3, 1), league: null, last20: null }, { ...RECORD_SCORE_CONFIG, k: 0 }).combined, 0.75);

// ---- The gate --------------------------------------------------------------------
check("gate: exactly on it passes (0.55 at 55)", recordGatePasses(0.55, 55), true);
check("gate: just under fails", recordGatePasses(0.5499, 55), false);
check("gate 0: no gate", recordGatePasses(0.01, 0), true);

// ---- scorePickByRecord on the snapshot's maps ---------------------------------------
const pick = (o: Partial<GeneratorPick> & { pickId: string; capperId: string }): GeneratorPick =>
  ({ leagueName: "NBA", category: "FAV_ML", betType: "MONEYLINE", propMarket: null, odds: -110, oddsSource: "MARKET", ...o }) as GeneratorPick;
const col = (w: number, l: number, p = 0) => ({ wins: w, losses: l, pushes: p, winPct: (w / (w + l)) * 100, count: w + l + p });
function ctxOf(): ScoringContext {
  const leagueRecords: CapperLeagueRecords = {
    records: {
      "gawd|NBA|FAV_ML": { category: "FAV_ML", label: "Favorite ML", overall: col(54, 49, 3), league: col(5, 2) },
      "kims|NBA|DOG_ML": { category: "DOG_ML", label: "Underdog ML", overall: col(23, 15), league: col(3, 4) },
      "none|NBA|FAV_ML": null,
    },
    streaks: {},
    last20: { gawd: col(13, 7), kims: col(10, 10) },
  };
  return { leagueRecords, categoryRecords: {}, propMarketRecords: {}, platformRates: EMPTY_PLATFORM_RATES, minWinPct: 55 };
}
const ctx = ctxOf();
const gawd = scorePickByRecord(pick({ pickId: "g", capperId: "gawd", odds: -108 }), ctx);
const gawdLong = scorePickByRecord(pick({ pickId: "g2", capperId: "gawd", odds: -900 }), ctx);
const kims = scorePickByRecord(pick({ pickId: "k", capperId: "kims", category: "DOG_ML", odds: -108 }), ctx);
check("scored on the record model; pushes out (54-49-3 is N_cat 103)", gawd.status === "SCORED" ? [gawd.model, gawd.decided, Math.round(gawd.rankScore * 100)] : null, ["record model", 103, 58]);
check("odds never move the score (-108 and -900 score the same)", gawd.status === "SCORED" && gawdLong.status === "SCORED" ? gawd.rankScore === gawdLong.rankScore : null, true);
check("passesGate reads the combined %: GAWD passes 55, fails 59; KIMS fails 55", [passesGate(gawd, 55), passesGate(gawd, 59), passesGate(kims, 55)], [true, false, false]);
check("no card: no record", scorePickByRecord(pick({ pickId: "n", capperId: "none" }), ctx).status, "NO_RECORD");
check("no category: no record", scorePickByRecord(pick({ pickId: "c", capperId: "gawd", category: null }), ctx).status, "NO_RECORD");
{
  // A prop with a market key reads its per-market record, as the shown record does.
  const c = ctxOf();
  c.propMarketRecords = { "gawd|NBA|BASKETBALL:POINTS": { key: "BASKETBALL:POINTS", league: col(6, 2), allTime: col(30, 20) } };
  const s = scorePickByRecord(pick({ pickId: "p", capperId: "gawd", betType: "PLAYER_PROP", category: "TD_PROP", propMarket: "POINTS" }), c);
  const want = combinedWinProb({ category: wl(30, 20), league: wl(6, 2), last20: wl(13, 7) }).combined;
  check("a prop: its per-market record (all-time 30-20, league 6-2)", s.status === "SCORED" ? [s.rankScore === want, s.propMarket] : null, [true, "BASKETBALL:POINTS"]);
  check("a prop with no market record: no record (no category fallback)", scorePickByRecord(pick({ pickId: "p2", capperId: "kims", betType: "PLAYER_PROP", category: "TD_PROP", propMarket: "POINTS" }), c).status, "NO_RECORD");
}

// ---- Ranking: combined desc, then larger N_cat, then pick id ---------------------------
{
  const c = ctxOf();
  // Two cappers with the same combined: 10-10 all-time and 20-20 (both 50%, no league, no last 20).
  c.leagueRecords.records["a|NBA|FAV_ML"] = { category: "FAV_ML", label: "", overall: col(10, 10), league: col(0, 0) };
  c.leagueRecords.records["b|NBA|FAV_ML"] = { category: "FAV_ML", label: "", overall: col(20, 20), league: col(0, 0) };
  const a = scorePickByRecord(pick({ pickId: "a1", capperId: "a" }), c);
  const b = scorePickByRecord(pick({ pickId: "b1", capperId: "b" }), c);
  const b2 = scorePickByRecord(pick({ pickId: "a0", capperId: "b" }), c);
  check("ranking: combined first (GAWD over KIMS)", compareScores(gawd, kims) < 0, true);
  check("ranking: a tie on combined goes to the larger N_cat", [a, b].sort(compareScores).map((s) => s.pickId), ["b1", "a1"]);
  check("ranking: then pick id", [b, b2].sort(compareScores).map((s) => s.pickId), ["a0", "b1"]);
}

// ---- The generator gates and ranks on it -------------------------------------------------
{
  // 76ers @ Magic: GAWD / TGB on the 76ers ML, KIMS on the Magic ML, at -108 each.
  const mk = (id: string, capperId: string, team: "PHI" | "ORL"): GeneratorPick =>
    ({
      pickId: id, capperId, capperName: capperId, capperColorTag: null, capperIsFavorite: false,
      category: team === "PHI" ? "FAV_ML" : "DOG_ML", leagueName: "NBA", gameId: "G", gameLabel: "Philadelphia 76ers @ Orlando Magic",
      betDetail: team === "PHI" ? "76ers ML" : "Magic ML", rawBetDetail: team === "PHI" ? "Philadelphia 76ers ML" : "Orlando Magic ML", odds: -108, oddsSource: "MARKET", units: 1, status: "PENDING",
      betType: "MONEYLINE", period: "FULL_GAME", line: null, homeTeam: "Orlando Magic", awayTeam: "Philadelphia 76ers", gameTime: "2099-06-01T23:10:00.000Z",
      teamGroup: team === "PHI" ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-06-01T00:00:00.000Z", propMarket: null,
    }) as GeneratorPick;
  const picks = [mk("gawd-phi", "gawd", "PHI"), mk("tgb-phi", "tgb", "PHI"), mk("kims-orl", "kims", "ORL")];
  const leagueRecords: CapperLeagueRecords = {
    records: {
      "gawd|NBA|FAV_ML": { category: "FAV_ML", label: "", overall: col(54, 49), league: col(5, 2) },
      "tgb|NBA|FAV_ML": { category: "FAV_ML", label: "", overall: col(160, 128), league: col(12, 8) },
      "kims|NBA|DOG_ML": { category: "DOG_ML", label: "", overall: col(23, 15), league: col(3, 4) },
    },
    streaks: {},
    last20: { gawd: col(13, 7), tgb: col(10, 10), kims: col(10, 10) },
  };
  const snap: GeneratorSnapshot = {
    builtAt: "2099-06-01T12:00:00.000Z",
    games: [{ gameId: "G", gameLabel: picks[0].gameLabel, gameTime: picks[0].gameTime, leagueName: "NBA", picks }],
    slipPicks: [],
    targets: [],
    leagueRecords,
    categoryRecords: {},
    propMarketRecords: {},
  };
  const NOW = new Date("2099-06-01T12:00:00.000Z");
  const s: GeneratorSettings = { legCount: 1, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 55 };
  const p = buildGeneratedParlay(snap, s, null, NOW);
  check("76ers @ Magic: the leg is GAWD's 76ers ML (58%), not KIMS's Magic ML (54%)", p.legs.map((l) => l.pick.pickId), ["gawd-phi"]);
  check("its score is the combined win % in points", Math.round(p.legs[0].score ?? 0), 58);
  const o = legSwapOptions(snap, s, p.legs, 0, NOW);
  check("Swap: This Girl BETZ (57%) clears, in Primary (the same bet)", o.PRIMARY.filter((r) => !r.current).map((r) => [r.pick.pickId, Boolean(r.belowGate)]), [["tgb-phi", false]]);
  check("Swap: KIMS (54%) is Contrarian, below your gate, 54% vs 55%", o.CONTRARIAN.map((r) => [r.pick.pickId, r.belowGate ? Math.round(r.belowGate.combinedWinPct) : null, r.belowGate?.gate]), [["kims-orl", 54, 55]]);
  check("the edge model still runs on request (scoreModel EDGE)", buildGeneratedParlay(snap, { ...s, scoreModel: "EDGE" }, null, NOW).legs.length <= 1, true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
