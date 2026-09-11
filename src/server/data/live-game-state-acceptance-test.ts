// Proof for live-game-state.ts's normalizePlay - locks the MLB Stats API
// winProbability shape (captured live against a real completed game during
// the Phase 1 Command Center investigation) down to the normalized fields
// mlb-momentum.ts's factors actually read, and confirms malformed/partial
// entries are dropped rather than crashing the poller.
// Run: npx tsx src/server/data/live-game-state-acceptance-test.ts
import { normalizePlay } from "./live-game-state";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// A real play entry's shape, trimmed to the fields normalizePlay reads
// (captured live from statsapi.mlb.com/api/v1/game/{pk}/winProbability).
const REAL_PLAY = {
  result: { type: "atBat", event: "Groundout", eventType: "field_out", rbi: 0, awayScore: 1, homeScore: 3, isOut: true },
  about: { atBatIndex: 62, halfInning: "top", isTopInning: true, inning: 9, isComplete: true, isScoringPlay: false },
  count: { balls: 2, strikes: 2, outs: 3 },
  matchup: { pitcher: { id: 628452, fullName: "Raisel Iglesias", link: "/api/v1/people/628452" } },
  runners: [
    {
      movement: { originBase: "1B", start: "1B", end: "2B", outBase: null, isOut: false, outNumber: null },
      details: { runner: { id: 802415, fullName: "Chandler Simpson" } },
    },
    {
      movement: { originBase: null, start: null, end: null, outBase: "1B", isOut: true, outNumber: 3 },
      details: { runner: { id: 666018, fullName: "Jonathan Aranda" } },
    },
  ],
  homeTeamWinProbability: 56.7,
  awayTeamWinProbability: 43.3,
  homeTeamWinProbabilityAdded: 3.1,
  atBatIndex: 62,
};

{
  const play = normalizePlay(REAL_PLAY);
  check("a real play entry normalizes successfully", play !== null);
  check("win probabilities pass through unchanged", play?.homeWinProbability === 56.7 && play?.awayWinProbability === 43.3);
  check("score reads from result.homeScore/awayScore", play?.homeScore === 3 && play?.awayScore === 1);
  check("outs reads from count.outs", play?.outs === 3);
  check("inning/half-inning read from about", play?.inning === 9 && play?.isTopInning === true);
  check("current pitcher reads from matchup.pitcher", play?.currentPitcherId === 628452 && play?.currentPitcherName === "Raisel Iglesias");
  check(
    "runnersOnBase includes only the non-out runner's landing base (2B), not the out runner",
    JSON.stringify(play?.runnersOnBase) === JSON.stringify(["2B"])
  );
}

{
  // Bases-empty / no scoring-position runner - the out runner's outBase must
  // never leak into runnersOnBase (it isn't a base they're standing on).
  const noRisp = normalizePlay({
    ...REAL_PLAY,
    runners: [{ movement: { end: null, isOut: true, outBase: "1B" } }],
  });
  check("an out-only runners array yields no occupied bases", noRisp?.runnersOnBase.length === 0);
}

{
  // A play missing runners entirely (some early-season entries lack it) -
  // should not throw, just report no runners on base.
  const noRunnersField = normalizePlay({ ...REAL_PLAY, runners: undefined });
  check("a missing runners field normalizes to an empty runnersOnBase, not a crash", noRunnersField?.runnersOnBase.length === 0);
}

{
  // Missing the one pair of fields every real play has - not a usable play.
  check("an entry missing win-probability fields is dropped (returns null)", normalizePlay({ about: {} }) === null);
  check("null/undefined input is dropped, not thrown", normalizePlay(null) === null && normalizePlay(undefined) === null);
}

{
  // No current-matchup pitcher recorded (shouldn't happen in practice, but
  // must degrade rather than crash) - currentPitcherId/Name both null.
  const noPitcher = normalizePlay({ ...REAL_PLAY, matchup: {} });
  check("a play with no matchup.pitcher normalizes pitcher fields to null", noPitcher?.currentPitcherId === null && noPitcher?.currentPitcherName === null);
}

console.log("\n" + "=".repeat(60));
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
