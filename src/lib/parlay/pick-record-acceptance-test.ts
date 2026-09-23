// Proof for pick-record.ts's label functions - rankBasisLabel and
// swapRecordLabel. Pure: no DB, no React. Run with:
//   npx tsx src/lib/parlay/pick-record-acceptance-test.ts
import { bestAvailableRecord, formatRecord, rankBasisLabel, swapRecordLabel, type RankRecord } from "@/lib/parlay/pick-record";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ============================================================================
// formatRecord - unchanged, sanity check only.
// ============================================================================
check("formatRecord", formatRecord({ wins: 21, losses: 10, winPct: 67.74 }), "68% (21–10)");

// ============================================================================
// rankBasisLabel - the three bestAvailableRecord sources, each labeled with
// the basis that was ACTUALLY used, not a guess. LAST20 never names a market
// (that record is capper-wide, not category-scoped - see
// getCapperLeagueRecords's `last20` field, src/server/data/picks.ts).
// ============================================================================
const OPTS = { leagueName: "MLB", marketNoun: "favorite moneyline" };

check(
  "rankBasisLabel: LEAGUE source names the league and market",
  rankBasisLabel({ wins: 21, losses: 10, winPct: 67.74, n: 31, source: "LEAGUE" }, OPTS),
  "68% (21–10) · MLB favorite moneyline"
);
check(
  "rankBasisLabel: OVERALL source names 'all leagues' and the market",
  rankBasisLabel({ wins: 44, losses: 31, winPct: 58.67, n: 75, source: "OVERALL" }, OPTS),
  "59% (44–31) · all leagues favorite moneyline"
);
check(
  "rankBasisLabel: LAST20 source names neither league nor market - it's capper-wide",
  rankBasisLabel({ wins: 11, losses: 9, winPct: 55, n: 20, source: "LAST20" }, OPTS),
  "55% (11–9) · last 20, all markets"
);
// Different market/league options must not leak into the LAST20 label - it's
// the one basis that's never scoped to either.
check(
  "rankBasisLabel: LAST20 label is identical regardless of the pick's own league/market",
  rankBasisLabel({ wins: 11, losses: 9, winPct: 55, n: 20, source: "LAST20" }, { leagueName: "NBA", marketNoun: "under" }),
  "55% (11–9) · last 20, all markets"
);

// ============================================================================
// rankBasisLabel end-to-end against bestAvailableRecord, so the label always
// matches the source that actually won the fallback - not a hardcoded guess.
// ============================================================================
function mkPick(overrides: Partial<ExpanderPick> = {}): ExpanderPick {
  return {
    pickId: "p1",
    capperId: "c1",
    capperName: "Capper",
    capperColorTag: null,
    capperIsFavorite: false,
    category: "FAV_ML",
    leagueName: "MLB",
    gameId: "g1",
    gameLabel: "Away @ Home",
    betDetail: "Home ML",
    odds: -120,
    units: 1,
    status: "PENDING",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    rawBetDetail: "Home ML",
    line: null,
    homeTeam: "Home",
    awayTeam: "Away",
    gameTime: "2026-09-23T23:05:00.000Z",
    teamGroup: "HOME",
    teamLabel: "Home",
    teamColor: null,
    datePosted: "2026-09-23T15:00:00.000Z",
    ...overrides,
  };
}
function records(overrides: Partial<CapperLeagueRecords> = {}): CapperLeagueRecords {
  return { records: {}, streaks: {}, last20: {}, ...overrides };
}

{
  const pick = mkPick();
  const recs = records({
    records: {
      "c1|MLB|FAV_ML": { category: "FAV_ML", label: "Favorite Moneyline", overall: { wins: 5, losses: 5, pushes: 0, winPct: 50, count: 10 }, league: { wins: 21, losses: 10, pushes: 0, winPct: 67.74, count: 31 } },
    },
  });
  const record = bestAvailableRecord(pick, recs) as RankRecord;
  check("end-to-end: LEAGUE record present -> LEAGUE label", rankBasisLabel(record, OPTS), "68% (21–10) · MLB favorite moneyline");
}
{
  const pick = mkPick();
  const recs = records({
    records: {
      "c1|MLB|FAV_ML": { category: "FAV_ML", label: "Favorite Moneyline", overall: { wins: 44, losses: 31, pushes: 0, winPct: 58.67, count: 75 }, league: { wins: 0, losses: 0, pushes: 0, winPct: 0, count: 0 } },
    },
  });
  const record = bestAvailableRecord(pick, recs) as RankRecord;
  check("end-to-end: no league history, OVERALL present -> OVERALL label", rankBasisLabel(record, OPTS), "59% (44–31) · all leagues favorite moneyline");
}
{
  const pick = mkPick();
  const recs = records({ last20: { c1: { wins: 11, losses: 9, pushes: 0, winPct: 55, count: 20 } } });
  const record = bestAvailableRecord(pick, recs) as RankRecord;
  check("end-to-end: no league/overall history, last20 present -> LAST20 label", rankBasisLabel(record, OPTS), "55% (11–9) · last 20, all markets");
}

// ============================================================================
// swapRecordLabel - the Hedge/Contrarian swap record. rankCandidates
// (qualification-ranking.ts) always qualifies and ranks candidates on
// getCapperCategoryRecords (all-leagues, category-scoped) - never
// league-scoped, never a last-20 fallback - so this label has exactly one
// form, always "all leagues <market>".
// ============================================================================
check(
  "swapRecordLabel: always all-leagues, regardless of market",
  swapRecordLabel({ wins: 44, losses: 31, winPct: 58.67 }, "favorite moneyline"),
  "59% (44–31) · all leagues favorite moneyline"
);
check(
  "swapRecordLabel: different market noun still says all leagues",
  swapRecordLabel({ wins: 3, losses: 2, winPct: 60 }, "under"),
  "60% (3–2) · all leagues under"
);

// ============================================================================
// Side-by-side distinguishability: the whole point of this change. A
// league-scoped Parlay A basis and an all-leagues swap basis on the SAME
// underlying record must never render as identical text.
// ============================================================================
{
  const leagueBasis = rankBasisLabel({ wins: 21, losses: 10, winPct: 67.74, n: 31, source: "LEAGUE" }, OPTS);
  const swapBasis = swapRecordLabel({ wins: 21, losses: 10, winPct: 67.74 }, "favorite moneyline");
  check("league-sourced and all-leagues labels differ even for the identical W-L", leagueBasis === swapBasis, false);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
