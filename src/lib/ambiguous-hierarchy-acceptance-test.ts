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

// Multi-capper batch, exactly like a real bulk-import paste ("leave a blank
// line between different cappers' picks") - used for PART G's pick_context
// scoping tests, where the whole point is that more than one capper's picks
// go through runAmbiguousHierarchy in the same call.
function ambiguousBatch(text: string): ParsedPick[] {
  return parseCatalog(text, []).picks;
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
    // can't narrow either, and "ML" carries no sport-specific signal ("ML" is
    // used identically by MLB and NFL, so it is no longer an MLB context
    // signal) - stays ambiguous rather than guessing off a stale assumption.
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals ML")], {}, {
      runScheduleCheck: throwingSchedule,
      now: SEPT,
    });
    check('Cardinals: feed throws, both in season, "Cardinals ML" -> stays ambiguous', {
      sport: res.picks[0].sportName,
      stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
    }, { sport: "", stillAmbiguous: ["cardinals"] });
  }
  {
    // Same feed-error/both-in-season deadlock, but "-3" IS a real signal now
    // that line plausibility exists (see PART F below): a -3 spread exceeds
    // MLB's run-line bound, so it resolves NFL via plausibility instead of
    // staying ambiguous - schedule/season/context all produced no signal
    // either way here (feed threw, both in season, no context match), so
    // nothing conflicts with it.
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals -3")], {}, {
      runScheduleCheck: throwingSchedule,
      now: SEPT,
    });
    check('Cardinals: feed throws, both in season, "Cardinals -3" -> NFL via plausibility (NO_SIGNAL elsewhere)', {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
    }, { sport: "NFL", method: "plausibility" });
  }

  console.log("\n########## PART B2: Bucs (NFL Tampa Bay vs MLB Pittsburgh Pirates) ##########");
  {
    // September - both NFL and MLB in their calendar window, so schedule-first.
    // Only the Buccaneers (NFL) play today -> NFL via schedule.
    const res = await runAmbiguousHierarchy([ambiguousPick("Bucs ML")], {}, {
      runScheduleCheck: fakeSchedule(["tampa bay buccaneers|NFL"]),
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
      runScheduleCheck: fakeSchedule(["pittsburgh pirates|MLB"]),
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
      runScheduleCheck: fakeSchedule([]),
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
      runScheduleCheck: fakeSchedule(["tampa bay buccaneers|NFL", "pittsburgh pirates|MLB"]),
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
      runScheduleCheck: fakeSchedule(["tampa bay buccaneers|NFL", "pittsburgh pirates|MLB"]),
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

  console.log("\n########## PART C: bare CITY names run the SAME hierarchy as nickname collisions ##########");
  {
    // Single-candidate city ("green bay" -> only the Packers): the schedule
    // check still runs (nothing special-cases a 1-element candidate list),
    // and a real game today resolves it via "schedule" - same method/shape
    // as any nickname case, not a different code path.
    const res = await runAmbiguousHierarchy([ambiguousPick("Green Bay -6.5")], {}, {
      runScheduleCheck: fakeSchedule(["green bay packers|NFL"]),
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
      runScheduleCheck: fakeSchedule(["chicago cubs|MLB"]),
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
      runScheduleCheck: fakeSchedule(["chicago cubs|MLB", "chicago bears|NFL"]),
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
      runScheduleCheck: fakeSchedule([]),
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
      runScheduleCheck: fakeSchedule(["texas rangers|MLB"]),
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
      runScheduleCheck: fakeSchedule(["texas longhorns|NCAAF"]),
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
      runScheduleCheck: fakeSchedule(["texas rangers|MLB", "texas longhorns|NCAAF"]),
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
      runScheduleCheck: fakeSchedule(["pittsburgh pirates|MLB"]),
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
      runScheduleCheck: fakeSchedule(["pittsburgh panthers|NCAAF"]),
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
      runScheduleCheck: fakeSchedule([]),
      now: SEPT,
    });
    check("Pittsburgh: nobody playing today, multiple sports in season -> stays ambiguous with all 4 real candidates", {
      sport: res.picks[0].sportName,
      stillAmbiguousKey: res.stillAmbiguous[0]?.key,
      candidateCount: res.stillAmbiguous[0]?.options.length,
    }, { sport: "", stillAmbiguousKey: "pittsburgh", candidateCount: 4 });
  }

  console.log("\n########## PART F: line plausibility + cross-check (Giants: MLB SF / NFL NY / KBO Lotte) ##########");
  // All three candidates are in their calendar season window in September
  // (MLB/NFL/KBO all show in-season - see sport-seasons.ts), so the season
  // step is NO_SIGNAL (full 3-candidate set) throughout this section unless
  // otherwise noted - isolates whatever the schedule step is doing in each
  // case.
  {
    // NO_SIGNAL: nothing playing today (schedule inconclusive/empty), no
    // pick-context match either - plausibility alone narrows +6.5 down to
    // NFL (a +6.5 spread exceeds MLB/KBO's run-line bound), and nothing else
    // disagrees, so it auto-resolves with no prompt.
    const res = await runAmbiguousHierarchy([ambiguousPick("Giants +6.5")], {}, {
      runScheduleCheck: fakeSchedule([]),
      now: SEPT,
    });
    check("Giants +6.5, no other signal fires (NO_SIGNAL) -> auto-resolves NFL via plausibility, no prompt", {
      sport: res.picks[0].sportName,
      ambiguous: res.picks[0].ambiguous,
      method: res.logs[0]?.method,
    }, { sport: "NFL", ambiguous: undefined, method: "plausibility" });
  }
  {
    // CONFLICTS: schedule finds the two BASEBALL candidates (MLB + KBO)
    // playing today, NOT the NFL Giants - real, checked evidence against the
    // plausibility winner (NFL). Plausibility still narrows to NFL alone,
    // but the schedule signal actively disagrees, so this does NOT
    // auto-resolve - it falls through to the (single-option, narrowed)
    // prompt instead of guessing between two disagreeing signals.
    const res = await runAmbiguousHierarchy([ambiguousPick("Giants +6.5")], {}, {
      runScheduleCheck: fakeSchedule(["san francisco giants|MLB", "lotte giants|KBO"]),
      now: SEPT,
    });
    check("Giants +6.5, schedule leans MLB/KBO (CONFLICTS) -> does not auto-resolve, narrowed prompt", {
      sport: res.picks[0].sportName,
      narrowedOptions: res.picks[0].ambiguous?.map((o) => o.sport),
    }, { sport: "", narrowedOptions: ["NFL"] });
  }
  {
    // AGREES: schedule finds NFL + KBO playing today (not MLB) - an
    // inconclusive 2-of-3 schedule result on its own, but it DOES include
    // the plausibility winner (NFL), so it counts as independent agreement
    // rather than silence. Auto-resolves, no prompt.
    const res = await runAmbiguousHierarchy([ambiguousPick("Giants +6.5")], {}, {
      runScheduleCheck: fakeSchedule(["new york giants|NFL", "lotte giants|KBO"]),
      now: SEPT,
    });
    check("Giants +6.5, schedule leans NFL/KBO, includes NFL (AGREES) -> auto-resolves NFL via plausibility, no prompt", {
      sport: res.picks[0].sportName,
      ambiguous: res.picks[0].ambiguous,
      method: res.logs[0]?.method,
      reasonMentionsAgreement: res.logs[0]?.reason.includes("independently agreed"),
    }, { sport: "NFL", ambiguous: undefined, method: "plausibility", reasonMentionsAgreement: true });
  }
  {
    // Threshold boundary: a real MLB run line (+/-1.5) is comfortably inside
    // the bound for BOTH MLB and KBO, and NFL has no bound at all - nothing
    // gets dropped, all 3 candidates remain exactly as parseCatalog produced
    // them. Confirms the filter isn't overly aggressive on a normal,
    // realistic line.
    const res = await runAmbiguousHierarchy([ambiguousPick("Giants +1.5")], {}, {
      runScheduleCheck: fakeSchedule([]),
      now: SEPT,
    });
    check("Giants +1.5 (real MLB run line) -> nothing dropped, all 3 candidates remain, still ambiguous", {
      sport: res.picks[0].sportName,
      optionSports: res.picks[0].ambiguous?.map((o) => o.sport).sort(),
    }, { sport: "", optionSports: ["KBO", "MLB", "NFL"] });
  }
  {
    // Threshold boundary: a real (if large) NFL spread stays plausible for
    // NFL - the bound table has no NFL entry at all, so it's never excluded
    // regardless of magnitude. Also doubles as a second NO_SIGNAL
    // auto-resolve case at a different line value than the first test above.
    const res = await runAmbiguousHierarchy([ambiguousPick("Giants -9.5")], {}, {
      runScheduleCheck: fakeSchedule([]),
      now: SEPT,
    });
    check("Giants -9.5 (real NFL spread) -> NFL candidate remains plausible, auto-resolves", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
    }, { sport: "NFL", method: "plausibility" });
  }
  {
    // Moneyline has no numeric line to filter on - the plausibility filter
    // is a no-op, existing behavior is completely unchanged (still shows
    // all 3 registered candidates). The separate silent-wrong-resolution
    // issue with moneyline picks (Bug 7, in the pick_context step - fixed
    // below in PART G) is deliberately NOT touched by this fix - this only
    // proves plausibility itself does nothing for a lineless pick.
    const res = await runAmbiguousHierarchy([ambiguousPick("Giants Moneyline")], {}, {
      runScheduleCheck: fakeSchedule([]),
      now: SEPT,
    });
    check("Giants Moneyline (no line) -> plausibility filter is a no-op, all 3 candidates still shown", {
      sport: res.picks[0].sportName,
      optionSports: res.picks[0].ambiguous?.map((o) => o.sport).sort(),
    }, { sport: "", optionSports: ["KBO", "MLB", "NFL"] });
  }

  console.log("\n########## PART G: pick_context scoped to the capper that earned it (Bug 7 fix) ##########");
  {
    // The exact confirmed repro: "Giants touchdown scorer Barkley" (a
    // football-specific player prop, from one capper) and "Giants
    // Moneyline" (zero football/baseball signal of its own, from a
    // DIFFERENT capper) share the "giants" key in the same batch. Before the
    // fix, the first pick's NFL resolution silently applied to the second
    // pick too, batch-wide. Now it must not - Capper B's pick falls through
    // to the manual prompt instead of inheriting Capper A's resolution.
    const picks = ambiguousBatch(
      "Capper A\nGiants touchdown scorer Barkley\n\nCapper B\nGiants Moneyline"
    );
    const res = await runAmbiguousHierarchy(picks, {}, {
      runScheduleCheck: fakeSchedule([]),
      now: SEPT,
    });
    check("Giants: capper A's football-specific pick resolves NFL via pick context", {
      sport: res.picks[0].sportName,
      method: res.logs.find((l) => l.method === "pick_context")?.method,
    }, { sport: "NFL", method: "pick_context" });
    check("Giants: capper B's unrelated Moneyline pick does NOT inherit capper A's NFL resolution - stays ambiguous", {
      sport: res.picks[1].sportName,
      stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
    }, { sport: "", stillAmbiguous: ["giants"] });
    check("Giants: pick_context log's pickCount reflects only the 1 pick it actually applied to, not the whole batch", {
      pickCount: res.logs.find((l) => l.method === "pick_context")?.pickCount,
    }, { pickCount: 1 });
    check("Giants: pick_context decision is NOT memoized into cross-parse memory (capper-scoped, not key-scoped)", {
      decisions: res.decisions,
    }, { decisions: {} });
  }
  {
    // Same repro, but both picks now come from the SAME capper - the
    // intended "sticks for the rest of this capper's picks" convenience
    // (same one the "Cardinals" case relies on) must still work: capper B's
    // pick above only fell through because it belonged to a different
    // capper, not because same-key inheritance is broken outright.
    const picks = ambiguousBatch(
      "Capper A\nGiants touchdown scorer Barkley\nGiants Moneyline"
    );
    const res = await runAmbiguousHierarchy(picks, {}, {
      runScheduleCheck: fakeSchedule([]),
      now: SEPT,
    });
    check("Giants: same capper's second (contextless) pick DOES inherit their own earlier NFL resolution", {
      sports: res.picks.map((p) => p.sportName),
      stillAmbiguous: res.stillAmbiguous.map((g) => g.key),
    }, { sports: ["NFL", "NFL"], stillAmbiguous: [] });
    check("Giants: same-capper pick_context log reports the true pickCount (2), not per-pick duplicate lines", {
      pickCount: res.logs.find((l) => l.method === "pick_context")?.pickCount,
      logCount: res.logs.filter((l) => l.method === "pick_context").length,
    }, { pickCount: 2, logCount: 1 });
  }
  {
    // The "Giants +6.5" variant from the investigation: a spread pick with
    // no football-specific text of its own (just a number), paired with an
    // unrelated capper's clearly-NFL pick. Same fix applies - no schedule
    // signal either, so nothing else could rescue this one via cross-check.
    const picks = ambiguousBatch(
      "Capper A\nGiants touchdown scorer Barkley\n\nCapper B\nGiants +6.5"
    );
    const res = await runAmbiguousHierarchy(picks, {}, {
      runScheduleCheck: fakeSchedule([]),
      now: SEPT,
    });
    check("Giants +6.5: capper A resolves NFL, capper B's spread pick is untouched by it", {
      capperASport: res.picks[0].sportName,
      capperBResolvedByPickContext: res.picks[1].sportName === "NFL" && res.logs.some((l) => l.method === "pick_context" && l.pickCount > 1),
    }, { capperASport: "NFL", capperBResolvedByPickContext: false });
  }
  {
    // Existing pick_context-reliant coverage (PART C's "Cardinals: both
    // playing but text is NFL-specific -> NFL via pick context", a
    // single-pick/single-capper case) still passes unchanged under the new
    // per-capper scoping - re-asserted here for visibility alongside the
    // new multi-capper cases.
    const res = await runAmbiguousHierarchy([ambiguousPick("Cardinals first-half spread -1.5")], {}, {
      runScheduleCheck: fakeSchedule(["arizona cardinals|NFL", "st. louis cardinals|MLB"]),
      now: SEPT,
    });
    check("Cardinals: single-capper pick-context case is unaffected by the per-capper scoping fix", {
      sport: res.picks[0].sportName,
      method: res.logs[0]?.method,
    }, { sport: "NFL", method: "pick_context" });
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
