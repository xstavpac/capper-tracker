// Proof that a real-time Telegram ingest never matches a game that was already final when the message arrived, and
// that nothing else about matching changed.
//
// The bug (investigated 2026-11-11): resolveScheduleGameFromFeeds' last resort hands back ANY score-feed game for the
// team, a finished one included ("so logging a pick right after its game still works"). The import compares against
// its own run time, and a Telegram message is imported the moment it arrives - so a line posted after its team's
// game ended was attached to that finished game and graded off it:
//   - NazEaster "cbb Bowling Green Falcons ML", ingested 2026-11-10 20:15Z -> Bowling Green v Cleveland State
//     basketball, final 11-10 02:15Z (the night before). Graded WIN off the wrong game.
//   - BET LABS "cbb Illinois +4.5", ingested 2026-11-06 22:27Z -> Illinois v Penn basketball, final 11-06 03:45Z.
//     The line was really that night's Illinois v Nebraska football game (DraftKings Illinois +4.5).
//   - Vinny "Bengals vs Falcons over 51.5", ingested 2026-11-08 17:49Z, 4 minutes after the London game's final.
// 3 of 2,308 real-time ingested picks since 11-02.
//
// The rule (excludeFinal, real-time ingest only): a game the score feed has as final is dropped from EVERY step -
// same-day, upcoming, the odds/schedule fallback (its odds-feed twin too) and the last resort. Nothing left = the
// line is unmatched and logged ("Game already final when the message was posted"), not imported.
//
// Pinned here:
//   1. Bowling Green and Illinois, from the feeds as they were: unmatched with excludeFinal (finishedOnly), and
//      still matched exactly as before without it (manual paste keeps next-day matching).
//   2. Vinny's same-day finished game: unmatched for ingest, matched for a paste.
//   3. a live pick on an in-progress game still matches with excludeFinal.
//   4. a finished game's odds-feed twin is not a way back in; the team's NEXT game still matches.
//   5. review-queue approval: choices are matched at the message's arrival with the rule on, and approving later
//      inserts the stored row without matching again - so an item whose message predates the final still gets its
//      game after the final (structural checks on the source).
//   6. plumbing: Telegram ingest turns the rule on for the import and the review drafts; the manual paste never does.
//
// No DB, no network. Run with:
//   npx tsx src/server/data/ingest-no-finished-game-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveScheduleGameFromFeeds, type OddsGame, type ScoreGame } from "./odds";
import { teamNameEndsWith } from "@/lib/team-name-match";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const score = (id: string, home: string, away: string, commenceTime: string, status: ScoreGame["status"]): ScoreGame => ({
  id,
  homeTeam: home,
  awayTeam: away,
  status,
  scores: null,
  commenceTime,
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
});
const odds = (id: string, home: string, away: string, commenceTime: string, sportKey: string): OddsGame =>
  ({ id, sportKey, homeTeam: home, awayTeam: away, commenceTime, bookmakers: [] }) as unknown as OddsGame;
const byNickname = (sportKey: string, nickname: string) => (g: { homeTeam: string; awayTeam: string }) =>
  teamNameEndsWith(g.homeTeam, nickname, sportKey) || teamNameEndsWith(g.awayTeam, nickname, sportKey);

const NCAAB = "basketball_ncaab";
const NFL = "americanfootball_nfl";
const ingest = (sportKey: string) => ({ excludeFinal: true, sportKey });
const pick = (r: ReturnType<typeof resolveScheduleGameFromFeeds>) => ({ id: r.game?.id ?? null, finishedOnly: r.finishedOnly === true });

function main() {
  // ---- 1. Bowling Green and Illinois, from the feeds as they were ---------------------------------------------------
  {
    // Score feed at 11-10 20:15Z: last night's final. The 11-10 NCAAB odds snapshot had no Bowling Green game.
    const scores = [score("bg-csu", "Bowling Green Falcons", "Cleveland State Vikings", "2026-11-10T00:00:00Z", "final")];
    const oddsGames = [odds("other", "Kansas Jayhawks", "North Carolina Tar Heels", "2026-11-11T01:00:00Z", NCAAB)];
    const at = new Date("2026-11-10T20:15:51Z");
    const team = byNickname(NCAAB, "bowling green falcons");
    expect("Bowling Green ML, real-time ingest: unmatched, finished-only", pick(resolveScheduleGameFromFeeds(scores, oddsGames, team, at, null, [], ingest(NCAAB))), { id: null, finishedOnly: true });
    expect("Bowling Green ML, manual paste: still last night's game (next-day matching unchanged)", pick(resolveScheduleGameFromFeeds(scores, oddsGames, team, at)), { id: "bg-csu", finishedOnly: false });
  }
  {
    // Score feed at 11-06 22:27Z: the Penn game, final at 03:45Z. Texas Tech v Illinois was not listed until 11-09.
    const scores = [score("ill-penn", "Illinois Fighting Illini", "Pennsylvania Quakers", "2026-11-06T01:30:00Z", "final")];
    const at = new Date("2026-11-06T22:27:45Z");
    const team = byNickname(NCAAB, "fighting illini");
    expect("Illinois +4.5, real-time ingest: unmatched, finished-only", pick(resolveScheduleGameFromFeeds(scores, [], team, at, null, [], ingest(NCAAB))), { id: null, finishedOnly: true });
    expect("Illinois +4.5, manual paste: still the Penn game", pick(resolveScheduleGameFromFeeds(scores, [], team, at)).id, "ill-penn");
  }

  // ---- 2. same-day finished game (Vinny, London NFL) ----------------------------------------------------------------
  {
    const scores = [score("atl-cin", "Atlanta Falcons", "Cincinnati Bengals", "2026-11-08T14:30:00Z", "final"), score("ind-x", "Indianapolis Colts", "Pittsburgh Steelers", "2026-11-08T18:00:00Z", "preview")];
    const at = new Date("2026-11-08T17:49:16Z");
    const team = (g: { homeTeam: string; awayTeam: string }) => byNickname(NFL, "bengals")(g) && byNickname(NFL, "falcons")(g);
    expect("Bengals/Falcons over, real-time ingest 4 min after the final: unmatched (same-day step too)", pick(resolveScheduleGameFromFeeds(scores, [], team, at, null, [], ingest(NFL))), { id: null, finishedOnly: true });
    expect("Bengals/Falcons over, manual paste: the same-day game, as before", pick(resolveScheduleGameFromFeeds(scores, [], team, at)).id, "atl-cin");
  }

  // ---- 3. a live pick on an in-progress game still matches ----------------------------------------------------------
  {
    const scores = [score("okc-por", "Portland Trail Blazers", "Oklahoma City Thunder", "2026-11-11T04:00:00Z", "live")];
    const at = new Date("2026-11-11T05:30:00Z");
    const team = byNickname("basketball_nba", "thunder");
    expect("live game, real-time ingest: matched", pick(resolveScheduleGameFromFeeds(scores, [], team, at, null, [], ingest("basketball_nba"))), { id: "okc-por", finishedOnly: false });
    expect("live game, manual paste: matched", pick(resolveScheduleGameFromFeeds(scores, [], team, at)).id, "okc-por");
    const pregame = [score("okc-por", "Portland Trail Blazers", "Oklahoma City Thunder", "2026-11-11T04:00:00Z", "preview")];
    expect("pregame game, real-time ingest: matched", pick(resolveScheduleGameFromFeeds(pregame, [], team, new Date("2026-11-10T20:00:00Z"), null, [], ingest("basketball_nba"))).id, "okc-por");
  }

  // ---- 4. the odds-feed twin, and the team's next game ---------------------------------------------------------------
  {
    // An early game today, final now. Today's odds snapshot still lists it (written before tip, "preview" by
    // construction). With no other score-feed game, the odds fallback must not bring the finished game back.
    const scores = [score("espn-early", "Duke Blue Devils", "Army Black Knights", "2026-11-11T17:00:00Z", "final")];
    const oddsGames = [odds("odds-early", "Duke Blue Devils", "Army Black Knights", "2026-11-11T17:05:00Z", NCAAB)];
    const at = new Date("2026-11-11T21:00:00Z");
    const team = byNickname(NCAAB, "blue devils");
    expect("finished game's odds-feed twin: not matched for ingest", pick(resolveScheduleGameFromFeeds(scores, oddsGames, team, at, null, [], ingest(NCAAB))), { id: null, finishedOnly: true });
    // The team's next game, days out, is listed: that is what an after-the-game post means.
    const withNext = [...oddsGames, odds("odds-next", "Duke Blue Devils", "Kansas Jayhawks", "2026-11-14T00:00:00Z", NCAAB)];
    expect("the team's next game (odds feed) still matches for ingest", pick(resolveScheduleGameFromFeeds(scores, withNext, team, at, null, [], ingest(NCAAB))), { id: "odds-next", finishedOnly: false });
    expect("manual paste with the same feeds: today's finished game, as before", pick(resolveScheduleGameFromFeeds(scores, withNext, team, at)).id, "espn-early");
  }

  // ---- 5. review-queue approval: matched at the message's arrival, inserted later without re-matching ------------------
  const src = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
  const review = src("ingest-review.ts");
  const resolveStart = review.indexOf("export async function resolveReviewItem(");
  const resolveBody = review.slice(resolveStart, review.indexOf("\n}\n", resolveStart));
  expect("resolveReviewItem found", resolveStart > 0 && resolveBody.length > 500, true);
  expect(
    "approving inserts the stored row: no game matching, no price lookup at approval time",
    ["resolveGameAndOdds", "createPickRowResolver", "resolveGameFor", "lookupGame", "getLiveScoresForSport"].filter((s) => resolveBody.includes(s)),
    []
  );
  expect("review choices are matched with the rule on (buildReviewDrafts -> createPickRowResolver({ realTimeIngest }))", review.includes("createPickRowResolver({ realTimeIngest })"), true);

  // ---- 6. plumbing -------------------------------------------------------------------------------------------------
  const telegram = src("telegram-ingest.ts");
  expect("Telegram ingest: the import runs with realTimeIngest: true", /runCatalogImportForUser\([\s\S]*?realTimeIngest: true,[\s\S]*?\}\);/.test(telegram), true);
  expect("Telegram ingest: review drafts are built with realTimeIngest: true", telegram.includes("buildReviewDrafts(result.questions, { realTimeIngest: true })"), true);
  const orchestrator = src("catalog-import-orchestrator.ts");
  expect("orchestrator passes the hook through to importPicksForUser", orchestrator.includes("{ realTimeIngest: hooks.realTimeIngest === true }"), true);
  const core = src("bulk-import-core.ts");
  expect("both lookups (first try and retry) carry the rule", (core.match(/lookupGame\(liveSportKey, nicknames, item\.gameNumber, getOdds, realTimeIngest\)/g) ?? []).length, 2);
  expect("lookupGame hands it to both resolvers", (core.match(/excludeFinal \}\)/g) ?? []).length >= 2, true);
  expect("importPicksForUser defaults it off", core.includes("{ realTimeIngest = false }: { realTimeIngest?: boolean } = {}"), true);
  expect("the skipped-line reason says why", core.includes('finishedBeforePost ? FINISHED_BEFORE_POST_REASON : "No scheduled game matched"'), true);
  const manual = readFileSync(path.join(__dirname, "../actions/bulk-picks.ts"), "utf8");
  expect("manual paste (bulk-picks.ts) never turns it on", manual.includes("realTimeIngest"), false);

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll ingest finished-game matching checks passed.");
}

main();
