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

// A fake WIDE-schedule checker (the tiebreaker's runWideScheduleCheck):
// `hasGame` is the set of `${nickname}|${sport}` keys with a real game
// SOMEWHERE on the schedule (not just today) - everything else has nothing on
// the calendar at all. Defaults to empty, matching every existing scenario
// below where the "losing" near-term candidate genuinely has no game coming
// up, so the schedule step's original one-candidate-wins behavior is
// unaffected unless a test opts into a runner-up game with this.
function fakeWideSchedule(hasGame: string[] = []): ScheduleChecker {
  const set = new Set(hasGame);
  return async (queries: ScheduleCheckQuery[]) => {
    const out: Record<string, boolean> = {};
    for (const q of queries) out[q.nickname + "|" + q.sport] = set.has(q.nickname + "|" + q.sport);
    return out;
  };
}

// Bundles a near-term + wide fake pair for the common case, so call sites
// read the same as before the tiebreaker existed: `deps(playing)` behaves
// exactly like the old `runScheduleCheck: fakeSchedule(playing)`, with no
// runner-up game on the wide check. `wideExtra` adds keys that DO have a real
// game on the wide check without also being "playing today" - used by the
// tiebreaker-specific tests below.
function deps(playing: string[], wideExtra: string[] = []) {
  return {
    runScheduleCheck: fakeSchedule(playing),
    runWideScheduleCheck: fakeWideSchedule(wideExtra),
  };
}

// A checker that always rejects - simulates an ESPN feed outage.
const throwingSchedule: ScheduleChecker = async () => {
  throw new Error("ESPN scoreboard 503");
};
const throwingDeps = { runScheduleCheck: throwingSchedule, runWideScheduleCheck: fakeWideSchedule() };

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
      ...deps(["liberty flames|NCAAF"]),
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
      ...deps(["new york liberty|WNBA"]),
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
      ...deps(["liberty flames|NCAAF", "new york liberty|WNBA"]),
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
      ...deps([]),
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
      ...deps(["arizona cardinals|NFL"]),
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
      ...deps(["st. louis cardinals|MLB"]),
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
      ...deps([]),
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
      ...throwingDeps,
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
    // can't narrow either, and neither a bare "-3" spread NOR "ML" carries a
    // sport-specific signal ("ML" is used identically by MLB and NFL, so it is
    // no longer an MLB context signal), so both correctly stay ambiguous
    // rather than guessing off a stale assumption.
    for (const line of ["Cardinals -3", "Cardinals ML"]) {
      const res = await runAmbiguousHierarchy([ambiguousPick(line)], {}, {
        ...throwingDeps,
        now: SEPT,
      });
      check(`Cardinals: feed throws, both in season, "${line}" -> stays ambiguous`, {
        sport: res.picks[0].sportName,
        stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
      }, { sport: "", stillAmbiguous: ["cardinals"] });
    }
  }

  console.log("\n########## PART B2: Bucs (NFL Tampa Bay vs MLB Pittsburgh Pirates) ##########");
  {
    // September - both NFL and MLB in their calendar window, so schedule-first.
    // Only the Buccaneers (NFL) play today -> NFL via schedule.
    const res = await runAmbiguousHierarchy([ambiguousPick("Bucs ML")], {}, {
      ...deps(["tampa bay buccaneers|NFL"]),
      now: SEPT,
    });
    check("Bucs: only Tampa Bay (NFL) plays today -> NFL via schedule", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "NFL", nicknames: ["tampa bay buccaneers"], method: "schedule" });
  }
  {
    // Mirror: only the Pirates (MLB) play today -> MLB via schedule.
    const res = await runAmbiguousHierarchy([ambiguousPick("Bucs -1.5")], {}, {
      ...deps(["pittsburgh pirates|MLB"]),
      now: SEPT,
    });
    check("Bucs: only Pittsburgh (MLB) plays today -> MLB via schedule", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "MLB", nicknames: ["pittsburgh pirates"], method: "schedule" });
  }
  {
    // November: MLB's window (ends Nov 5) is over, NFL is not -> NFL via the
    // calendar, no schedule dependency.
    const res = await runAmbiguousHierarchy([ambiguousPick("Bucs ML")], {}, {
      ...deps([]),
      now: new Date("2026-11-20T18:00:00Z"),
    });
    check("Bucs: November -> NFL via calendar (MLB out of season)", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
    }, { sport: "NFL", method: "season" });
  }
  {
    // The Sept/Oct overlap: both play the same day AND both in season. "Bucs
    // ML" no longer wrong-guesses MLB (see the SPORT_CONTEXT_SIGNALS change) -
    // it surfaces for a one-click choice instead of silently logging a
    // football pick as baseball.
    const res = await runAmbiguousHierarchy([ambiguousPick("Bucs ML")], {}, {
      ...deps(["tampa bay buccaneers|NFL", "pittsburgh pirates|MLB"]),
      now: SEPT,
    });
    check("Bucs: both play, both in season, bare 'ML' -> stays ambiguous", {
      sport: res.picks[0].sportName,
      stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
    }, { sport: "", stillAmbiguous: ["bucs"] });
  }
  {
    // ...but a genuinely football-specific pick still resolves NFL via context
    // even in that window ("spread" is an NFL signal).
    const res = await runAmbiguousHierarchy([ambiguousPick("Bucs first-half spread -1.5")], {}, {
      ...deps(["tampa bay buccaneers|NFL", "pittsburgh pirates|MLB"]),
      now: SEPT,
    });
    check("Bucs: 'first-half spread' -> NFL via pick context", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
    }, { sport: "NFL", method: "pick_context" });
  }

  console.log("\n########## PART C: memory + pick-context still win where they should ##########");
  {
    // A prior choice in the same import is honored with no schedule call at
    // all (the fake would resolve it NFL; memory says MLB).
    let called = false;
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals -3")], { cardinals: { label: "St. Louis Cardinals (MLB)", sport: "MLB", nickname: "st. louis cardinals" } }, {
      runScheduleCheck: async (q) => { called = true; return fakeSchedule(["arizona cardinals|NFL"])(q); },
      runWideScheduleCheck: fakeWideSchedule(),
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
      ...deps(["arizona cardinals|NFL", "st. louis cardinals|MLB"]),
      now: SEPT,
    });
    check("Cardinals: both playing but text is NFL-specific -> NFL via pick context", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
    }, { sport: "NFL", method: "pick_context" });
  }

  console.log("\n########## PART C: bare CITY names run the SAME hierarchy as nickname collisions ##########");
  {
    // Single-candidate city ("green bay" -> only the Packers): the schedule
    // check still runs (nothing special-cases a 1-element candidate list),
    // and a real game today resolves it via "schedule" - same method/shape
    // as any nickname case, not a different code path.
    const res = await runAmbiguousHierarchy([ambiguousPick("Green Bay -6.5")], {}, {
      ...deps(["green bay packers|NFL"]),
      now: SEPT,
    });
    check("Green Bay: its one candidate has a game today -> NFL via schedule", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "NFL", nicknames: ["green bay packers"], method: "schedule" });
  }
  {
    // Genuinely multi-candidate city ("chicago" -> 6 franchises across MLB/
    // NFL/NBA/NHL/WNBA). Exactly one has a game today (the Cubs) -> resolves
    // MLB via schedule, the same narrowing "Cardinals"/"Bucs" get above -
    // never an auto-pick just because MLB or the Bears are "the big team".
    const res = await runAmbiguousHierarchy([ambiguousPick("Chicago -1.5")], {}, {
      ...deps(["chicago cubs|MLB"]),
      now: SEPT,
    });
    check("Chicago: only the Cubs have a game today -> MLB via schedule (of 6 real candidates)", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "MLB", nicknames: ["chicago cubs"], method: "schedule" });
  }
  {
    // Two of Chicago's candidates play the same day (Cubs AND Bears) -
    // schedule inconclusive. Calendar also can't settle it: MLB (both Cubs
    // and White Sox), NFL, and WNBA are all in season simultaneously in
    // September, so more than one sport stays in the running - no pick-
    // context signal in a bare "-1.5" either. Surfaces for a manual choice,
    // listing all 6 real candidates - exactly like "Liberty: both playing,
    // both in season" above, not a narrower or city-specific prompt.
    const res = await runAmbiguousHierarchy([ambiguousPick("Chicago -1.5")], {}, {
      ...deps(["chicago cubs|MLB", "chicago bears|NFL"]),
      now: SEPT,
    });
    check("Chicago: two candidates playing, multiple sports in season -> stays ambiguous (no guess)", {
      sport: res.picks[0].sportName,
      stillAmbiguousKey: res.stillAmbiguous[0]?.key,
      candidateCount: res.stillAmbiguous[0]?.options.length,
    }, { sport: "", stillAmbiguousKey: "chicago", candidateCount: 6 });
  }
  {
    // Calendar fallback in the dead of winter (NFL/MLB/WNBA all out of
    // season, only NBA/NHL in their window) still can't narrow Chicago to
    // one - Bulls (NBA) and Blackhawks (NHL) are both in season together -
    // demonstrating the multi-candidate city genuinely needs the schedule
    // check or a manual choice even outside the September overlap window.
    const res = await runAmbiguousHierarchy([ambiguousPick("Chicago ML")], {}, {
      ...deps([]),
      now: new Date("2026-12-10T16:00:00Z"),
    });
    check("Chicago: mid-December, schedule blank -> still ambiguous (Bulls + Blackhawks both in season)", {
      sport: res.picks[0].sportName,
      stillAmbiguousKey: res.stillAmbiguous[0]?.key,
    }, { sport: "", stillAmbiguousKey: "chicago" });
  }

  console.log("\n########## PART D: Texas/Pittsburgh mis-import fix - real reported cases run the full hierarchy ##########");
  {
    // The exact "Texas Moneyline" case: only the Rangers (MLB) have a game
    // today -> resolves MLB via schedule, never silently guessing NCAAF.
    const res = await runAmbiguousHierarchy([ambiguousPick("Texas Moneyline")], {}, {
      ...deps(["texas rangers|MLB"]),
      now: SEPT,
    });
    check("Texas: only the Rangers (MLB) play today -> MLB via schedule, not a silent NCAAF guess", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "MLB", nicknames: ["texas rangers"], method: "schedule" });
  }
  {
    // Mirror: only the Longhorns (NCAAF) play today -> resolves NCAAF via
    // schedule too - a genuinely unambiguous case (per the live schedule)
    // should still resolve immediately, not get needlessly flagged.
    const res = await runAmbiguousHierarchy([ambiguousPick("Texas Moneyline")], {}, {
      ...deps(["texas longhorns|NCAAF"]),
      now: SEPT,
    });
    check("Texas: only the Longhorns (NCAAF) play today -> NCAAF via schedule", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "NCAAF", nicknames: ["texas longhorns"], method: "schedule" });
  }
  {
    // Both playing the same day (both in season, both scheduled) -> the
    // schedule and calendar can't settle it, and neither "Moneyline" nor
    // "ML" carries sport-specific terminology -> stays ambiguous rather than
    // guessing, exactly the behavior the real mis-import needed.
    const res = await runAmbiguousHierarchy([ambiguousPick("Texas Moneyline")], {}, {
      ...deps(["texas rangers|MLB", "texas longhorns|NCAAF"]),
      now: SEPT,
    });
    check("Texas: both play today, both in season -> stays ambiguous (no guess)", {
      sport: res.picks[0].sportName,
      stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
    }, { sport: "", stillAmbiguous: ["texas"] });
  }
  {
    // The exact "Pittsburgh Moneyline" case: only the Pirates (MLB) have a
    // game today -> resolves MLB via schedule, never silently guessing NCAAF.
    const res = await runAmbiguousHierarchy([ambiguousPick("Pittsburgh Moneyline")], {}, {
      ...deps(["pittsburgh pirates|MLB"]),
      now: SEPT,
    });
    check("Pittsburgh: only the Pirates (MLB) play today -> MLB via schedule, not a silent NCAAF guess", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "MLB", nicknames: ["pittsburgh pirates"], method: "schedule" });
  }
  {
    // Mirror: only the Panthers (NCAAF) play today -> resolves NCAAF via
    // schedule, same as any genuinely unambiguous (per the live schedule)
    // case.
    const res = await runAmbiguousHierarchy([ambiguousPick("Pittsburgh Moneyline")], {}, {
      ...deps(["pittsburgh panthers|NCAAF"]),
      now: SEPT,
    });
    check("Pittsburgh: only the Panthers (NCAAF) play today -> NCAAF via schedule", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "NCAAF", nicknames: ["pittsburgh panthers"], method: "schedule" });
  }
  {
    // Four real candidates (Pirates/Steelers/Penguins/Panthers), none playing
    // today, none of the calendar-only sports narrowed by the September
    // window either -> stays ambiguous with all 4 real options listed,
    // never an auto-pick just because one franchise is "the big team".
    const res = await runAmbiguousHierarchy([ambiguousPick("Pittsburgh Moneyline")], {}, {
      ...deps([]),
      now: SEPT,
    });
    check("Pittsburgh: nobody playing today, multiple sports in season -> stays ambiguous with all 4 real candidates", {
      sport: res.picks[0].sportName,
      stillAmbiguousKey: res.stillAmbiguous[0]?.key,
      candidateCount: res.stillAmbiguous[0]?.options.length,
    }, { sport: "", stillAmbiguousKey: "pittsburgh", candidateCount: 4 });
  }

  console.log("\n########## PART E: Indiana (WNBA Fever vs NCAAF Hoosiers vs NBA Pacers) - schedule tiebreaker + plausibility floor ##########");
  {
    // The reported bug: only the Fever (WNBA) have a game in the near-term
    // window, but the Hoosiers (NCAAF) have a real game later in the week -
    // the tiebreaker must NOT let the near-term match win outright. Falls
    // through to season, which also can't settle it (WNBA and NCAAF are both
    // in season in September - NBA isn't, tip-off is Oct 20), so it correctly
    // surfaces for a manual choice instead of silently guessing WNBA.
    const res = await runAmbiguousHierarchy([ambiguousPick("Indiana -6")], {}, {
      ...deps(["indiana fever|WNBA"], ["indiana hoosiers|NCAAF"]),
      now: SEPT,
    });
    check("Indiana: only the Fever play near-term, but the Hoosiers have a real game later -> does not auto-resolve WNBA, falls through", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
      stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
    }, { sport: "", method: undefined, stillAmbiguous: ["indiana"] });
  }
  {
    // Regression guard: when the OTHER candidate genuinely has nothing on the
    // calendar at all (not just outside the near-term window), the
    // genuinely-unambiguous case must still resolve via schedule exactly as
    // before the tiebreaker existed.
    const res = await runAmbiguousHierarchy([ambiguousPick("Indiana -6")], {}, {
      ...deps(["indiana fever|WNBA"]),
      now: SEPT,
    });
    check("Indiana: only the Fever have any game at all -> still resolves WNBA via schedule (no regression)", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "WNBA", nicknames: ["indiana fever"], method: "schedule" });
  }
  {
    // Plausibility floor: the schedule check alone would resolve this WNBA
    // (Fever playing, nothing else on the calendar for the other
    // candidates), but a -44 spread is essentially impossible in WNBA - the
    // resolution must not be silently finalized. It's routed to manual
    // review (stillAmbiguous) instead, and nothing is logged as auto-resolved.
    const res = await runAmbiguousHierarchy([ambiguousPick("Indiana -44")], {}, {
      ...deps(["indiana fever|WNBA"]),
      now: SEPT,
    });
    check("Indiana: WNBA-resolved pick with an implausible -44 spread -> not finalized, routed to manual review", {
      sport: res.picks[0].sportName,
      logs: res.logs,
      stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
    }, { sport: "", logs: [], stillAmbiguous: ["indiana"] });
  }
  {
    // Same schedule signal, but a plausible -6 spread -> resolves normally,
    // completely unaffected by the plausibility floor.
    const res = await runAmbiguousHierarchy([ambiguousPick("Indiana -6")], {}, {
      ...deps(["indiana fever|WNBA"]),
      now: SEPT,
    });
    check("Indiana: WNBA-resolved pick with a plausible -6 spread -> resolves normally", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "WNBA", nicknames: ["indiana fever"], method: "schedule" });
  }
  {
    // NCAAF-resolved pick with a large but entirely realistic +38 spread
    // (FBS blowouts routinely reach this) -> must NOT be incorrectly flagged
    // as implausible just because the magnitude is large.
    const res = await runAmbiguousHierarchy([ambiguousPick("Indiana +38")], {}, {
      ...deps(["indiana hoosiers|NCAAF"]),
      now: SEPT,
    });
    check("Indiana: NCAAF-resolved pick with a large but realistic +38 spread -> resolves normally, not flagged", {
      sport: res.picks[0].sportName,
      nicknames: res.picks[0].teamNicknames,
      method: res.logs[0]?.method,
    }, { sport: "NCAAF", nicknames: ["indiana hoosiers"], method: "schedule" });
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
