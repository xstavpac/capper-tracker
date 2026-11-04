// Proof for the team-side read behind Send to FanDuel (PR A): a one-team NCAAB spread
// names its side without the opponent, import's stored pickedSide is read first, and a
// pick whose side nothing settles is a question ("Needs clarification"), never "Not
// supported". Also pins classifyPickTeamGroup (the Live board's grouping) as unchanged
// for every sport but NCAAB. Pure: the Odds API is the two functions in FanDuelDeps.
// Run with:
//   npx tsx src/lib/parlay/fanduel-side-resolution-acceptance-test.ts
import { buildFanDuelLink, notSentDisplay, type FanDuelDeps, type FanDuelEvent, type FanDuelLegInput, type FanDuelMarket } from "@/lib/parlay/fanduel-link";
import { classifyPickTeamGroup, type PickTeamGroup } from "@/lib/pick-team-group";
import { derivePickSide } from "@/lib/pick-side";
import { teamGroupAliases, teamPhraseRegex, normalizeForGrouping } from "@/lib/parse-catalog";
import { ncaabSideFromText } from "@/lib/ncaab-pick-side";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NOW = new Date("2026-11-03T15:00:00Z");
const START = "2026-11-03T23:00:00Z";
const link = (m: string, s: string) => `https://sportsbook.fanduel.com/addToBetslip?marketId=${m}&selectionId=${s}`;
const urlHasSelection = (url: string | null, sid: string) => (url ? new URL(url).searchParams.get("selectionId[0]") === sid : false);

// Each game: ESPN's spelling (what the pick row stores) and the Odds API's (what the
// listing and its markets say). Selection ids are unique per team so the test can tell
// WHICH team's outcome was chosen.
type Game = { id: string; espnHome: string; espnAway: string; oddsHome: string; oddsAway: string; homeSid: string; awaySid: string };
const GAMES: Game[] = [
  { id: "g1", espnHome: "Hampton Pirates", espnAway: "Duke Blue Devils", oddsHome: "Hampton Pirates", oddsAway: "Duke Blue Devils", homeSid: "1001", awaySid: "1002" },
  { id: "g2", espnHome: "Western Michigan Broncos", espnAway: "Purdue Fort Wayne Mastodons", oddsHome: "Western Michigan Broncos", oddsAway: "Fort Wayne Mastodons", homeSid: "2001", awaySid: "2002" },
  { id: "g3", espnHome: "Sam Houston Bearkats", espnAway: "Tulane Green Wave", oddsHome: "Sam Houston St Bearkats", oddsAway: "Tulane Green Wave", homeSid: "3001", awaySid: "3002" },
  { id: "g4", espnHome: "Iowa Hawkeyes", espnAway: "South Dakota State Jackrabbits", oddsHome: "Iowa Hawkeyes", oddsAway: "South Dakota St Jackrabbits", homeSid: "4001", awaySid: "4002" },
  // Two schools one word apart.
  { id: "g5", espnHome: "South Dakota State Jackrabbits", espnAway: "South Dakota Coyotes", oddsHome: "South Dakota St Jackrabbits", oddsAway: "South Dakota Coyotes", homeSid: "5001", awaySid: "5002" },
];
const events: FanDuelEvent[] = GAMES.map((g) => ({ id: g.id, sportKey: "basketball_ncaab", homeTeam: g.oddsHome, awayTeam: g.oddsAway, commenceTime: START }));

// The spread market with the home team at `homePoint` (and the away team at the opposite).
function marketsAt(g: Game, homePoint: number): FanDuelMarket[] {
  return [
    {
      key: "spreads",
      sid: null,
      outcomes: [
        { name: g.oddsHome, price: -110, point: homePoint, sid: g.homeSid, link: link("42.61" + g.id.slice(1), g.homeSid) },
        { name: g.oddsAway, price: -110, point: -homePoint, sid: g.awaySid, link: link("42.61" + g.id.slice(1), g.awaySid) },
      ],
    },
    {
      key: "h2h",
      sid: null,
      outcomes: [
        { name: g.oddsHome, price: -150, sid: g.homeSid + "9", link: link("43.61" + g.id.slice(1), g.homeSid + "9") },
        { name: g.oddsAway, price: 130, sid: g.awaySid + "9", link: link("43.61" + g.id.slice(1), g.awaySid + "9") },
      ],
    },
  ];
}
const deps = (homePointByEvent: Record<string, number>): FanDuelDeps => ({
  now: NOW,
  getEvents: async (sportKey) => (sportKey === "basketball_ncaab" ? events : []),
  getEventMarkets: async (_sportKey, eventId) => marketsAt(GAMES.find((g) => g.id === eventId)!, homePointByEvent[eventId] ?? -3.5),
});

function leg(pickId: string, g: Game, betDetail: string, line: number | null, extra: Partial<FanDuelLegInput> = {}): FanDuelLegInput {
  return {
    pickId,
    sportKey: "basketball_ncaab",
    leagueName: "NCAAB",
    betType: "SPREAD",
    period: "FULL_GAME",
    betDetail,
    line,
    homeTeam: g.espnHome,
    awayTeam: g.espnAway,
    gameTime: START,
    odds: -110,
    onBoard: true,
    pickedSide: null,
    ...extra,
  };
}

async function main() {
  // ---- 1. The four picks that failed in production: named side, opponent omitted ----
  // pickedSide null = import recorded none, so the text is all there is. Each pick is
  // the underdog (+N), so its team sits at +N and the opponent at -N.
  const cases: [string, Game, number, "home" | "away"][] = [
    ["Hampton +14.5", GAMES[0], 14.5, "home"],
    ["Purdue Fort Wayne +10.5", GAMES[1], 10.5, "away"],
    ["Sam Houston +27", GAMES[2], 27, "home"],
    ["South Dakota State +10", GAMES[3], 10, "away"],
  ];
  for (const [text, g, line, side] of cases) {
    const homePoint = side === "home" ? line : -line;
    const res = await buildFanDuelLink([leg("p", g, text, line)], deps({ [g.id]: homePoint }));
    const wantSid = side === "home" ? g.homeSid : g.awaySid;
    check(text + " -> matched", [res.legs[0].status, res.legs[0].reason], ["matched", null]);
    check(text + " -> the named team's spread outcome (" + wantSid + "), not the opponent's", urlHasSelection(res.url, wantSid), true);
  }

  // ---- 2. Two schools one word apart: the longer name wins ----
  const sd = GAMES[4];
  check("'south dakota state -4' in SDSU vs South Dakota is State's side", ncaabSideFromText("south dakota state -4", { homeTeam: sd.espnHome, awayTeam: sd.espnAway }), "HOME");
  check("'south dakota st -4' is State's side", ncaabSideFromText("south dakota st -4", { homeTeam: sd.espnHome, awayTeam: sd.espnAway }), "HOME");
  check("'south dakota +4' is the Coyotes' side", ncaabSideFromText("south dakota +4", { homeTeam: sd.espnHome, awayTeam: sd.espnAway }), "AWAY");

  // ---- 3. pickedSide is read before the text ----
  const noName = await buildFanDuelLink([leg("p", GAMES[0], "Spread +14.5", 14.5, { pickedSide: "HOME" })], deps({ g1: 14.5 }));
  check("pickedSide HOME with no team in the text -> matched on the home outcome", [noName.legs[0].status, urlHasSelection(noName.url, "1001")], ["matched", true]);
  const conflict = await buildFanDuelLink([leg("p", GAMES[0], "Duke +14.5", 14.5, { pickedSide: "HOME" })], deps({ g1: 14.5 }));
  check("the recorded side beats a text that names the other team", urlHasSelection(conflict.url, "1001"), true);

  // ---- 4. Undecidable -> a question, never "Not supported" ----
  for (const text of ["Spread +3.5", "Pirates Mastodons +3.5"]) {
    const res = await buildFanDuelLink([leg("p", GAMES[0], text, 3.5)], deps({}));
    const shown = notSentDisplay(res.legs[0]);
    check("'" + text + "' -> needs_clarification", res.legs[0].status, "needs_clarification");
    check(
      "'" + text + "' -> labelled Needs clarification (not Not supported), names both teams",
      [shown.label, shown.reason.startsWith("Needs clarification"), shown.reason.includes("Duke Blue Devils"), shown.reason.includes("Hampton Pirates")],
      ["Needs clarification", true, true, true]
    );
    check("'" + text + "' sends nothing", res.url, null);
  }
  const ml = await buildFanDuelLink([leg("p", GAMES[0], "ML", null, { betType: "MONEYLINE" })], deps({}));
  check("a moneyline with no side -> needs_clarification", ml.legs[0].status, "needs_clarification");
  const odd = await buildFanDuelLink([leg("p", GAMES[0], "Hampton first basket", null, { betType: "FIRST_BASKET" })], deps({}));
  check("an unsupported bet type stays 'unsupported'", odd.legs[0].status, "unsupported");

  // ---- 5. Live board grouping is unchanged for every sport but NCAAB ----
  // The pre-PR function, frozen: text read through teamGroupAliases.
  type P = { betType: string; betDetail: string | null; pickedSide?: "HOME" | "AWAY" | "DRAW" | null };
  function legacy(pick: P, game: { homeTeam: string; awayTeam: string }, sport: string): PickTeamGroup {
    if (pick.betType === "TOTAL" || pick.betType === "TEAM_TOTAL") return "TOTALS";
    if (pick.betType !== "MONEYLINE" && pick.betType !== "SPREAD") return "OTHER";
    if (pick.pickedSide === "HOME") return "HOME";
    if (pick.pickedSide === "AWAY") return "AWAY";
    const text = normalizeForGrouping(pick.betDetail ?? "");
    const mentions = (a: string[]) => a.some((x) => teamPhraseRegex(x).test(text));
    if (mentions(teamGroupAliases(game.awayTeam, sport))) return "AWAY";
    if (mentions(teamGroupAliases(game.homeTeam, sport))) return "HOME";
    return "OTHER";
  }
  const parity: [string, string, string, string, string, "HOME" | "AWAY" | null][] = [
    ["MLB", "Pittsburgh Pirates", "Chicago Cubs", "Pirates ML", "MONEYLINE", null],
    ["MLB", "Pittsburgh Pirates", "Chicago Cubs", "Cubs -1.5", "SPREAD", null],
    ["MLB", "Pittsburgh Pirates", "Chicago Cubs", "Cubs -1.5", "SPREAD", "HOME"],
    ["NBA", "Los Angeles Lakers", "Portland Trail Blazers", "Lakers -4", "SPREAD", null],
    ["NBA", "Los Angeles Lakers", "Portland Trail Blazers", "Blazers +4", "SPREAD", null],
    ["NBA", "Los Angeles Lakers", "Portland Trail Blazers", "Over 220", "TOTAL", null],
    ["NHL", "Chicago Blackhawks", "Los Angeles Kings", "Kings ML", "MONEYLINE", null],
    ["NHL", "Chicago Blackhawks", "Los Angeles Kings", "Unknown ML", "MONEYLINE", null],
    ["NFL", "Los Angeles Rams", "Buffalo Bills", "Bills +3.5", "SPREAD", null],
    ["NFL", "Los Angeles Rams", "Buffalo Bills", "Rams -3.5", "SPREAD", "AWAY"],
    ["NFL", "Los Angeles Rams", "Buffalo Bills", "Josh Allen over 244.5 passing yards", "PLAYER_PROP", null],
    ["NCAAF", "Florida International Panthers", "Liberty Flames", "FIU +7", "SPREAD", null],
    ["NCAAF", "Florida International Panthers", "Liberty Flames", "Liberty -7", "SPREAD", null],
    ["NCAAF", "Sam Houston Bearkats", "Liberty Flames", "Sam Houston State +6", "SPREAD", null],
    ["NCAAF", "Sam Houston Bearkats", "Liberty Flames", "Nobody +6", "SPREAD", null],
  ];
  let same = 0;
  for (const [sport, home, away, text, betType, pickedSide] of parity) {
    const pick: P = { betType, betDetail: text, pickedSide };
    const game = { homeTeam: home, awayTeam: away };
    if (classifyPickTeamGroup(pick, game, sport) === legacy(pick, game, sport)) same++;
    else console.log("  differs:", sport, text);
  }
  check("classifyPickTeamGroup == the pre-PR result for all " + parity.length + " NFL/NBA/NHL/MLB/NCAAF fixtures", same, parity.length);
  // The groups are real answers, not all "OTHER".
  check(
    "the parity fixtures are not vacuous (HOME, AWAY, TOTALS and OTHER all occur)",
    Array.from(new Set(parity.map(([s, h, a, t, b, ps]) => classifyPickTeamGroup({ betType: b, betDetail: t, pickedSide: ps }, { homeTeam: h, awayTeam: a }, s)))).sort(),
    ["AWAY", "HOME", "OTHER", "TOTALS"]
  );

  const hamp = { homeTeam: "Hampton Pirates", awayTeam: "Duke Blue Devils" };
  check("NCAAB: pickedSide beats text", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "Hampton +14.5", pickedSide: "AWAY" }, hamp, "NCAAB"), "AWAY");
  check("NCAAB: text fallback", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "Hampton +14.5" }, hamp, "NCAAB"), "HOME");
  check("NCAAB: a total is still Totals", classifyPickTeamGroup({ betType: "TOTAL", betDetail: "Over 150" }, hamp, "NCAAB"), "TOTALS");
  check("NCAAB: undecidable is OTHER", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "Spread +3.5" }, hamp, "NCAAB"), "OTHER");
  check("derivePickSide reads pickedSide", derivePickSide({ betType: "SPREAD", betDetail: "", pickedSide: "AWAY" }, hamp, "NCAAB"), "AWAY");

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASSED");
}
main();
