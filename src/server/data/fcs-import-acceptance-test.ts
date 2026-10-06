// Proof that a college game on the NCAAF score feed is importable whatever its
// division - run with:
//   npx tsx src/server/data/fcs-import-acceptance-test.ts
//
// The bug (production skip log, 2026-10): "Montana State -14.5" and "Idaho vs.
// Montana State over 57.5" -> GAME_UNMATCHED, "Rhode Island Moneyline" ->
// RECOVERY_UNRESOLVED. The score feed was FBS-only (ESPN groups=80), so an
// FCS-vs-FCS game was in no feed at all, and most FCS schools were in no team
// list. The fix: the feed carries FCS too (getNcaafLiveScores), and the parser
// recognizes any team on that feed from the feed's own team data
// (lib/feed-teams.ts).
//
// Covers, against a fixture game set shaped like the feed:
//   A. the three reported lines parse and match their game
//   B. the exact school wins over a near-match, in both directions
//   C. listed (FBS) schools and other sports are unchanged
//   D. a game with no odds-feed line keeps the posted price
//   E. a matched FCS pick grades from the feed's final score
//   F. the feed merge itself
//
// No test framework in this repo (see odds-preseason-merge-acceptance-test.ts).
import { prisma } from "@/lib/prisma";
import { parseCatalog, TEAM_NICKNAME_CANONICAL, type ParsedPick } from "@/lib/parse-catalog";
import { buildFeedTeams, findFeedTeamHits } from "@/lib/feed-teams";
import { resolveScheduleGameFromFeeds, mergeScoreGamesById, findMarketPrice, findFavoredSide } from "./odds";
import type { ScoreGame } from "./odds";
import { matchGameResult, resolveOutcome } from "./grading";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// Saturday-morning ET import; every fixture game kicks off that afternoon.
const NOW = new Date("2026-10-10T10:00:00-04:00");
const KICKOFF = "2026-10-10T19:00:00Z";

// [away, awayLocation, awayShort, home, homeLocation, homeShort]
const FIXTURE: [string, string, string, string, string, string][] = [
  ["Idaho Vandals", "Idaho", "Idaho", "Montana State Bobcats", "Montana State", "Montana St"],
  ["Brown Bears", "Brown", "Brown", "Rhode Island Rams", "Rhode Island", "Rhode Island"],
  ["Montana Grizzlies", "Montana", "Montana", "Idaho State Bengals", "Idaho State", "Idaho St"],
  ["Illinois State Redbirds", "Illinois State", "Illinois St", "Southern Illinois Salukis", "Southern Illinois", "S Illinois"],
  ["Northern Arizona Lumberjacks", "Northern Arizona", "N Arizona", "Sacramento State Hornets", "Sacramento State", "Sacramento St"],
  ["Auburn Tigers", "Auburn", "Auburn", "Georgia Bulldogs", "Georgia", "Georgia"],
  ["Georgia State Panthers", "Georgia State", "Georgia St", "Troy Trojans", "Troy", "Troy"],
  ["Penn State Nittany Lions", "Penn State", "Penn State", "Ohio State Buckeyes", "Ohio State", "Ohio State"],
  ["Purdue Boilermakers", "Purdue", "Purdue", "Illinois Fighting Illini", "Illinois", "Illinois"],
];
const games: ScoreGame[] = FIXTURE.map(([away, awayLocation, awayShortName, home, homeLocation, homeShortName], i) => ({
  id: "fx-" + i,
  homeTeam: home,
  awayTeam: away,
  status: "preview",
  scores: null,
  commenceTime: KICKOFF,
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
  homeLocation,
  awayLocation,
  homeShortName,
  awayShortName,
}));
const feedTeams = buildFeedTeams("NCAAF", games);

function parseOne(line: string, teams = feedTeams): ParsedPick | null {
  return parseCatalog("Sharp Sam\n" + line, [], undefined, teams).picks[0] ?? null;
}

// Mirrors bulk-picks.ts's resolveGameAndOdds -> lookupGame: nicknames through
// TEAM_NICKNAME_CANONICAL, then the same endsWith predicates
// resolveGameForNickname / resolveGameForTeams use, over the score feed.
function matchGame(pick: ParsedPick, feed = games): string | null {
  const n = [...new Set(pick.teamNicknames.map((x) => TEAM_NICKNAME_CANONICAL[x] ?? x))];
  if (n.length === 0) return null;
  const ends = (team: string, nick: string) => team.toLowerCase().endsWith(nick);
  const teamMatches =
    n.length >= 2
      ? (g: { homeTeam: string; awayTeam: string }) =>
          (ends(g.homeTeam, n[0]) && ends(g.awayTeam, n[1])) || (ends(g.homeTeam, n[1]) && ends(g.awayTeam, n[0]))
      : (g: { homeTeam: string; awayTeam: string }) => ends(g.homeTeam, n[0]) || ends(g.awayTeam, n[0]);
  const game = resolveScheduleGameFromFeeds(feed, [], teamMatches, NOW).game;
  return game ? game.awayTeam + " @ " + game.homeTeam : null;
}

function importLine(line: string, teams = feedTeams) {
  const pick = parseOne(line, teams);
  if (!pick) return "unresolved";
  if (pick.ambiguous) return "ambiguous:" + pick.ambiguousKey;
  return `${pick.sportName} ${pick.betType} -> ${matchGame(pick) ?? "NO GAME"}`;
}

async function main() {
  console.log("\n--- A. the three reported lines ---");
  check("Montana State -14.5", importLine("Montana State -14.5"), "NCAAF SPREAD -> Idaho Vandals @ Montana State Bobcats");
  check(
    "Idaho vs. Montana State over 57.5",
    importLine("Idaho vs. Montana State over 57.5"),
    "NCAAF TOTAL -> Idaho Vandals @ Montana State Bobcats"
  );
  check(
    "  ...pinned by both teams",
    parseOne("Idaho vs. Montana State over 57.5")?.teamNicknames,
    ["idaho vandals", "montana state"]
  );
  check("Rhode Island Moneyline", importLine("Rhode Island Moneyline"), "NCAAF MONEYLINE -> Brown Bears @ Rhode Island Rams");
  check("short form: Montana St -14.5", importLine("Montana St -14.5"), "NCAAF SPREAD -> Idaho Vandals @ Montana State Bobcats");
  check("full name: Rhode Island Rams ML", importLine("Rhode Island Rams ML"), "NCAAF MONEYLINE -> Brown Bears @ Rhode Island Rams");
  check("unique mascot: Lumberjacks +7", importLine("Lumberjacks +7"), "NCAAF SPREAD -> Northern Arizona Lumberjacks @ Sacramento State Hornets");
  check(
    "inline after a saved capper",
    parseCatalog("Sharp Sam Rhode Island Moneyline", ["Sharp Sam"], undefined, feedTeams).picks.map((p) => [p.capperName, p.sportName, p.teamNicknames]),
    [["Sharp Sam", "NCAAF", ["rhode island rams"]]]
  );

  console.log("\n--- B. exact school, never the near-match ---");
  check("Montana -3 is the Grizzlies", parseOne("Montana -3")?.teamNicknames, ["montana grizzlies"]);
  check("Montana -3 game", importLine("Montana -3"), "NCAAF SPREAD -> Montana Grizzlies @ Idaho State Bengals");
  check("Montana State -14.5 is the Bobcats", parseOne("Montana State -14.5")?.teamNicknames, ["montana state"]);
  check("Idaho -3 is the Vandals", parseOne("Idaho -3")?.teamNicknames, ["idaho vandals"]);
  check("Idaho State +7 is the Bengals", parseOne("Idaho State +7")?.teamNicknames, ["idaho state bengals"]);
  check("Idaho St +7 is the Bengals", parseOne("Idaho St +7")?.teamNicknames, ["idaho state bengals"]);
  check("Illinois State -3 is the Redbirds", parseOne("Illinois State -3")?.teamNicknames, ["illinois state redbirds"]);
  check("Illinois -3 stays the Illini", parseOne("Illinois -3")?.teamNicknames, ["illinois"]);
  check("Sacramento State -3 is not the Kings prompt", importLine("Sacramento State -3"), "NCAAF SPREAD -> Northern Arizona Lumberjacks @ Sacramento State Hornets");
  check("Montana Grizzlies -3 is not the NBA Grizzlies", parseOne("Montana Grizzlies -3")?.sportName, "NCAAF");

  // The longer school is NOT on the feed: the shorter one must not claim it.
  const withoutIdahoState = buildFeedTeams("NCAAF", games.filter((g) => g.homeTeam !== "Idaho State Bengals"));
  check("Idaho State +7 with only Idaho on the feed: no pick", importLine("Idaho State +7", withoutIdahoState), "unresolved");
  check("Montana Tech -3: no pick", importLine("Montana Tech -3"), "unresolved");
  check("Southern Illinois -3 is the Salukis, not the Illini", parseOne("Southern Illinois -3")?.teamNicknames, ["southern illinois salukis"]);
  const withoutSalukis = buildFeedTeams("NCAAF", games.filter((g) => g.homeTeam !== "Southern Illinois Salukis"));
  check(
    "Southern Illinois -3 off the feed never resolves a game",
    (() => {
      const p = parseOne("Southern Illinois -3", withoutSalukis);
      return p ? matchGame(p) : null;
    })(),
    null
  );

  console.log("\n--- C. listed schools and other sports unchanged ---");
  for (const line of ["Georgia -7", "Georgia State +10", "Ohio State -14", "Georgia Bulldogs ML", "Rams -3", "Yankees ML", "Detroit -6.5", "Bears -3", "Texas ML"]) {
    const strip = (r: ReturnType<typeof parseCatalog>) => JSON.stringify([r.picks, r.unresolved]);
    check(
      `same with and without the feed: ${line}`,
      strip(parseCatalog("Sharp Sam\n" + line, [], undefined, feedTeams)),
      strip(parseCatalog("Sharp Sam\n" + line))
    );
  }
  check("Georgia -7 game", importLine("Georgia -7"), "NCAAF SPREAD -> Auburn Tigers @ Georgia Bulldogs");
  check("Georgia State +10 game", importLine("Georgia State +10"), "NCAAF SPREAD -> Georgia State Panthers @ Troy Trojans");
  check("Ohio State -14 game", importLine("Ohio State -14"), "NCAAF SPREAD -> Penn State Nittany Lions @ Ohio State Buckeyes");
  check("Rams -3 stays NFL", parseOne("Rams -3")?.sportName, "NFL");
  check("explicit code wins: NFL Brown -3", parseOne("NFL Brown -3")?.sportName, "NFL");
  check(
    "a player prop is never a school: A.J. Brown over 60.5 receiving yards",
    parseOne("A.J. Brown over 60.5 receiving yards")?.sportName === "NCAAF",
    false
  );
  check(
    "a header after a blank line is still a capper name",
    parseCatalog("Sharp Sam\nYankees ML\n\nBrown Picks\nRed Sox ML", [], undefined, feedTeams).picks.map((p) => p.capperName),
    ["Sharp Sam", "Brown Picks"]
  );
  check("no feed data: FCS line is left for review, as before", parseCatalog("Sharp Sam\nRhode Island Moneyline").unresolved, ["Rhode Island Moneyline"]);
  check("a team with no school split is skipped", buildFeedTeams("NCAAF", [{ homeTeam: "Idaho Vandals", awayTeam: "Brown Bears" }]), []);
  check("a shared mascot is not a key", findFeedTeamHits("Tigers -3", buildFeedTeams("NCAAF", [
    { homeTeam: "Auburn Tigers", awayTeam: "LSU Tigers", homeLocation: "Auburn", awayLocation: "LSU" },
  ])), []);

  console.log("\n--- D. no odds-feed line: the posted price stands ---");
  // The odds snapshot has the FBS game only. resolveGameAndOdds overwrites a
  // pick's odds only when findMarketPrice returns a number, and reads
  // mlFavoredSide from findFavoredSide - both must come back null, not throw.
  const snapshot = [
    {
      id: "odds-1",
      homeTeam: "Georgia Bulldogs",
      awayTeam: "Auburn Tigers",
      commenceTime: KICKOFF,
      bookmakers: [{ key: "bk", title: "bk", markets: [{ key: "spreads", outcomes: [{ name: "Georgia Bulldogs", price: -112, point: -7 }] }] }],
    },
  ];
  const original = prisma.oddsSnapshot.findUnique;
  (prisma.oddsSnapshot as { findUnique: unknown }).findUnique = async () => ({ data: snapshot });
  try {
    const fcsGame = { homeTeam: "Rhode Island Rams", awayTeam: "Brown Bears", commenceTime: KICKOFF };
    check("FCS game: no market price", await findMarketPrice("americanfootball_ncaaf", fcsGame, "MONEYLINE", "home"), null);
    check("FCS game: no favored side", await findFavoredSide("americanfootball_ncaaf", fcsGame), null);
    const posted = parseOne("Rhode Island -3.5 (-105)");
    check("posted price is on the parsed pick", [posted?.odds, posted?.hasExplicitOdds], [-105, true]);
    check("no posted price: the -110 default", [parseOne("Rhode Island -3.5")?.odds, parseOne("Rhode Island -3.5")?.hasExplicitOdds], [-110, false]);
  } finally {
    (prisma.oddsSnapshot as { findUnique: unknown }).findUnique = original;
  }

  console.log("\n--- E. a matched FCS pick grades from the feed's final ---");
  // persistFinalScores writes one GameResult per final on the score feed, with
  // the feed's own team names - the same names import stored on the pick.
  const results = [
    { gameDate: new Date(KICKOFF), homeTeam: "Rhode Island Rams", awayTeam: "Brown Bears", homeScore: 31, awayScore: 17, gameNumber: null },
    { gameDate: new Date(KICKOFF), homeTeam: "Montana State Bobcats", awayTeam: "Idaho Vandals", homeScore: 38, awayScore: 20, gameNumber: null },
  ];
  const grade = (pick: { betType: string; betDetail: string; line: number | null; homeTeam: string; awayTeam: string; pickedSide: "HOME" | "AWAY" | null }) => {
    const m = matchGameResult(results, { ...pick, gameTime: new Date(KICKOFF) });
    if (!m) return "NO RESULT";
    return resolveOutcome({ ...pick, period: "FULL_GAME" }, m.game as unknown as Parameters<typeof resolveOutcome>[1]);
  };
  check(
    "Rhode Island Moneyline",
    grade({ betType: "MONEYLINE", betDetail: "Rhode Island Moneyline", line: null, homeTeam: "Rhode Island Rams", awayTeam: "Brown Bears", pickedSide: "HOME" }),
    "WIN"
  );
  check(
    "Montana State -14.5 (won by 18)",
    grade({ betType: "SPREAD", betDetail: "Montana State -14.5", line: -14.5, homeTeam: "Montana State Bobcats", awayTeam: "Idaho Vandals", pickedSide: "HOME" }),
    "WIN"
  );
  check(
    "Idaho vs. Montana State over 57.5 (58 points)",
    grade({ betType: "TOTAL", betDetail: "Idaho vs. Montana State over 57.5", line: 57.5, homeTeam: "Montana State Bobcats", awayTeam: "Idaho Vandals", pickedSide: null }),
    "WIN"
  );

  console.log("\n--- F. feed merge ---");
  const fbs = [games[5], games[6]];
  const fcs = [games[0], { ...games[5] }, games[1]];
  check("an FBS-vs-FCS game in both groups appears once", mergeScoreGamesById(fbs, fcs).map((g) => g.id), ["fx-5", "fx-6", "fx-0", "fx-1"]);

  console.log("\n--- G. posted days ahead: the week-ahead FCS schedule ---");
  // Tuesday import, Saturday game: outside the yesterday..tomorrow score feed,
  // and an FCS game has no odds-feed entry to fall back to.
  const TUESDAY = new Date("2026-10-06T10:00:00-04:00");
  const urHome = (g: { homeTeam: string; awayTeam: string }) => g.homeTeam.toLowerCase().endsWith("rhode island rams");
  check("no schedule: unmatched", resolveScheduleGameFromFeeds([], [], urHome, TUESDAY).game, null);
  check("matched from the schedule", resolveScheduleGameFromFeeds([], [], urHome, TUESDAY, null, [games[1]]).game?.id, "fx-1");
  check(
    "beyond the 7-day window: unmatched",
    resolveScheduleGameFromFeeds([], [], urHome, new Date("2026-09-28T10:00:00-04:00"), null, [games[1]]).game,
    null
  );
  check(
    "a score-feed game on the day still wins",
    resolveScheduleGameFromFeeds([{ ...games[1], id: "live" }], [], urHome, NOW, null, [games[1]]).game?.id,
    "live"
  );
  const ugaOdds = { ...snapshot[0], sportKey: "americanfootball_ncaaf", sportTitle: "NCAAF" } as unknown as Parameters<typeof resolveScheduleGameFromFeeds>[1][number];
  check(
    "a game the odds feed also lists is not doubled",
    resolveScheduleGameFromFeeds([], [ugaOdds], (g) => g.homeTeam === "Georgia Bulldogs", TUESDAY, null, [games[5]]).game?.id,
    "odds-1"
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  await prisma.$disconnect().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main();
