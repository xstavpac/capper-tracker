// Proof for selectCapperRecentPicks - the capper detail page's "Recent picks"
// list, which is scoped to whatever sport the "record by category" section is
// currently showing.
//
// Behaviour (product decision, 2026-09): the two sections never disagree. If
// the category stats read "NCAAF record by category" - whether because the
// user clicked the NCAAF tab OR because NCAAF is the capper's primary sport
// and the section defaulted to it - then "Recent picks" reads "recent NCAAF
// picks" and shows only NCAAF picks. All-sport only for a capper with no
// category section at all (no category-eligible picks in any sport).
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
// of older MLB picks, then a run of recent NCAAF picks. His primary sport
// (most category-eligible picks) is NCAAF, so selectedCategorySport defaults
// to "NCAAF" on a plain page load.
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

// --- Default page load: category section defaults to the capper's primary
// sport (NCAAF), so "Recent picks" is NCAAF too - the two MLB picks are gone
// WITHOUT any tab click. This is the reported scenario, fixed. ---
{
  const r = selectCapperRecentPicks(ascending, "NCAAF");
  check("default load (primary=NCAAF): scopedSport is NCAAF", r.scopedSport, "NCAAF");
  check("default load: only NCAAF picks, newest-first, no MLB", r.picks.map((p) => p.id), [
    "ncaaf-akron-wake",
    "ncaaf-colorado-gt",
    "ncaaf-idaho-utah",
    "ncaaf-sjsu-emu",
    "ncaaf-toledo-msu",
    "ncaaf-miami-stanford",
    "ncaaf-clemson-lsu",
    "ncaaf-ucla",
  ]);
  check("default load: every returned pick is NCAAF", r.picks.every((p) => p.sport.name === "NCAAF"), true);
}

// --- MLB tab selected (selectedCategorySport resolves to "MLB"): both the
// category stats and this list switch to MLB together ---
{
  const r = selectCapperRecentPicks(ascending, "MLB");
  check("MLB tab: scopedSport is MLB", r.scopedSport, "MLB");
  check("MLB tab: only the two MLB picks, newest-first", r.picks.map((p) => p.id), [
    "mlb-brewers-cubs",
    "mlb-yankees-angels",
  ]);
}

// --- The limit applies to the SCOPED set, not the raw list ---
// 15 NCAAF picks then 12 MLB picks: scoping to MLB must return the 10 most
// recent MLB picks, not "MLB picks that survive the top 10 overall" (zero).
{
  const many: FakePick[] = [
    ...Array.from({ length: 15 }, (_, i) => pick(`ncaaf-${i}`, "NCAAF")),
    ...Array.from({ length: 12 }, (_, i) => pick(`mlb-${i}`, "MLB")),
  ];
  const r = selectCapperRecentPicks(many, "MLB");
  check("scoped limit: 10 most recent MLB picks (not starved by newer NCAAF picks)", r.picks.map((p) => p.id), [
    "mlb-11", "mlb-10", "mlb-9", "mlb-8", "mlb-7", "mlb-6", "mlb-5", "mlb-4", "mlb-3", "mlb-2",
  ]);
  check("scoped limit: exactly 10", r.picks.length, 10);
}

// --- No category section at all (capper has no category-eligible picks in
// any sport -> selectedCategorySport is undefined): falls back to all-sport,
// since there is no sport for it to be consistent with ---
{
  const r = selectCapperRecentPicks(ascending, undefined);
  check("no category section: scopedSport is null", r.scopedSport, null);
  check("no category section: all sports, newest-first", r.picks.map((p) => p.id), [
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

// --- Empty capper ---
{
  const r = selectCapperRecentPicks([] as FakePick[], "NCAAF");
  check("no picks: empty result, scopedSport still echoes the selected sport", { picks: r.picks.length, scoped: r.scopedSport }, { picks: 0, scoped: "NCAAF" });
}

// --- Custom limit passes through ---
{
  const r = selectCapperRecentPicks(ascending, "NCAAF", 3);
  check("custom limit: 3 most recent NCAAF", r.picks.map((p) => p.id), ["ncaaf-akron-wake", "ncaaf-colorado-gt", "ncaaf-idaho-utah"]);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
