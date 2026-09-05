// Proof for the ambiguous-nickname disambiguation hierarchy - run with:
//   npx tsx src/lib/ambiguous-hierarchy-acceptance-test.ts
//
// Covers the 2026-09 reorder from season-first to SCHEDULE-first: a live game
// today is the primary signal, the calendar season window is only a fallback
// for when the schedule check is inconclusive (0 or 2+ candidates playing) or
// the feed errors out entirely. The pure module takes an injected schedule
// checker (runScheduleCheck) so these cases run without the real "use server"
// action (which can't load under tsx - see the module header).
//
// No test framework exists in this repo (see parse-catalog-acceptance-test.ts's
// header); this file console.logs PASS/FAIL and exits non-zero on any failure.
import { parseCatalog, type ParsedPick } from "./parse-catalog";
import {
  runAmbiguousHierarchy,
  type ScheduleChecker,
  type ScheduleCheckQuery,
} from "./ambiguous-hierarchy";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// A fake live-schedule checker: `playing` is the set of `${nickname}|${sport}`
// keys that "have a game today"; everything else comes back false, exactly
// like the real checker does for a team with no game (and for any sport with
// no live feed wired up).
function fakeSchedule(playing: string[]): ScheduleChecker {
  const set = new Set(playing);
  return async (queries: ScheduleCheckQuery[]) => {
    const out: Record<string, boolean> = {};
    for (const q of queries) out[q.nickname + "|" + q.sport] = set.has(q.nickname + "|" + q.sport);
    return out;
  };
}

// A checker that always rejects - simulates an ESPN feed outage.
const throwingSchedule: ScheduleChecker = async () => {
  throw new Error("ESPN scoreboard 503");
};

function ambiguousPick(line: string): ParsedPick {
  const pick = parseCatalog(`Capper\n${line}`, []).picks[0];
  if (!pick) throw new Error(`parseCatalog produced no pick for ${JSON.stringify(line)}`);
  return pick;
}

async function main() {
  // A mid-September date: WNBA (May 15 - Oct 20), NCAAF (Aug 25 - Feb 1), MLB
  // (Mar 15 - Nov 5) and NFL (Aug 6 - Feb 15) are ALL in their calendar
  // window, so the season step can't discriminate any of these - only the
  // schedule check can. This is the exact window the reorder exists for.
  const SEPT = new Date("2026-09-05T16:00:00Z");

  console.log("########## PART A: Liberty (WNBA New York Liberty vs NCAAF Liberty Flames) ##########");
  {
    // Sanity: a bare "Liberty" pick is ambiguous coming out of parseCatalog.
    const p = ambiguousPick("Liberty ML");
    check("bare 'Liberty' is ambiguous with key 'liberty'", { key: p.ambiguousKey, sport: p.sportName }, { key: "liberty", sport: "" });
  }
  {
    // The headline case: NY Liberty idle, Liberty Flames playing today ->
    // resolves NCAAF via the schedule, NOT via any calendar reasoning.
    const res = await runAmbiguousHierarchy([ambiguousPick("Liberty ML")], {}, {
      runScheduleCheck: fakeSchedule(["liberty flames|NCAAF"]),
      now: SEPT,
    });
    check("Liberty: only the Flames have a game today -> NCAAF via schedule", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "NCAAF", nicknames: ["liberty flames"], method: "schedule" });
  }
  {
    // Mirror: NY Liberty playing, Flames idle -> WNBA via schedule.
    const res = await runAmbiguousHierarchy([ambiguousPick("Liberty +6.5")], {}, {
      runScheduleCheck: fakeSchedule(["new york liberty|WNBA"]),
      now: SEPT,
    });
    check("Liberty: only NY Liberty has a game today -> WNBA via schedule", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "WNBA", nicknames: ["new york liberty"], method: "schedule" });
  }
  {
    // Both playing the same day, both in season -> schedule can't settle it,
    // season can't settle it, no NCAAF/WNBA terminology in "ML" -> surfaces
    // for a manual choice rather than guessing.
    const res = await runAmbiguousHierarchy([ambiguousPick("Liberty ML")], {}, {
      runScheduleCheck: fakeSchedule(["liberty flames|NCAAF", "new york liberty|WNBA"]),
      now: SEPT,
    });
    check("Liberty: both playing, both in season -> stays ambiguous (no guess)", {
      sport: res.picks[0].sportName,
      stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
    }, { sport: "", stillAmbiguous: ["liberty"] });
  }
  {
    // Calendar fallback for Liberty: mid-November, schedule inconclusive
    // (nobody "playing" in the fake) - only NCAAF is still in its season
    // window (WNBA ended Oct 20), so the calendar resolves it to NCAAF.
    const res = await runAmbiguousHierarchy([ambiguousPick("Liberty -3")], {}, {
      runScheduleCheck: fakeSchedule([]),
      now: new Date("2026-11-15T16:00:00Z"),
    });
    check("Liberty: schedule blank in November -> NCAAF via calendar fallback", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
    }, { sport: "NCAAF", method: "season" });
  }

  console.log("\n########## PART B: Cardinals (MLB St. Louis vs NFL Arizona) - a second ambiguous key under schedule-first ##########");
  {
    // September: both MLB and NFL in season, so the calendar is no help.
    // Schedule says only the NFL Cardinals play today -> NFL via schedule.
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals -3")], {}, {
      runScheduleCheck: fakeSchedule(["arizona cardinals|NFL"]),
      now: SEPT,
    });
    check("Cardinals: only Arizona (NFL) plays today -> NFL via schedule", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "NFL", nicknames: ["arizona cardinals"], method: "schedule" });
  }
  {
    // Mirror: only St. Louis (MLB) plays today -> MLB via schedule, even
    // though NFL is also in season.
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals ML")], {}, {
      runScheduleCheck: fakeSchedule(["st. louis cardinals|MLB"]),
      now: SEPT,
    });
    check("Cardinals: only St. Louis (MLB) plays today -> MLB via schedule", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "MLB", nicknames: ["st. louis cardinals"], method: "schedule" });
  }
  {
    // Calendar fallback - inconclusive schedule: early July, nobody in the
    // fake "playing" set. NFL's window starts Aug 6, so on July 1 only MLB is
    // in season -> MLB via the calendar.
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals ML")], {}, {
      runScheduleCheck: fakeSchedule([]),
      now: new Date("2026-07-01T16:00:00Z"),
    });
    check("Cardinals: blank July schedule -> MLB via calendar fallback", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
    }, { sport: "MLB", method: "season" });
  }
  {
    // Calendar fallback - feed error: the schedule checker throws. Same July
    // date, so the calendar still narrows to MLB, and the reason notes the
    // feed was unavailable.
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals ML")], {}, {
      runScheduleCheck: throwingSchedule,
      now: new Date("2026-07-01T16:00:00Z"),
    });
    check("Cardinals: schedule feed throws in July -> MLB via calendar fallback", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
      feedNoted: res.logs[0]?.reason.includes("schedule feed unavailable"),
    }, { sport: "MLB", method: "season", feedNoted: true });
  }
  {
    // Feed error AND both candidates in season (September) -> the calendar
    // can't narrow either, and a bare "-3" spread carries no sport-specific
    // terminology, so it correctly stays ambiguous rather than guessing off a
    // stale assumption. ("Cardinals ML" would resolve via pick context - "ML"
    // is an MLB signal - which is why this case uses a bare spread instead.)
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals -3")], {}, {
      runScheduleCheck: throwingSchedule,
      now: SEPT,
    });
    check("Cardinals: feed throws with both in season -> stays ambiguous", {
      sport: res.picks[0].sportName,
      stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
    }, { sport: "", stillAmbiguous: ["cardinals"] });
  }

  console.log("\n########## PART C: memory + pick-context still win where they should ##########");
  {
    // A prior choice in the same import is honored with no schedule call at
    // all (the fake would resolve it NFL; memory says MLB).
    let called = false;
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals -3")], { cardinals: { label: "St. Louis Cardinals (MLB)", sport: "MLB", nickname: "st. louis cardinals" } }, {
      runScheduleCheck: async (q) => { called = true; return fakeSchedule(["arizona cardinals|NFL"])(q); },
      now: SEPT,
    });
    check("Cardinals: same-import memory resolves it (MLB) without a schedule call", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
      scheduleCalled: called,
    }, { sport: "MLB", method: "remembered", scheduleCalled: false });
  }
  {
    // Schedule + season both inconclusive (both playing, both in season), but
    // the pick text carries an NFL-specific term ("first-half spread") -> the
    // context step resolves it NFL.
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals first-half spread -1.5")], {}, {
      runScheduleCheck: fakeSchedule(["arizona cardinals|NFL", "st. louis cardinals|MLB"]),
      now: SEPT,
    });
    check("Cardinals: both playing but text is NFL-specific -> NFL via pick context", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
    }, { sport: "NFL", method: "pick_context" });
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
