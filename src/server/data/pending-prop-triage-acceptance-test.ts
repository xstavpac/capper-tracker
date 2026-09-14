// Proof for the pending-pick/stuck-leg PLAYER_PROP triage fix in picks.ts:
// getPendingPicksForUser and getPendingLegsForUser used to call
// resolveTouchdownProp directly for every PLAYER_PROP pick/leg, regardless of
// its actual market, so a still-pending pick in one of the 4 structured
// markets added since (#75 - PASS_YDS/RUSH_YDS/REC_YDS/RECEPTIONS) showed the
// stale "this bet text isn't a recognized touchdown prop" reason even though
// the real grader (resolvePlayerProp) handles that market fine. Both
// functions now call resolvePlayerProp, the same dispatcher the real grader
// uses, so the reason text always matches the market the pick is actually
// in.
//
// Pure: the prisma singleton's methods are swapped for spies before each
// case, so no database and no network fetch is touched (each fixture's
// betDetail is deliberately missing an Over/Under line, so
// resolveYardageOrReceptionsProp returns its reason before ever calling the
// ESPN box-score fetch). Same patch/restore pattern as
// grading-idempotency-acceptance-test.ts. Run with:
//   npx tsx src/server/data/pending-prop-triage-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { getPendingPicksForUser, getPendingLegsForUser } from "@/server/data/picks";
import type { Pick, Leg, GameResult, Capper, Sport, ParlayBet } from "@prisma/client";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const originals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  originals[path] ??= target[method];
  target[method] = fn;
}
function restoreAll() {
  for (const path of Object.keys(originals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = originals[path];
  }
}

// A game well past the 6h "should have graded by now" grace period.
const GAME_TIME = new Date(Date.now() - 24 * 3600000);
const SPORT_KEY = "americanfootball_nfl";

const sport = { id: "sport-nfl", name: "NFL" } as unknown as Sport;

const gameResult: GameResult = {
  id: "gr-1",
  sportKey: SPORT_KEY,
  externalId: "ext-1",
  homeTeam: "Buffalo Bills",
  awayTeam: "Houston Texans",
  homeScore: 24,
  awayScore: 17,
  gameDate: GAME_TIME,
} as unknown as GameResult;

async function main() {
  // ---- 1. Standalone pending pick, structured RUSH_YDS market, no O/U line
  //         in the text -> the real dispatcher's own reason, not the stale
  //         TD-specific one. ----
  patch("gameResult.findMany", async () => [gameResult]);
  patch("pick.findMany", async () => [
    {
      id: "pick-1",
      betType: "PLAYER_PROP",
      betDetail: "Texans David Montgomery Rushing Yards", // no Over/Under number
      propMarket: "RUSH_YDS",
      playerName: "Texans David Montgomery",
      line: null,
      odds: -110,
      units: 1,
      homeTeam: "Buffalo Bills",
      awayTeam: "Houston Texans",
      gameTime: GAME_TIME,
      capper: { id: "capper-1", name: "Test Capper" } as unknown as Capper,
      sport,
    } as unknown as Pick,
  ]);

  const [pendingPick] = await getPendingPicksForUser("user-1");
  expect(
    "pending RUSH_YDS pick shows the real yardage-resolver reason, not the stale TD text",
    pendingPick.unmatchedReason,
    "matched game, but couldn't find an Over/Under line in this bet text"
  );

  // ---- 2. Regression: a TD prop (legacy null propMarket) still resolves via
  //         resolveTouchdownProp through the same dispatcher, unaffected. ----
  patch("pick.findMany", async () => [
    {
      id: "pick-2",
      betType: "PLAYER_PROP",
      betDetail: "not a recognizable prop at all",
      propMarket: null,
      playerName: null,
      line: null,
      odds: -110,
      units: 1,
      homeTeam: "Buffalo Bills",
      awayTeam: "Houston Texans",
      gameTime: GAME_TIME,
      capper: { id: "capper-1", name: "Test Capper" } as unknown as Capper,
      sport,
    } as unknown as Pick,
  ]);
  const [tdPick] = await getPendingPicksForUser("user-1");
  expect(
    "malformed legacy PLAYER_PROP pick still falls through to resolveTouchdownProp's own reason (unaffected by this fix)",
    tdPick.unmatchedReason,
    "matched game, but this bet text isn't a recognized touchdown prop"
  );

  // ---- 3. Stuck parlay leg counterpart, RUSH_YDS market re-derived from
  //         betDetail (Leg has no propMarket/playerName columns), no O/U line
  //         -> same market-appropriate reason via getPendingLegsForUser. ----
  patch("leg.findMany", async () => [
    {
      id: "leg-1",
      parlayBetId: "parlay-1",
      legIndex: 0,
      betType: "PLAYER_PROP",
      betDetail: "Bills James Cook III Rushing Yards", // no Over/Under number
      line: null,
      odds: -110,
      homeTeam: "Buffalo Bills",
      awayTeam: "Houston Texans",
      gameTime: GAME_TIME,
      status: "PENDING",
      sport,
      parlayBet: {
        id: "parlay-1",
        userId: "user-1",
        status: "PENDING",
        units: 1,
        capper: { id: "capper-1", name: "Test Capper" } as unknown as Capper,
        _count: { legs: 2 },
      } as unknown as ParlayBet & { _count: { legs: number } },
    } as unknown as Leg,
  ]);

  const [pendingLeg] = await getPendingLegsForUser("user-1");
  expect(
    "stuck RUSH_YDS parlay leg shows the real yardage-resolver reason via resolvePlayerProp, not the stale TD text",
    pendingLeg.reason,
    "matched game, but couldn't find an Over/Under line in this bet text"
  );

  restoreAll();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
