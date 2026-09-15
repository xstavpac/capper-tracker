// Correctness proof for buildAdvancedLiveGamePanelData
// (advanced-live-team-panel-data.ts) - the data behind Advanced Live's
// combined game-detail panel. Covers: both teams' picks are split out
// correctly from one game's full pick list, OTHER-group (totals/non-team)
// picks never leak into either team's section, and a team with zero picks
// still resolves a valid label/color for the empty state.
// Run with:
//   npx tsx src/components/live/advanced-live-team-panel-data-acceptance-test.ts
//
// Exits non-zero if any assertion fails.
import { buildAdvancedLiveGamePanelData } from "./advanced-live-team-panel-data";
import type { ExpanderPick } from "./game-picks-expander";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

const game = { homeTeam: "Pittsburgh Pirates", awayTeam: "Chicago Cubs" };

function pick(overrides: Partial<ExpanderPick>): ExpanderPick {
  return {
    pickId: "p1",
    capperId: "c1",
    capperName: "Capper One",
    capperColorTag: null,
    capperIsFavorite: false,
    category: null,
    leagueName: "MLB",
    betDetail: "ML",
    odds: -110,
    units: 1,
    status: "PENDING",
    teamGroup: "OTHER",
    teamLabel: "",
    teamColor: null,
    ...overrides,
  };
}

const homePick = pick({ pickId: "home-1", teamGroup: "HOME", teamLabel: "Pirates" });
const awayPick = pick({ pickId: "away-1", teamGroup: "AWAY", teamLabel: "Cubs" });
const otherPick = pick({ pickId: "other-1", teamGroup: "OTHER" });
const picks = [homePick, awayPick, otherPick];

{
  const data = buildAdvancedLiveGamePanelData(game, "baseball_mlb", "MLB", picks);
  expect("home section returns only the home team's picks", data.home.picks.map((p) => p.pickId), ["home-1"]);
  expect("away section returns only the away team's picks", data.away.picks.map((p) => p.pickId), ["away-1"]);
  expect("home section's teamLabel is the home team's short name", data.home.teamLabel, "Pirates");
  expect("away section's teamLabel is the away team's short name", data.away.teamLabel, "Cubs");
  expect("OTHER-group picks appear in neither section", [...data.home.picks, ...data.away.picks].some((p) => p.pickId === "other-1"), false);
}

{
  const data = buildAdvancedLiveGamePanelData(game, "baseball_mlb", "MLB", [otherPick]);
  expect("a team with zero picks resolves an empty picks list, not an error", data.home.picks, []);
  expect("a team with zero picks still resolves its label", data.home.teamLabel, "Pirates");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll passed.");
