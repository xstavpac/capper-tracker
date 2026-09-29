// Proof for the /picks ledger's display helpers - run with:
//   npx tsx src/lib/pick-display-acceptance-test.ts
// Display-only: label cleanup, market tags, section split/sort, consensus hint.
import {
  buildPickLabel,
  cleanPickText,
  consensusHints,
  marketTag,
  splitIntoSections,
  pickPhase,
  matchFeedGame,
  type PickPhase,
  capperInitials,
  type LedgerPickInput,
} from "./pick-display";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const T0 = new Date("2026-09-29T23:00:00Z");
function pick(over: Partial<LedgerPickInput>): LedgerPickInput {
  return {
    id: "p",
    capperId: "c1",
    sportName: "MLB",
    homeTeam: "New York Yankees",
    awayTeam: "Boston Red Sox",
    betType: "MONEYLINE",
    betDetail: null,
    line: null,
    period: "FULL_GAME",
    pickedSide: null,
    odds: -110,
    status: "PENDING",
    gameTime: T0,
    ...over,
  };
}

// Label cleanup: no double dash, no odds/units inside the label.
check("double dash + odds", cleanPickText("over 5.5 - -135"), "over 5.5");
check("odds in parens", cleanPickText("Yankees ML (-120)"), "Yankees ML");
check("trailing units", cleanPickText("Lakers -4.5 - 2u"), "Lakers -4.5");
check("@ odds", cleanPickText("under 8.5 @ -110"), "under 8.5");
check("plain text untouched", cleanPickText("Athletics Under"), "Athletics Under");
check("spread line is not mistaken for odds", cleanPickText("Diamondbacks -1.5"), "Diamondbacks -1.5");

// Structured labels.
check(
  "total from text + stored line",
  buildPickLabel(pick({ betType: "TOTAL", betDetail: "over - -135", line: 5.5 })),
  "Over 5.5"
);
check("total, line in text", buildPickLabel(pick({ betType: "TOTAL", betDetail: "Under 8.5 - -110" })), "Under 8.5");
check(
  "spread from side + line",
  buildPickLabel(pick({ betType: "SPREAD", betDetail: "Red Sox +1.5", line: 1.5, pickedSide: "AWAY" })),
  "Boston Red Sox +1.5"
);
check("ml from picked side", buildPickLabel(pick({ betType: "MONEYLINE", betDetail: "Yanks ML", pickedSide: "HOME" })), "New York Yankees");
check("ml fallback to stored text", buildPickLabel(pick({ betType: "MONEYLINE", betDetail: "Yanks ML (-120)" })), "Yanks ML");
check("nrfi", buildPickLabel(pick({ betType: "NRFI", betDetail: "NRFI" })), "No run in the 1st inning");
check("no detail falls back to bet type", buildPickLabel(pick({ betType: "PLAYER_PROP", betDetail: null })), "Player Prop");

// Tags.
check("ml tag", marketTag(pick({})), "ML");
check("mlb spread = run line", marketTag(pick({ betType: "SPREAD" })), "Run line");
check("nhl spread = puck line", marketTag(pick({ betType: "SPREAD", sportName: "NHL" })), "Puck line");
check("nba spread", marketTag(pick({ betType: "SPREAD", sportName: "NBA" })), "Spread");
check("f5 total", marketTag(pick({ betType: "TOTAL", period: "FIRST_HALF" })), "F5 total");
check("f5 ml", marketTag(pick({ period: "FIRST_HALF" })), "F5 ML");
check("nfl 1h total", marketTag(pick({ betType: "TOTAL", period: "FIRST_HALF", sportName: "NFL" })), "1H total");
check("team total", marketTag(pick({ betType: "TEAM_TOTAL" })), "Team total");
check("nrfi tag", marketTag(pick({ betType: "NRFI", betDetail: "YRFI" })), "YRFI");

// Phases: "Pending" means ONLY that the game hasn't started.
const now = new Date("2026-09-29T20:00:00Z");
const hrs = (h: number) => new Date(now.getTime() + h * 3600000);
const ph = (over: Partial<Parameters<typeof pickPhase>[0]>) =>
  pickPhase({ status: "PENDING", gameTime: hrs(2), now, hasFinalResult: false, feedStatus: null, ...over });

check("before game time -> pending", ph({ gameTime: hrs(2) }), "pending");
check("before game time, feed says preview -> pending", ph({ gameTime: hrs(2), feedStatus: "preview" }), "pending");
check("started 1h ago, no feed status -> live (time window fallback)", ph({ gameTime: hrs(-1) }), "live");
check("started 1h ago, feed live -> live", ph({ gameTime: hrs(-1), feedStatus: "live" }), "live");
check("feed live before scheduled time (early start) -> live", ph({ gameTime: hrs(0.1), feedStatus: "live" }), "live");
check("feed live even past the 8h window -> live", ph({ gameTime: hrs(-9), feedStatus: "live" }), "live");
check("started 1h ago, feed says preview (delay) -> pending", ph({ gameTime: hrs(-1), feedStatus: "preview" }), "pending");
check("final result row, ungraded -> grading", ph({ gameTime: hrs(-4), hasFinalResult: true }), "grading");
check("feed final, ungraded, no result row yet -> grading", ph({ gameTime: hrs(-4), feedStatus: "final" }), "grading");
check("final beats the 8h window -> grading", ph({ gameTime: hrs(-30), hasFinalResult: true }), "grading");
check("started 9h ago, no result, no grade -> awaiting", ph({ gameTime: hrs(-9) }), "awaiting");
check("started 9h ago, feed preview -> awaiting", ph({ gameTime: hrs(-9), feedStatus: "preview" }), "awaiting");
check("exactly at the 8h edge is still live", ph({ gameTime: hrs(-8) }), "live");
check("graded win", ph({ status: "WIN", gameTime: hrs(-3), hasFinalResult: true }), "won");
check("graded loss", ph({ status: "LOSS", gameTime: hrs(-3) }), "lost");
check("graded push", ph({ status: "PUSH", gameTime: hrs(-3) }), "push");
check("graded wins even if feed says live", ph({ status: "WIN", feedStatus: "live" }), "won");
check("cancelled", ph({ status: "CANCELLED", gameTime: hrs(-3) }), "cancelled");

// Sections follow phase.
const mk = (id: string, phase: PickPhase, hoursFromNow: number) => ({ id, phase, gameTime: hrs(hoursFromNow) });
const secs = splitIntoSections([
  mk("s1", "won", -5),
  mk("u2", "pending", 4),
  mk("l1", "live", -1),
  mk("g1", "grading", -3),
  mk("a1", "awaiting", -12),
  mk("u1", "pending", 2),
  mk("s2", "lost", -8),
]);
check("section order", secs.map((s) => s.key), ["live", "upcoming", "settled"]);
check("only live phase in Live", secs[0].picks.map((p) => p.id), ["l1"]);
check("only pending in Upcoming, ascending", secs[1].picks.map((p) => p.id), ["u1", "u2"]);
check("settled holds graded + grading + awaiting, descending", secs[2].picks.map((p) => p.id), ["g1", "s1", "s2", "a1"]);
check("empty sections hidden", splitIntoSections([mk("u1", "pending", 2)]).map((s) => s.key), ["upcoming"]);

// Feed matching: exact team names, nearest start time within drift.
const feed = [
  { homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", commenceTime: "2026-09-28T23:00:00Z", tag: "yesterday" },
  { homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", commenceTime: "2026-09-29T23:05:00Z", tag: "today" },
  { homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals", commenceTime: "2026-09-29T23:05:00Z", tag: "other" },
];
const yank = { homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", gameTime: new Date("2026-09-29T23:00:00Z") };
check("feed match picks today's game in a series", matchFeedGame(feed, yank, 6 * 3600000)?.tag, "today");
check("feed match: unknown teams -> null", matchFeedGame(feed, { ...yank, homeTeam: "Nope" }, 6 * 3600000), null);
check("feed match: outside drift -> null", matchFeedGame(feed, { ...yank, gameTime: new Date("2026-10-05T23:00:00Z") }, 6 * 3600000), null);

// Consensus.
const hints = consensusHints([
  pick({ id: "a", capperId: "c1", betType: "TOTAL", betDetail: "over 8.5" }),
  pick({ id: "b", capperId: "c2", betType: "TOTAL", betDetail: "Over 8.5 - -110" }),
  pick({ id: "c", capperId: "c3", betType: "TOTAL", betDetail: "under 8.5" }),
  pick({ id: "d", capperId: "c1", betType: "MONEYLINE", pickedSide: "HOME" }),
  pick({ id: "e", capperId: "c2", betType: "MONEYLINE", pickedSide: "HOME" }),
  pick({ id: "f", capperId: "c3", betType: "MONEYLINE", pickedSide: "AWAY" }),
  pick({ id: "g", capperId: "c1", betType: "TOTAL", betDetail: "over 8.5", gameTime: new Date("2026-09-30T23:00:00Z") }),
]);
check("over consensus", [hints.get("a"), hints.get("b")], ["2 cappers on this over", "2 cappers on this over"]);
check("lone under gets no hint", hints.get("c"), undefined);
check("side consensus", hints.get("d"), "2 cappers on this side");
check("different game excluded", hints.get("g"), undefined);
check("same capper twice is not consensus", consensusHints([pick({ id: "x", betType: "TOTAL", betDetail: "over 8" }), pick({ id: "y", betType: "TOTAL", betDetail: "over 8" })]).size, 0);

check("initials", [capperInitials("Sharp Sam"), capperInitials("Vegas"), capperInitials("")], ["SS", "VE", "?"]);

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");
