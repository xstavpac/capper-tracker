// Proof for selectCapperRecentPicks - the capper detail page's "Recent picks"
// list, which now follows the "record by category" section's sport tab.
//
// Behaviour (product decision, 2026-09): with a category sport tab explicitly
// selected, "Recent picks" scopes to that sport so it matches the scoped
// stats above it; with no tab selected it stays all-sport (the category
// section renders a default sport, but the two are decoupled until the user
// actually picks a lens).
//
// Pure: takes plain pick-shaped objects. Run with:
//   npx tsx src/server/data/capper-recent-picks-acceptance-test.ts
import { selectCapperRecentPicks } from "@/server/data/stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

type FakePick = { id: string; sport: { name: string } };
const pick = (id: string, sport: string): FakePick => ({ id, sport: { name: sport } });

// getPicksForCapper returns picks gameTime-ascending, so index 0 is the
// OLDEST. The exact reported scenario for "Dorm Room Degenerates": a couple
// of older MLB picks, then a run of recent NCAAF picks.
const ascending: FakePick[] = [
  pick("mlb-yankees-angels", "MLB"),
  pick("mlb-brewers-cubs", "MLB"),
  pick("ncaaf-ucla", "NCAAF"),
  pick("ncaaf-clemson-lsu", "NCAAF"),
  pick("ncaaf-miami-stanford", "NCAAF"),
  pick("ncaaf-toledo-msu", "NCAAF"),
  pick("ncaaf-sjsu-emu", "NCAAF"),
  pick("ncaaf-idaho-utah", "NCAAF"),
  pick("ncaaf-colorado-gt", "NCAAF"),
  pick("ncaaf-akron-wake", "NCAAF"),
];
const TABS = ["NCAAF", "MLB"];

// --- No tab selected: all-sport, newest first, unchanged from before ---
{
  const r = selectCapperRecentPicks(ascending, undefined, TABS);
  check("no tab: scopedSport is null", r.scopedSport, null);
  check("no tab: all sports, newest-first (the reported mix - NCAAF on top, MLB trailing)", r.picks.map((p) => p.id), [
    "ncaaf-akron-wake",
    "ncaaf-colorado-gt",
    "ncaaf-idaho-utah",
    "ncaaf-sjsu-emu",
    "ncaaf-toledo-msu",
    "ncaaf-miami-stanford",
    "ncaaf-clemson-lsu",
    "ncaaf-ucla",
    "mlb-brewers-cubs",
    "mlb-yankees-angels",
  ]);
}

// --- NCAAF tab selected: scopes to NCAAF, the two MLB picks drop out ---
{
  const r = selectCapperRecentPicks(ascending, "NCAAF", TABS);
  check("NCAAF tab: scopedSport is NCAAF", r.scopedSport, "NCAAF");
  check("NCAAF tab: only NCAAF picks, newest-first, no MLB", r.picks.map((p) => p.id), [
    "ncaaf-akron-wake",
    "ncaaf-colorado-gt",
    "ncaaf-idaho-utah",
    "ncaaf-sjsu-emu",
    "ncaaf-toledo-msu",
    "ncaaf-miami-stanford",
    "ncaaf-clemson-lsu",
    "ncaaf-ucla",
  ]);
  check("NCAAF tab: every returned pick is NCAAF", r.picks.every((p) => p.sport.name === "NCAAF"), true);
}

// --- MLB tab selected: scopes to MLB ---
{
  const r = selectCapperRecentPicks(ascending, "MLB", TABS);
  check("MLB tab: only the two MLB picks, newest-first", r.picks.map((p) => p.id), [
    "mlb-brewers-cubs",
    "mlb-yankees-angels",
  ]);
}

// --- The limit applies to the SCOPED set, not the raw list ---
// 12 MLB picks interleaved after 15 NCAAF picks: scoping to MLB must return
// the 10 most recent MLB picks, not "whatever MLB picks survive in the top 10
// overall" (which would be zero here). This is the concrete improvement over
// the old unfiltered slice.
{
  const many: FakePick[] = [
    ...Array.from({ length: 15 }, (_, i) => pick(`ncaaf-${i}`, "NCAAF")),
    ...Array.from({ length: 12 }, (_, i) => pick(`mlb-${i}`, "MLB")),
  ];
  const r = selectCapperRecentPicks(many, "MLB", TABS);
  check("scoped limit: 10 most recent MLB picks (not starved by newer NCAAF picks)", r.picks.map((p) => p.id), [
    "mlb-11", "mlb-10", "mlb-9", "mlb-8", "mlb-7", "mlb-6", "mlb-5", "mlb-4", "mlb-3", "mlb-2",
  ]);
  check("scoped limit: exactly 10", r.picks.length, 10);
}

// --- Guard: a categorySport param that is NOT one of the visible tabs
// (stale/hand-edited URL, or a sport the capper has no category-eligible
// picks in) falls back to all-sport rather than hiding everything ---
{
  const r = selectCapperRecentPicks(ascending, "NHL", TABS);
  check("unknown/invalid categorySport: falls back to all-sport", r.scopedSport, null);
  check("unknown/invalid categorySport: returns all picks", r.picks.length, 10);
}
{
  const r = selectCapperRecentPicks(ascending, "", TABS);
  check("empty-string categorySport: treated as no selection", r.scopedSport, null);
}

// --- Empty capper ---
{
  const r = selectCapperRecentPicks([] as FakePick[], "NCAAF", TABS);
  check("no picks: empty result, scopedSport still resolves from a valid tab", { picks: r.picks.length, scoped: r.scopedSport }, { picks: 0, scoped: "NCAAF" });
}

// --- Custom limit passes through ---
{
  const r = selectCapperRecentPicks(ascending, undefined, TABS, 3);
  check("custom limit: 3 most recent", r.picks.map((p) => p.id), ["ncaaf-akron-wake", "ncaaf-colorado-gt", "ncaaf-idaho-utah"]);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
