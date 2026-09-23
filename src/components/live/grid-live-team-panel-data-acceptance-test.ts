// Correctness proof for buildGridLiveGamePanelData
// (grid-live-team-panel-data.ts) - the data behind Grid Live's
// combined game-detail panel. Covers: both teams' picks are split out
// correctly from one game's full pick list, OTHER-group (totals/non-team)
// picks never leak into either team's section but DO surface in their own
// "other" section (mirroring GamePicksExpander's AWAY/HOME/OTHER grouping),
// and a team with zero picks still resolves a valid label/color for the
// empty state.
// Run with:
//   npx tsx src/components/live/grid-live-team-panel-data-acceptance-test.ts
//
// Exits non-zero if any assertion fails.
import { buildGridLiveGamePanelData, orderTeamSections } from "./grid-live-team-panel-data";
import type { ExpanderPick } from "./game-picks-expander";
import { OTHER_GROUP_LABEL } from "@/lib/pick-team-group";

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
    gameId: "game-1",
    gameLabel: "Cubs @ Pirates",
    betDetail: "ML",
    odds: -110,
    units: 1,
    status: "PENDING",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    rawBetDetail: "ML",
    line: null,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    gameTime: "2026-09-01T23:00:00.000Z",
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
  const data = buildGridLiveGamePanelData(game, "baseball_mlb", "MLB", picks);
  expect("home section returns only the home team's picks", data.home.picks.map((p) => p.pickId), ["home-1"]);
  expect("away section returns only the away team's picks", data.away.picks.map((p) => p.pickId), ["away-1"]);
  expect("home section's teamLabel is the home team's short name", data.home.teamLabel, "Pirates");
  expect("away section's teamLabel is the away team's short name", data.away.teamLabel, "Cubs");
  expect("OTHER-group picks appear in neither team section", [...data.home.picks, ...data.away.picks].some((p) => p.pickId === "other-1"), false);
  expect("OTHER-group picks appear in the other section", data.other.picks.map((p) => p.pickId), ["other-1"]);
  expect("other section's teamLabel is the shared 'Totals & other markets' label", data.other.teamLabel, OTHER_GROUP_LABEL);
  expect("other section's teamColor is always neutral (null), not a team color", data.other.teamColor, null);
}

{
  const data = buildGridLiveGamePanelData(game, "baseball_mlb", "MLB", [otherPick]);
  expect("a team with zero picks resolves an empty picks list, not an error", data.home.picks, []);
  expect("a team with zero picks still resolves its label", data.home.teamLabel, "Pirates");
}

{
  const data = buildGridLiveGamePanelData(game, "baseball_mlb", "MLB", [homePick, awayPick]);
  expect("the other section resolves an empty picks list when there are no OTHER-group picks", data.other.picks, []);
}

{
  const zeroPicks = { teamLabel: "Cubs", teamColor: null, picks: [] as ExpanderPick[] };
  const onePick = { teamLabel: "Pirates", teamColor: null, picks: [homePick] };
  const twoPicks = { teamLabel: "Cubs", teamColor: null, picks: [awayPick, homePick] };

  expect(
    "away=0/home=1+ puts home first",
    orderTeamSections(zeroPicks, onePick).map((s) => s.teamLabel),
    ["Pirates", "Cubs"]
  );
  expect(
    "home=0/away=1+ keeps away/home order",
    orderTeamSections(onePick, zeroPicks).map((s) => s.teamLabel),
    ["Pirates", "Cubs"]
  );
  expect(
    "both 0 picks keeps away/home order",
    orderTeamSections(zeroPicks, { ...zeroPicks, teamLabel: "Pirates" }).map((s) => s.teamLabel),
    ["Cubs", "Pirates"]
  );
  expect(
    "both have picks keeps away/home order",
    orderTeamSections(twoPicks, onePick).map((s) => s.teamLabel),
    ["Cubs", "Pirates"]
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll passed.");
