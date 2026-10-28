// Proof for Send to FanDuel's player props beyond the NFL: the NBA and NHL
// market keys, the league-aware text read, the stored subject / stat, and the
// player-name resolver. Pure: no DB, no network.
//
// The market keys and the outcome shapes are what FanDuel returned live on
// 2026-10-27 (__fixtures__/fanduel-event-nba-player-props-2026-10-27.json:
// Trail Blazers @ Lakers, all ten NBA keys; ...nhl-player-props...: Sabres @
// Sharks - shots on goal, saves and anytime goal; the NHL points / assists keys
// and the NFL attempts / completions / interceptions keys had nothing posted,
// so they are NOT mapped and the test pins that).
// Run with:
//   npx tsx src/lib/parlay/fanduel-prop-mapping-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import { parseAnyPlayerProp } from "@/lib/bet-line";
import { buildFanDuelLink, fanDuelLegTarget, type FanDuelDeps, type FanDuelEvent, type FanDuelLegInput, type FanDuelMarket } from "@/lib/parlay/fanduel-link";
import { nameWords, resolveFanDuelPlayer } from "@/lib/parlay/fanduel-player-match";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"));
const nba = fixture("fanduel-event-nba-player-props-2026-10-27.json");
const nhl = fixture("fanduel-event-nhl-player-props-2026-10-27.json");

const NOW = new Date("2026-10-27T20:00:00Z");
const base: FanDuelLegInput = {
  pickId: "p",
  sportKey: "basketball_nba",
  leagueName: "NBA",
  betType: "PLAYER_PROP",
  period: "FULL_GAME",
  betDetail: null,
  line: null,
  homeTeam: nba.home_team,
  awayTeam: nba.away_team,
  gameTime: nba.commence_time,
  odds: -110,
  onBoard: true,
};
const nbaLeg = (over: Partial<FanDuelLegInput>): FanDuelLegInput => ({ ...base, ...over });
const nhlLeg = (over: Partial<FanDuelLegInput>): FanDuelLegInput => ({
  ...base,
  sportKey: "icehockey_nhl",
  leagueName: "NHL",
  homeTeam: nhl.home_team,
  awayTeam: nhl.away_team,
  gameTime: nhl.commence_time,
  ...over,
});

const targetOf = (leg: FanDuelLegInput) => {
  const t = fanDuelLegTarget(leg);
  return t.ok ? [t.target.marketKey, t.target.player, t.target.point, "name" in t.target.outcome ? t.target.outcome.name : null] : ["unsupported", t.reason];
};

async function send(legs: FanDuelLegInput[], fixtureEvent: typeof nba, sportKey: string) {
  const event: FanDuelEvent = { id: fixtureEvent.id, sportKey, homeTeam: fixtureEvent.home_team, awayTeam: fixtureEvent.away_team, commenceTime: fixtureEvent.commence_time };
  const markets: FanDuelMarket[] = fixtureEvent.bookmakers[0].markets;
  const deps: FanDuelDeps = { now: NOW, getEvents: async () => [event], getEventMarkets: async (_s, _e, keys) => markets.filter((m) => keys.includes(m.key)) };
  const built = await buildFanDuelLink(legs, deps);
  return built.legs.map((l) => [l.pickId, l.status, l.reason, l.sentLine ? l.sentLine.fanDuel : null]);
}

async function main() {
  // ---- 1. The text read needs the league ----
  check("'Austin Reaves over 21.5 points' read with no league: nothing (hockey caps points at 3.5)", parseAnyPlayerProp("Austin Reaves over 21.5 points"), null);
  check("...read as an NBA pick: POINTS", parseAnyPlayerProp("Austin Reaves over 21.5 points", "NBA"), { playerName: "Austin Reaves", propMarket: "POINTS" });
  check("'Sabonis over 11.5 rebounds' with no league: nothing", parseAnyPlayerProp("Sabonis over 11.5 rebounds"), null);
  check("...as an NBA pick: REBOUNDS", parseAnyPlayerProp("Sabonis over 11.5 rebounds", "NBA"), { playerName: "Sabonis", propMarket: "REBOUNDS" });

  // ---- 2. The market key per stat, from the pick's text ----
  const nbaText: [string, string][] = [
    ["Austin Reaves over 21.5 points", "player_points"],
    ["Domantas Sabonis over 11.5 rebounds", "player_rebounds"],
    ["Ja Morant over 6.5 assists", "player_assists"],
    ["Luka Doncic over 3.5 threes", "player_threes"],
    ["Toumani Camara over 1.5 steals", "player_steals"],
    ["Donovan Clingan over 1.5 blocks", "player_blocks"],
    ["Luka Doncic over 45.5 PRA", "player_points_rebounds_assists"],
    ["Luka Doncic over 38.5 points + rebounds", "player_points_rebounds"],
    ["Luka Doncic over 36.5 points + assists", "player_points_assists"],
    ["Luka Doncic over 15.5 rebounds + assists", "player_rebounds_assists"],
  ];
  for (const [text, key] of nbaText) check("NBA '" + text + "' -> " + key, targetOf(nbaLeg({ betDetail: text }))[0], key);
  check("NBA target: name, player, line, side", targetOf(nbaLeg({ betDetail: "Austin Reaves under 21.5 points" })), ["player_points", "Austin Reaves", 21.5, "Under"]);
  check("an NBA double-double has no key", targetOf(nbaLeg({ betDetail: "Nikola Jokic double double" }))[0], "unsupported");
  check("NHL shots on goal -> player_shots_on_goal", targetOf(nhlLeg({ betDetail: "Tage Thompson over 3.5 shots on goal" }))[0], "player_shots_on_goal");
  check("NHL saves -> player_total_saves", targetOf(nhlLeg({ betDetail: "Yaroslav Askarov over 25.5 saves" }))[0], "player_total_saves");
  check("NHL points: not mapped (no live FanDuel response carried it)", targetOf(nhlLeg({ betDetail: "Tage Thompson over 1.5 points" })), ["unsupported", "This player prop market can't be sent yet."]);
  check("NHL assists: not mapped", targetOf(nhlLeg({ betDetail: "Tage Thompson over 0.5 assists" }))[0], "unsupported");
  const nfl = (betDetail: string) => targetOf({ ...base, sportKey: "americanfootball_nfl", leagueName: "NFL", betDetail });
  check("NFL passing yards still maps", nfl("Josh Allen over 244.5 passing yards")[0], "player_pass_yds");
  check("NFL rush + receive yards still maps", nfl("Josh Jacobs over 77.5 rush + receive yards")[0], "player_rush_reception_yds");
  for (const [text, label] of [
    ["Josh Allen over 33.5 pass attempts", "pass attempts"],
    ["Josh Allen over 21.5 completions", "pass completions"],
    ["Josh Allen over 0.5 interceptions", "interceptions"],
    ["Josh Jacobs over 17.5 carries", "rushing attempts"],
  ]) {
    check("NFL " + label + ": not mapped (no live FanDuel response carried it)", nfl(text), ["unsupported", "This player prop market can't be sent yet."]);
  }

  // ---- 3. The stored subject and stat win over the text ----
  check(
    "stored playerName + propMarket are used, the text is only read for the side and line",
    targetOf(nbaLeg({ betDetail: "Reaves over 23.5 points", playerName: "Austin Reaves", propMarket: "POINTS" })),
    ["player_points", "Austin Reaves", 23.5, "Over"]
  );
  check(
    "a stored stat the text doesn't name still decides the market",
    targetOf(nbaLeg({ betDetail: "Austin Reaves over 3.5", playerName: "Austin Reaves", propMarket: "REBOUNDS" }))[0],
    "player_rebounds"
  );
  check(
    "stored POINTS is the NHL's or the NBA's by the leg's league",
    [targetOf(nhlLeg({ betDetail: "x over 1.5 points", playerName: "Tage Thompson", propMarket: "POINTS" }))[0], targetOf(nbaLeg({ betDetail: "x over 21.5 points", playerName: "Austin Reaves", propMarket: "POINTS" }))[0]],
    ["unsupported", "player_points"]
  );
  check(
    "a saved line that disagrees with the text is not a bet to guess",
    targetOf(nbaLeg({ betDetail: "Austin Reaves over 21.5 points", line: 23.5 })),
    ["unsupported", "This prop's saved line and its text disagree."]
  );
  check("a saved line that agrees is fine", targetOf(nbaLeg({ betDetail: "Austin Reaves over 21.5 points", line: 21.5 }))[0], "player_points");

  // ---- 4. The player-name resolver ----
  const names = ["Domantas Sabonis", "Nikola Jokić", "Shai Gilgeous-Alexander", "Karl-Anthony Towns", "Jaren Jackson Jr.", "De'Aaron Fox", "Ziaire Williams", "Robert Williams III", "Amon-Ra St. Brown", "Luka Doncic", "Kelly Oubre Jr."];
  const found = (typed: string, sportKey = "basketball_nba") => resolveFanDuelPlayer(typed, sportKey, names);
  const nameOf = (typed: string, sportKey?: string) => {
    const m = found(typed, sportKey);
    return m.status === "found" ? m.name : m.status;
  };
  check("the full name", nameOf("Domantas Sabonis"), "Domantas Sabonis");
  check("an unaccented name finds the accented one", nameOf("Nikola Jokic"), "Nikola Jokić");
  check("an accented name finds the plain one", resolveFanDuelPlayer("Luka Dončić", "basketball_nba", names), { status: "found", name: "Luka Doncic" });
  check("case and spacing", nameOf("  domantas   SABONIS "), "Domantas Sabonis");
  check("a unique surname (the 'Sabonis' pick)", nameOf("Sabonis"), "Domantas Sabonis");
  check("a surname that two players share is ambiguous, neither is chosen", found("Williams"), { status: "ambiguous", names: ["Ziaire Williams", "Robert Williams III"] });
  check("...but the full name of one of them is not", nameOf("Ziaire Williams"), "Ziaire Williams");
  check("a first name alone is nobody", nameOf("Domantas"), "none");
  check("a name that isn't there", nameOf("Anthony Edwards"), "none");
  check("a hyphenated name typed with a space", nameOf("Shai Gilgeous Alexander"), "Shai Gilgeous-Alexander");
  check("a surname that is a hyphenated name's second half", nameOf("Alexander"), "Shai Gilgeous-Alexander");
  check("a hyphenated first name", nameOf("Karl Anthony Towns"), "Karl-Anthony Towns");
  check("Jr. on FanDuel's name only", nameOf("Jaren Jackson"), "Jaren Jackson Jr.");
  check("Jr. on the pick's name only", nameOf("Robert Williams"), "Robert Williams III");
  check("Jr. typed, FanDuel's has it too", nameOf("Kelly Oubre Jr."), "Kelly Oubre Jr.");
  check("Jr. on the surname alone", nameOf("Jackson Jr."), "Jaren Jackson Jr.");
  check("a curly apostrophe", nameOf("De’Aaron Fox"), "De'Aaron Fox");
  check("no apostrophe", nameOf("DeAaron Fox"), "De'Aaron Fox");
  check("a multi-word surname", nameOf("St. Brown", "americanfootball_nfl"), "Amon-Ra St. Brown");
  check("an alias resolves to the full name (SGA)", nameOf("SGA"), "Shai Gilgeous-Alexander");
  check("an alias resolves to the full name (KAT)", nameOf("KAT"), "Karl-Anthony Towns");
  check("an alias is the league's own: NBA's SGA means nothing in hockey", nameOf("SGA", "icehockey_nhl"), "none");
  check("a nickname that is a first name (Luka)", nameOf("Luka"), "Luka Doncic");
  check("the words used for matching", [nameWords("Jaren Jackson Jr."), nameWords("De’Aaron Fox"), nameWords("Nikola Jokić")], [["jaren", "jackson"], ["deaaron", "fox"], ["nikola", "jokic"]]);

  // ---- 5. End to end on tonight's real FanDuel response (Trail Blazers @ Lakers) ----
  const reaves = nba.bookmakers[0].markets.find((m: FanDuelMarket) => m.key === "player_points").outcomes.find((o: { description: string }) => o.description === "Austin Reaves").point;
  check("FanDuel's Reaves points line tonight", reaves, 23.5);
  check("Reaves over 23.5 points: the exact line", await send([nbaLeg({ pickId: "exact", betDetail: "Austin Reaves over 23.5 points" })], nba, "basketball_nba"), [["exact", "matched", null, null]]);
  check(
    "Reaves over 21.5 points (the reported leg): FanDuel's 23.5, 2 away, is within a tenth of the line - sent as adjusted",
    await send([nbaLeg({ pickId: "reported", betDetail: "Austin Reaves over 21.5 points" })], nba, "basketball_nba"),
    [["reported", "adjusted", null, 23.5]]
  );
  check(
    "a last name alone, unique in the event",
    await send([nbaLeg({ pickId: "camara", betDetail: "Camara over 11.5 points" })], nba, "basketball_nba").then((r) => r.map((x) => x.slice(0, 2))),
    [["camara", "matched"]]
  );
  const shared = await send([nbaLeg({ pickId: "williams", betDetail: "Williams over 9.5 points" })], nba, "basketball_nba");
  check("a surname two players on that game share is not sent", [shared[0][1], shared[0][2]], ["ambiguous", 'More than one player on FanDuel fits "Williams": Ziaire Williams, Robert Williams.']);
  const lukaLine = nba.bookmakers[0].markets.find((m: FanDuelMarket) => m.key === "player_points").outcomes.find((o: { description: string }) => o.description === "Luka Doncic").point;
  check(
    "an alias (Luka) finds Luka Doncic's line",
    (await send([nbaLeg({ pickId: "luka", betDetail: "Luka over " + lukaLine + " points" })], nba, "basketball_nba")).map((x) => x.slice(0, 2)),
    [["luka", "matched"]]
  );
  check(
    "the stored subject finds the player whatever the text says",
    (await send([nbaLeg({ pickId: "stored", betDetail: "Reaves over 23.5 points", playerName: "Austin Reaves", propMarket: "POINTS" })], nba, "basketball_nba")).map((x) => x.slice(0, 2)),
    [["stored", "matched"]]
  );
  check(
    "a rebounds pick on the same game reads its own market (NBA rebounds)",
    (await send([nbaLeg({ pickId: "reb", betDetail: "Toumani Camara over 4.5 rebounds" })], nba, "basketball_nba")).map((x) => x.slice(0, 2)),
    [["reb", "matched"]]
  );
  check(
    "NHL shots on goal, exact line",
    (await send([nhlLeg({ pickId: "sog", betDetail: "Tage Thompson over 3.5 shots on goal" })], nhl, "icehockey_nhl")).map((x) => x.slice(0, 2)),
    [["sog", "matched"]]
  );
  check(
    "NHL saves, exact line",
    (await send([nhlLeg({ pickId: "sv", betDetail: "Yaroslav Askarov over 25.5 saves" })], nhl, "icehockey_nhl")).map((x) => x.slice(0, 2)),
    [["sv", "matched"]]
  );

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASSED");
}

main();
