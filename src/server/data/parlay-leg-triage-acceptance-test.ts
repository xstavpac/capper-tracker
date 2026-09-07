// Structural-validation proof for the Issue #23 "stuck parlay leg" triage
// rules - run with
// `npx tsx src/server/data/parlay-leg-triage-acceptance-test.ts` (or via
// `npm test`). Same standalone pattern as parlay-grading-acceptance-test.ts:
// no test runner, each check console.logs PASS/FAIL and the file exits
// non-zero on any failure.
//
// The reachable dev DB has zero real parlay data, so these are in-memory
// fixtures fed to the pure decision core (parlay-leg-triage.ts) rather than
// DB rows. getPendingLegsForUser (picks.ts) is a thin Prisma wrapper over
// exactly these two functions - isStuckParlayLeg for the three-part filter,
// computeStuckLegReason for the reason string - so proving them here proves
// the behavior the /picks/pending "Stuck parlay legs" section shows.
import type { PickStatus } from "@prisma/client";
import {
  isStuckParlayLeg,
  computeStuckLegReason,
  STUCK_LEG_MIN_AGE_HOURS,
  type LegGradeProbe,
} from "./parlay-leg-triage";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

// A game finished well over the grace period ago.
const FINISHED = STUCK_LEG_MIN_AGE_HOURS + 6;
// A game that started recently / hasn't finished (inside the grace period).
const TOO_EARLY = STUCK_LEG_MIN_AGE_HOURS - 3;

// Combined evaluation mirroring getPendingLegsForUser's per-leg decision:
// does this leg appear in the section, and with what reason?
function evaluateLeg(fixture: {
  legStatus: PickStatus;
  parentParlayStatus: PickStatus;
  ageHours: number;
  probe: LegGradeProbe;
}): { appears: boolean; reason: string | null } {
  const appears = isStuckParlayLeg({
    legStatus: fixture.legStatus,
    parentParlayStatus: fixture.parentParlayStatus,
    ageHours: fixture.ageHours,
  });
  return { appears, reason: appears ? computeStuckLegReason(fixture.probe) : null };
}

const NO_MATCH_PROBE: LegGradeProbe = {
  resolvable: true,
  matched: false,
  isPlayerProp: false,
  touchdownPropReason: null,
  outcomeResolved: false,
};
const GRADABLE_PROBE: LegGradeProbe = {
  resolvable: true,
  matched: true,
  isPlayerProp: false,
  touchdownPropReason: null,
  outcomeResolved: true,
};

// ---- The four scenarios from the Issue #23 brief ----

// 1. Genuinely stuck: parent PENDING, game finished, no matching game found.
//    Appears, with the "no matching game found" reason.
check(
  "genuinely stuck leg appears with correct reason",
  evaluateLeg({
    legStatus: "PENDING",
    parentParlayStatus: "PENDING",
    ageHours: FINISHED,
    probe: NO_MATCH_PROBE,
  }),
  { appears: true, reason: "no matching game found" }
);

// 2. Trailing leg of an already-LOST parlay: leg still PENDING (left that way
//    by design), parent frozen at LOSS. Must NOT appear.
check(
  "trailing leg of a lost parlay does not appear",
  evaluateLeg({
    legStatus: "PENDING",
    parentParlayStatus: "LOSS",
    ageHours: FINISHED,
    probe: NO_MATCH_PROBE,
  }),
  { appears: false, reason: null }
);

// 3. Leg whose game hasn't finished yet: parent PENDING, leg PENDING, but
//    inside the grace period. Too early - not stuck.
check(
  "leg whose game has not finished does not appear",
  evaluateLeg({
    legStatus: "PENDING",
    parentParlayStatus: "PENDING",
    ageHours: TOO_EARLY,
    probe: NO_MATCH_PROBE,
  }),
  { appears: false, reason: null }
);
check(
  "leg whose game has not started does not appear",
  evaluateLeg({
    legStatus: "PENDING",
    parentParlayStatus: "PENDING",
    ageHours: -4,
    probe: NO_MATCH_PROBE,
  }),
  { appears: false, reason: null }
);

// 4. A fully-graded parlay's legs: leg WIN/LOSS, parent WIN. Must NOT appear.
check(
  "graded winning leg of a won parlay does not appear",
  evaluateLeg({
    legStatus: "WIN",
    parentParlayStatus: "WIN",
    ageHours: FINISHED,
    probe: GRADABLE_PROBE,
  }),
  { appears: false, reason: null }
);
check(
  "graded losing leg of a won parlay does not appear",
  evaluateLeg({
    legStatus: "LOSS",
    parentParlayStatus: "WIN",
    ageHours: FINISHED,
    probe: GRADABLE_PROBE,
  }),
  { appears: false, reason: null }
);

// ---- Boundary + reason-ladder coverage ----

// Exactly at the grace threshold is still "not finished" - strictly greater.
check(
  "age exactly at the grace threshold does not appear",
  isStuckParlayLeg({ legStatus: "PENDING", parentParlayStatus: "PENDING", ageHours: STUCK_LEG_MIN_AGE_HOURS }),
  false
);
check(
  "age just past the grace threshold appears",
  isStuckParlayLeg({ legStatus: "PENDING", parentParlayStatus: "PENDING", ageHours: STUCK_LEG_MIN_AGE_HOURS + 0.01 }),
  true
);

// computeStuckLegReason ladder - same strings a stuck standalone pick gets.
check("reason: sport not tracked", computeStuckLegReason({ ...NO_MATCH_PROBE, resolvable: false }), "sport not tracked");
check("reason: no matching game found", computeStuckLegReason(NO_MATCH_PROBE), "no matching game found");
check(
  "reason: matched but unparseable bet text",
  computeStuckLegReason({ ...GRADABLE_PROBE, outcomeResolved: false }),
  "matched game, but couldn't parse a gradable number from the bet text"
);
check(
  "reason: matched player prop that could not be graded",
  computeStuckLegReason({
    resolvable: true,
    matched: true,
    isPlayerProp: true,
    touchdownPropReason: 'couldn\'t find "Puka Nacua" in the box score',
    outcomeResolved: false,
  }),
  'matched game, but couldn\'t find "Puka Nacua" in the box score'
);
check(
  "reason: null when the game matched and the bet is gradable (just awaiting the cron)",
  computeStuckLegReason(GRADABLE_PROBE),
  null
);

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
