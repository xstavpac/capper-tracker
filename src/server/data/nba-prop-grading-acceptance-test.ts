// NBA player-prop grading against SAVED real ESPN box scores - no network, no DB.
// Run with:  npx tsx src/server/data/nba-prop-grading-acceptance-test.ts
//
// Fixtures (ESPN basketball/nba summary, header + boxscore.players only):
//   nba-boxscore-401898402-okc-atl-players.json  OKC 110 @ ATL 113 (2026-10-12, final). Every
//                                                listed player played; 22 rostered players are
//                                                not listed at all.
//   nba-boxscore-401898398-dnp-players.json      PHI 106 @ BOS 144 (2026-10-11, final), captured
//                                                2026-10-14: 15 players listed with didNotPlay
//                                                ("DID NOT DRESS", "COACH'S DECISION", injuries).
//   nba-league-roster-2026-10-13.json            the league roster (625 players, 30 teams).
//
//   PART A - extraction: columns by key, threes from the 3PT column, DNP rows.
//   PART B - every supported market: WIN / LOSS / PUSH.
//   PART C - double-double, yes and no.
//   PART D - did-not-play: push only on a single roster id; everything else pending.
//   PART E - what stays pending: unsupported markets, no line, not final, ambiguity.
//   PART F - resolvePlayerProp sends an NBA pick here, POINTS / ASSISTS included.
import fs from "node:fs";
import path from "node:path";
import { extractNbaBoxScore, type NbaBoxScore } from "@/server/data/nba-boxscore";
import { gradeNbaPlayerProp, isDoubleDouble, type NbaPropPick } from "@/server/data/nba-prop-grading";
import { resolvePlayerProp } from "@/server/data/grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"));
const okcRaw = fx("nba-boxscore-401898402-okc-atl-players.json");
const dnpRaw = fx("nba-boxscore-401898398-dnp-players.json");
const okcBox = extractNbaBoxScore(okcRaw)!;
const dnpBox = extractNbaBoxScore(dnpRaw)!;
const ROSTER: RosterPlayer[] = fx("nba-league-roster-2026-10-13.json");

const OKC_GAME = { homeTeam: "Atlanta Hawks", awayTeam: "Oklahoma City Thunder" };
const DNP_GAME = { homeTeam: "Boston Celtics", awayTeam: "Philadelphia 76ers" };

function pick(betDetail: string, game = OKC_GAME, extra: Partial<NbaPropPick> = {}): NbaPropPick {
  return { playerName: null, propMarket: null, betDetail, ...game, ...extra };
}
let rosterReads = 0;
const grade = (p: NbaPropPick, box: NbaBoxScore = okcBox, roster: RosterPlayer[] = ROSTER) =>
  gradeNbaPlayerProp(p, "test", {
    fetchBox: async () => box,
    getRoster: async () => {
      rosterReads++;
      return roster;
    },
  });
const W = { outcome: "WIN" };
const L = { outcome: "LOSS" };
const P = { outcome: "PUSH" };

async function main() {
  console.log("########## PART A: extraction ##########");
  {
    check("OKC box: final + complete, teams", [okcBox.isFinal, okcBox.isComplete, okcBox.homeTeam, okcBox.awayTeam], [true, true, "Atlanta Hawks", "Oklahoma City Thunder"]);
    check("OKC box: 21 listed players, none DNP", [okcBox.players.length, okcBox.players.filter((r) => r.didNotPlay).length], [21, 0]);
    const stirtz = okcBox.players.find((r) => r.playerName === "Bennett Stirtz")!;
    // ESPN row: MIN 38, PTS 26, FG 9-16, 3PT 6-9, FT 2-3, REB 4, AST 5, TO 5, STL 0, BLK 0.
    check("Stirtz: every stat read by key, threes from '6-9'", [stirtz.points, stirtz.rebounds, stirtz.assists, stirtz.turnovers, stirtz.steals, stirtz.blocks, stirtz.threesMade], [26, 4, 5, 5, 0, 0, 6]);
    check("the athlete id is ESPN's (= the roster id)", [stirtz.espnPlayerId, ROSTER.find((r) => r.playerName === "Bennett Stirtz")?.externalPlayerId], ["5241364", "5241364"]);
    check("DNP box: final + complete", [dnpBox.isFinal, dnpBox.isComplete], [true, true]);
    const dnp = dnpBox.players.filter((r) => r.didNotPlay);
    check("DNP box: 15 rows flagged did-not-play, all zeros", [dnp.length, dnp.every((r) => r.points + r.rebounds + r.assists + r.threesMade === 0)], [15, true]);
    check("DNP box: LeBron James is one of them", dnp.some((r) => r.playerName === "LeBron James" && r.espnPlayerId === "1966"), true);
    check("a malformed response yields null", extractNbaBoxScore({ boxscore: {} }), null);
    const noThrees = JSON.parse(JSON.stringify(okcRaw));
    for (const t of noThrees.boxscore.players) for (const g of t.statistics) g.keys = g.keys.map((k: string) => (k.startsWith("threePoint") ? "x" : k));
    check("a missing column fails closed (null), never a wrong column", extractNbaBoxScore(noThrees), null);
    const live = JSON.parse(JSON.stringify(okcRaw));
    live.header.competitions[0].status.type.completed = false;
    check("an in-progress game: not final, not complete", [extractNbaBoxScore(live)!.isFinal, extractNbaBoxScore(live)!.isComplete], [false, false]);
  }

  console.log("\n########## PART B: every supported market ##########");
  {
    // Bennett Stirtz (OKC): 26 PTS, 6 3PM.
    check("POINTS over 25.5 (26) -> WIN", await grade(pick("Bennett Stirtz Over 25.5 Points")), W);
    check("POINTS over 26.5 (26) -> LOSS", await grade(pick("Bennett Stirtz Over 26.5 Points")), L);
    check("POINTS over 26 (26) -> PUSH", await grade(pick("Bennett Stirtz Over 26 Points")), P);
    check("POINTS under 26.5 (26) -> WIN", await grade(pick("Bennett Stirtz u26.5 pts")), W);
    check("POINTS N+: 26+ points (= over 25.5) -> WIN", await grade(pick("Bennett Stirtz 26+ points")), W);
    check("POINTS N+: 27+ points (= over 26.5) -> LOSS", await grade(pick("Bennett Stirtz 27+ points")), L);
    // Aday Mara (OKC): 10 REB, 4 BLK.
    check("REBOUNDS over 9.5 (10) -> WIN", await grade(pick("Aday Mara o9.5 reb")), W);
    check("REBOUNDS under 9.5 (10) -> LOSS", await grade(pick("Aday Mara under 9.5 rebounds")), L);
    check("REBOUNDS over 10 (10) -> PUSH", await grade(pick("Aday Mara over 10 rebounds")), P);
    // Josh Dix (OKC): 7 AST, 2 STL.
    check("ASSISTS over 6.5 (7) -> WIN", await grade(pick("Josh Dix Over 6.5 Assists")), W);
    check("ASSISTS over 7.5 (7) -> LOSS", await grade(pick("Josh Dix Over 7.5 Assists")), L);
    check("ASSISTS over 7 (7) -> PUSH", await grade(pick("Josh Dix Over 7 Assists")), P);
    // Stirtz: 6 threes (3PT 6-9).
    check("THREES_MADE over 5.5 (6) -> WIN", await grade(pick("Bennett Stirtz o5.5 3PM")), W);
    check("THREES_MADE over 6.5 (6) -> LOSS", await grade(pick("Bennett Stirtz over 6.5 threes")), L);
    check("THREES_MADE over 6 (6) -> PUSH", await grade(pick("Bennett Stirtz over 6 threes")), P);
    check("THREES_MADE N+: 6+ threes -> WIN", await grade(pick("Bennett Stirtz 6+ threes")), W);
    check("THREES_MADE N+: 7+ threes -> LOSS", await grade(pick("Bennett Stirtz 7+ threes")), L);
    // Jock Landale (ATL): 3 STL.
    check("STEALS over 2.5 (3) -> WIN", await grade(pick("Jock Landale over 2.5 steals")), W);
    check("STEALS over 3.5 (3) -> LOSS", await grade(pick("Jock Landale over 3.5 steals")), L);
    check("STEALS over 3 (3) -> PUSH", await grade(pick("Jock Landale over 3 stl")), P);
    // Mara: 4 BLK.
    check("BLOCKS over 3.5 (4) -> WIN", await grade(pick("Aday Mara over 3.5 blocks")), W);
    check("BLOCKS under 3.5 (4) -> LOSS", await grade(pick("Aday Mara u3.5 blk")), L);
    check("BLOCKS over 4 (4) -> PUSH", await grade(pick("Aday Mara over 4 blocks")), P);
    // Brooks Barnhizer (OKC): 20 PTS + 8 REB + 2 AST = 30.
    check("PRA over 29.5 (30) -> WIN", await grade(pick("Brooks Barnhizer PRA o29.5")), W);
    check("PRA over 30.5 (30) -> LOSS", await grade(pick("Brooks Barnhizer Over 30.5 Pts+Reb+Ast")), L);
    check("PRA over 30 (30) -> PUSH", await grade(pick("Brooks Barnhizer over 30 PRA")), P);
    // Mara: 17 PTS + 10 REB = 27.
    check("P+R over 26.5 (27) -> WIN", await grade(pick("Aday Mara over 26.5 P+R")), W);
    check("P+R under 26.5 (27) -> LOSS", await grade(pick("Aday Mara under 26.5 points + rebounds")), L);
    check("P+R over 27 (27) -> PUSH", await grade(pick("Aday Mara over 27 P+R")), P);
    // Dix: 16 PTS + 7 AST = 23.
    check("P+A over 22.5 (23) -> WIN", await grade(pick("Josh Dix over 22.5 P+A")), W);
    check("P+A over 23.5 (23) -> LOSS", await grade(pick("Josh Dix over 23.5 pts+ast")), L);
    check("P+A over 23 (23) -> PUSH", await grade(pick("Josh Dix over 23 P+A")), P);
    // Nickeil Alexander-Walker (ATL): 6 REB + 5 AST = 11.
    check("R+A over 10.5 (11) -> WIN", await grade(pick("Nickeil Alexander-Walker over 10.5 R+A")), W);
    check("R+A over 11.5 (11) -> LOSS", await grade(pick("Nickeil Alexander-Walker over 11.5 reb+ast")), L);
    check("R+A over 11 (11) -> PUSH", await grade(pick("Nickeil Alexander-Walker over 11 R+A")), P);
    // The stored market and player (set on every imported pick, bulk-picks.ts) win over the text.
    check("a stored propMarket is trusted (REBOUNDS on terse text)", await grade(pick("Aday Mara o9.5", OKC_GAME, { playerName: "Aday Mara", propMarket: "REBOUNDS" })), W);
    // A stored playerName is used, with the game's own team nicknames stripped.
    check("stored playerName with a team word ('Thunder Aday Mara')", await grade(pick("Thunder Aday Mara over 9.5 rebounds", OKC_GAME, { playerName: "Thunder Aday Mara", propMarket: "REBOUNDS" })), W);
    check("bare surname that names one player in the box -> graded", await grade(pick("Stirtz over 25.5 points")), W);
  }

  console.log("\n########## PART C: double-double ##########");
  {
    const row = (n: string) => okcBox.players.find((r) => r.playerName === n)!;
    check("Mara 17 PTS / 10 REB is a double-double", isDoubleDouble(row("Aday Mara")), true);
    check("Oweh 11 PTS / 10 REB is a double-double", isDoubleDouble(row("Otega Oweh")), true);
    check("Newell 7 PTS / 10 REB is not", isDoubleDouble(row("Asa Newell")), false);
    check("Stirtz 26 PTS / 4 REB / 5 AST is not", isDoubleDouble(row("Bennett Stirtz")), false);
    check("steals and blocks count: 10 PTS + 10 BLK", isDoubleDouble({ ...row("Asa Newell"), points: 10, rebounds: 0, blocks: 10 }), true);
    check("DD yes, had one (Mara) -> WIN", await grade(pick("Aday Mara double-double")), W);
    check("DD yes, had one, 'DD' shorthand (Oweh) -> WIN", await grade(pick("Otega Oweh DD +150")), W);
    check("DD yes, didn't (Newell, 10 REB / 7 PTS) -> LOSS", await grade(pick("Asa Newell double double")), L);
    check("DD no, had one (Mara) -> LOSS", await grade(pick("Aday Mara no double-double")), L);
    check("DD no, didn't (Newell) -> WIN", await grade(pick("Asa Newell no double double")), W);
  }

  console.log("\n########## PART D: did-not-play ##########");
  {
    rosterReads = 0;
    // Listed as DID NOT DRESS, and the roster has exactly one LeBron James (id 1966, the same id).
    check("listed DNP, roster resolves to exactly that id -> PUSH", await grade(pick("LeBron James over 24.5 points", DNP_GAME), dnpBox), P);
    check("listed DNP, same rule for a yes/no market -> PUSH", await grade(pick("Joel Embiid double-double", DNP_GAME), dnpBox), P);
    // "Carter" is one row in this box (Devin Carter, DNP - ILLNESS) but two roster players
    // (Devin Carter BOS, Jevon Carter ORL): the box alone can't prove which one the pick meant.
    check(
      "listed DNP, roster name is ambiguous -> PENDING with reason",
      await grade(pick("Carter over 2.5 assists", DNP_GAME), dnpBox),
      { outcome: null, reason: '"Carter" matches Devin Carter, who did not play, but the NBA roster can\'t confirm that\'s the only player this name could be - needs manual grading' }
    );
    check(
      "listed DNP, roster read fails -> PENDING with reason (never a push)",
      await gradeNbaPlayerProp(pick("LeBron James over 24.5 points", DNP_GAME), "t", { fetchBox: async () => dnpBox, getRoster: async () => Promise.reject(new Error("db down")) }),
      { outcome: null, reason: '"LeBron James" matches LeBron James, who did not play, but the NBA roster can\'t confirm that\'s the only player this name could be - needs manual grading' }
    );
    // Not listed at all: Chet Holmgren is on OKC's roster, one id league-wide, absent from a complete box.
    check("not listed, one roster id on a team in this game, complete box -> PUSH", await grade(pick("Chet Holmgren over 1.5 blocks")), P);
    check("not listed, but the box is incomplete -> PENDING", await grade(pick("Chet Holmgren over 1.5 blocks"), { ...okcBox, isComplete: false }), {
      outcome: null,
      reason: 'couldn\'t find "Chet Holmgren" in the box score',
    });
    check("not listed, one roster id on a team NOT in this game -> PENDING", await grade(pick("Nikola Jokic over 11.5 rebounds")), {
      outcome: null,
      reason: 'couldn\'t find "Nikola Jokic" in the box score',
    });
    // "Williams" is 13 roster players, none of them listed here.
    check("not listed, ambiguous roster name -> PENDING", await grade(pick("Williams over 10.5 points")), { outcome: null, reason: 'couldn\'t find "Williams" in the box score' });
    check("not on any roster -> PENDING", await grade(pick("Zed Nobody over 10.5 points")), { outcome: null, reason: 'couldn\'t find "Zed Nobody" in the box score' });
    // A different spelling than the box score's, recovered by roster id.
    const spelled: RosterPlayer[] = ROSTER.map((r) => (r.playerName === "Aday Mara" ? { ...r, playerName: "Adayyy Maraaa Q", lastName: "Maraaa" } : r));
    check("a roster-only spelling grades on the box row with the same id", await grade(pick("Adayyy Maraaa Q over 9.5 rebounds"), okcBox, spelled), W);
    // A player listed WITH stats never reads the roster.
    rosterReads = 0;
    await grade(pick("Aday Mara over 9.5 rebounds"));
    check("a box-score hit for a player who played does not read the roster", rosterReads, 0);
  }

  console.log("\n########## PART E: what stays pending ##########");
  {
    check("turnovers: recognized, not graded", await grade(pick("Bennett Stirtz over 4.5 turnovers")), {
      outcome: null,
      reason: "this NBA prop market isn't one this app grades automatically yet - needs manual grading",
    });
    check("triple-double: recognized, not graded", await grade(pick("Aday Mara triple-double")), {
      outcome: null,
      reason: "this bet is a triple-double prop, which this app doesn't grade automatically yet - needs manual grading",
    });
    check("not an NBA prop at all", await grade(pick("Josh Allen Over 275.5 Passing Yards")), { outcome: null, reason: "this bet text isn't a recognized NBA prop market" });
    check("a line market with no line", await grade(pick("Aday Mara rebounds", OKC_GAME, { playerName: "Aday Mara", propMarket: "REBOUNDS" })), {
      outcome: null,
      reason: "couldn't find an Over/Under line in this bet text",
    });
    check("no box score", await gradeNbaPlayerProp(pick("Aday Mara over 9.5 rebounds"), "t", { fetchBox: async () => null }), {
      outcome: null,
      reason: "the box score isn't available yet for this game",
    });
    check("box score not final", await grade(pick("Aday Mara over 9.5 rebounds"), { ...okcBox, isFinal: false, isComplete: false }), {
      outcome: null,
      reason: "the box score isn't final yet for this game",
    });
    const twoMaras: NbaBoxScore = { ...okcBox, players: [...okcBox.players, { ...okcBox.players.find((r) => r.playerName === "Aday Mara")!, espnPlayerId: "999", playerName: "Kofi Mara" }] };
    check("a surname two players in the box share -> PENDING", await grade(pick("Mara over 9.5 rebounds"), twoMaras), {
      outcome: null,
      reason: '"Mara" matches more than one player in the box score',
    });
  }

  console.log("\n########## PART F: resolvePlayerProp dispatch ##########");
  {
    // fetch stubbed to serve the saved summary, so this is the real dispatcher end to end.
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify(okcRaw), { status: 200 });
    }) as typeof fetch;
    try {
      const nba = (betDetail: string, propMarket: NbaPropPick["propMarket"]) => ({ playerName: null, propMarket, betDetail, ...OKC_GAME }) as Parameters<typeof resolvePlayerProp>[0];
      check("NBA REBOUNDS -> graded", await resolvePlayerProp(nba("Aday Mara Over 9.5 Rebounds", "REBOUNDS"), "401898402", "NBA"), W);
      // POINTS / ASSISTS are hockey values too. The NHL grader would read hockey's summary (and caps
      // assists at 2.5-sized lines); an NBA pick must never get there.
      check("NBA POINTS -> graded by the NBA grader", await resolvePlayerProp(nba("Bennett Stirtz Over 25.5 Points", "POINTS"), "401898402", "NBA"), W);
      check("NBA ASSISTS with a hockey-sized line -> still the NBA grader", await resolvePlayerProp(nba("Bennett Stirtz Over 2.5 Assists", "ASSISTS"), "401898402", "NBA"), W);
      check("NBA DOUBLE_DOUBLE -> graded", await resolvePlayerProp(nba("Aday Mara Double-Double", "DOUBLE_DOUBLE"), "401898402", "NBA"), W);
      check("every fetch was ESPN's basketball summary for the event", asked.every((u) => u.endsWith("/basketball/nba/summary?event=401898402")) && asked.length === 4, true);
    } finally {
      globalThis.fetch = realFetch;
    }
    const nflOnly = await resolvePlayerProp({ playerName: null, propMarket: null, betDetail: "Aday Mara over 9.5 rebounds", ...OKC_GAME }, "1", "WNBA");
    check("WNBA (no grader of its own) keeps the NFL-only reason", nflOnly, { outcome: null, reason: "player-prop grading is NFL-only; this WNBA pick needs manual grading" });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
