// Proof that an ambiguity prompt only offers options that are possible - run with:
//   npx tsx src/lib/ambiguity-impossible-options-acceptance-test.ts
//
// Covers, through the same parseCatalog -> runAmbiguousHierarchy path the
// import uses (fake feed checkers injected, see ambiguous-hierarchy.ts):
//   A. NHL line bounds: the reported lines, and NHL lines that must stay NHL
//   B. the MLB/KBO total max (13 -> 14.5), min and run-line bound unchanged
//   C. real multi-league ambiguity still prompts
//   D. league activity: a league with no game within the window is dropped,
//      moneylines included
//   E. league activity never drops on a failed / empty lookup
//   F. a mascot two feed teams share prompts with the full school names
//
// No test framework exists in this repo (see parse-catalog-acceptance-test.ts's
// header); this file console.logs PASS/FAIL and exits non-zero on any failure.
import { parseCatalog, resolveAmbiguousPick, type ParsedPick } from "./parse-catalog";
import {
  runAmbiguousHierarchy,
  hasGameWithinActivityWindow,
  type HierarchyDeps,
  type LeagueActivityChecker,
  type ScheduleChecker,
} from "./ambiguous-hierarchy";
import { filterPlausibleCandidates } from "./ambiguous-line-plausibility";
import { buildFeedTeams, type FeedTeam } from "./feed-teams";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// `playing` / `scheduled` are `${nickname}|${sport}` keys with a game today /
// anywhere on the posted schedule; everything else has none.
function fakeSchedule(keys: string[] = []): ScheduleChecker {
  const set = new Set(keys);
  return async (queries) => Object.fromEntries(queries.map((q) => [q.nickname + "|" + q.sport, set.has(q.nickname + "|" + q.sport)]));
}

// A league-activity lookup that answers from a fixed table. A league missing
// from the table is left out of the answer ("couldn't tell"), as the real
// lookup does for a league with no feed.
function fakeActivity(table: Record<string, boolean>): LeagueActivityChecker {
  return async (sports) => Object.fromEntries(sports.filter((s) => s in table).map((s) => [s, table[s]]));
}

const ALL_ACTIVE = { MLB: true, NFL: true, NBA: true, NHL: true, WNBA: true, NCAAF: true };
// What the feeds hold in December: no baseball, no WNBA.
const DECEMBER = { MLB: false, NFL: true, NBA: true, NHL: true, WNBA: false, NCAAF: true };

// Early October: MLB, NFL, NHL, WNBA and NCAAF are all inside their calendar
// windows, so the season step settles none of the lines below on its own.
const OCT = new Date("2026-10-06T16:00:00Z");
const DEC = new Date("2026-12-08T17:00:00Z");

type Outcome = { resolved?: string; method?: string; prompt?: string[] };

// One line through parse + hierarchy. `resolved` is "SPORT nickname";
// `prompt` is the option labels still offered.
async function run(
  line: string,
  deps: Partial<HierarchyDeps> = {},
  feedTeams?: FeedTeam[]
): Promise<Outcome | { unresolved: string[] }> {
  const parsed = parseCatalog(`Capper\n${line}`, [], undefined, feedTeams);
  if (parsed.picks.length === 0) return { unresolved: parsed.unresolved };
  const out = await runAmbiguousHierarchy(
    parsed.picks,
    {},
    { runScheduleCheck: fakeSchedule(), runWideScheduleCheck: fakeSchedule(), now: OCT, ...deps }
  );
  const p: ParsedPick = out.picks[0];
  if (p.ambiguous) return { prompt: p.ambiguous.map((o) => o.label) };
  return { resolved: p.sportName + " " + p.teamNicknames.join(","), method: out.logs[0]?.method };
}

async function main() {
  // The hierarchy logs every decision; only PASS/FAIL lines matter here.
  const log = console.log;
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = log;
    }
  };
  const outcome = (line: string, deps: Partial<HierarchyDeps> = {}, feedTeams?: FeedTeam[]) =>
    quiet(() => run(line, deps, feedTeams));

  console.log("########## PART A: NHL line bounds (spread <= 2.5, total 4.5 - 8.5) ##########");
  {
    const active = { runLeagueActivityCheck: fakeActivity(ALL_ACTIVE) };
    check("Panthers o50.5 -> Carolina Panthers (NFL)", await outcome("Panthers o50.5", active), {
      resolved: "NFL carolina panthers",
      method: "plausibility",
    });
    check("Florida o56.5 -> Gators (NCAAF)", await outcome("Florida o56.5", active), {
      resolved: "NCAAF florida gators",
      method: "plausibility",
    });
    check("Colorado +13.5 -> Buffaloes (Rockies and Avalanche both dropped)", await outcome("Colorado +13.5", active), {
      resolved: "NCAAF colorado buffaloes",
      method: "plausibility",
    });
    check("Buffalo +15.5 -> Sabres dropped, Bills / Bulls still a prompt", await outcome("Buffalo +15.5", active), {
      prompt: ["Buffalo Bills (NFL)", "Buffalo Bulls (NCAAF)"],
    });
    check("Minnesota +7.5 -> Wild (and Twins) dropped, four leagues left", await outcome("Minnesota +7.5", active), {
      prompt: [
        "Minnesota Vikings (NFL)",
        "Minnesota Timberwolves (NBA)",
        "Minnesota Lynx (WNBA)",
        "Minnesota Golden Gophers (NCAAF)",
      ],
    });
    check(
      "Minnesota +7.5 with no WNBA games on the feed -> Lynx dropped too",
      await outcome("Minnesota +7.5", { runLeagueActivityCheck: fakeActivity({ ...ALL_ACTIVE, WNBA: false }) }),
      { prompt: ["Minnesota Vikings (NFL)", "Minnesota Timberwolves (NBA)", "Minnesota Golden Gophers (NCAAF)"] }
    );

    // A real NHL line keeps its NHL option.
    const both = { prompt: ["Carolina Panthers (NFL)", "Florida Panthers (NHL)"] };
    check("Panthers -1.5 (puck line) keeps NHL", await outcome("Panthers -1.5", active), both);
    check("Panthers +2.5 (alt puck line) keeps NHL", await outcome("Panthers +2.5", active), both);
    // A hockey total is no NFL total, so these now settle on NHL outright
    // (PART G) rather than merely keeping it on the prompt.
    const nhlPanthers = { resolved: "NHL florida panthers", method: "plausibility" };
    check("Panthers o5.5 keeps NHL", await outcome("Panthers o5.5", active), nhlPanthers);
    check("Panthers u8.5 (max) keeps NHL", await outcome("Panthers u8.5", active), nhlPanthers);
    // The total minimum is a full-game number: a team total or a period total
    // sits below it and must not cost the pick its NHL option.
    check("Panthers TT o2.5 (team total) keeps NHL", await outcome("Panthers TT o2.5", active), nhlPanthers);
    check("Panthers 1P o1.5 (period total) keeps NHL", await outcome("Panthers 1P o1.5", active), both);
    check("Panthers 1st period over 1.5 stays NHL (hockey wording decides it)", await outcome("Panthers 1st period over 1.5", active), {
      resolved: "NHL florida panthers",
      method: "pick_context",
    });

    const nhl = [{ label: "x", sport: "NHL", nickname: "x" }];
    check("NHL spread 2.5 is plausible", filterPlausibleCandidates(nhl, "SPREAD", -2.5).length, 1);
    check("NHL spread 3 is not", filterPlausibleCandidates(nhl, "SPREAD", 3).length, 0);
    check("NHL total 4.5 is plausible", filterPlausibleCandidates(nhl, "TOTAL", 4.5).length, 1);
    check("NHL total 4 is not", filterPlausibleCandidates(nhl, "TOTAL", 4).length, 0);
    check("NHL total 9 is not", filterPlausibleCandidates(nhl, "TOTAL", 9).length, 0);
    check("NHL team total 9 is not (the max still applies)", filterPlausibleCandidates(nhl, "TEAM_TOTAL", 9).length, 0);
    const nfl = [{ label: "x", sport: "NFL", nickname: "x" }];
    check("NFL stays unbounded (spread 40)", filterPlausibleCandidates(nfl, "SPREAD", 40).length, 1);
    check("NFL total 24 is plausible", filterPlausibleCandidates(nfl, "TOTAL", 24).length, 1);
    check("NFL total 23.5 is not", filterPlausibleCandidates(nfl, "TOTAL", 23.5).length, 0);
    check("NFL total 75 is plausible", filterPlausibleCandidates(nfl, "TOTAL", 75).length, 1);
    check("NFL total 75.5 is not", filterPlausibleCandidates(nfl, "TOTAL", 75.5).length, 0);
    check("NFL team total 6 is plausible", filterPlausibleCandidates(nfl, "TEAM_TOTAL", 6).length, 1);
    check("NFL team total 5.5 is not", filterPlausibleCandidates(nfl, "TEAM_TOTAL", 5.5).length, 0);
    check("NFL partial-game total 3 is plausible (no floor on a quarter/half)", filterPlausibleCandidates(nfl, "TOTAL", 3, true).length, 1);
  }

  console.log("\n########## PART B: MLB / KBO total max 14.5 ##########");
  {
    for (const sport of ["MLB", "KBO"]) {
      const c = [{ label: "x", sport, nickname: "x" }];
      check(`${sport} total 14.5 is plausible`, filterPlausibleCandidates(c, "TOTAL", 14.5).length, 1);
      check(`${sport} total 15 is not`, filterPlausibleCandidates(c, "TOTAL", 15).length, 0);
      check(`${sport} total min 4 unchanged`, filterPlausibleCandidates(c, "TOTAL", 4).length, 1);
      check(`${sport} total 3.5 still not plausible`, filterPlausibleCandidates(c, "TOTAL", 3.5).length, 0);
      check(`${sport} spread 2.5 unchanged`, filterPlausibleCandidates(c, "SPREAD", 2.5).length, 1);
      check(`${sport} spread 3 still not plausible`, filterPlausibleCandidates(c, "SPREAD", -3).length, 0);
      check(`${sport} has no spread floor (-1)`, filterPlausibleCandidates(c, "SPREAD", -1).length, 1);
    }
    check("Rangers o14 -> Texas Rangers (was the NHL Rangers at max 13)", await outcome("Rangers o14"), {
      resolved: "MLB texas rangers",
      method: "plausibility",
    });
  }

  console.log("\n########## PART C: real multi-league ambiguity still prompts ##########");
  {
    check(
      "Miami -14.5 in season -> NFL / NBA / NCAAF prompt (only the Marlins dropped)",
      await outcome("Miami -14.5", { runLeagueActivityCheck: fakeActivity(ALL_ACTIVE) }),
      { prompt: ["Miami Dolphins (NFL)", "Miami Heat (NBA)", "Miami Hurricanes (NCAAF)"] }
    );
  }

  console.log("\n########## PART D: league activity (no games within 7 days -> dropped) ##########");
  {
    const december = { runLeagueActivityCheck: fakeActivity(DECEMBER), now: DEC };
    check("Rangers ML, no MLB games -> New York Rangers", await outcome("Rangers ML", december), {
      resolved: "NHL new york rangers",
      method: "league_activity",
    });
    check("Boston ML, no MLB games -> Red Sox dropped, Celtics / Bruins still a prompt", await outcome("Boston ML", december), {
      prompt: ["Boston Celtics (NBA)", "Boston Bruins (NHL)"],
    });
    check(
      "Rangers ML with every league active -> unchanged prompt",
      await outcome("Rangers ML", { runLeagueActivityCheck: fakeActivity(ALL_ACTIVE) }),
      { prompt: ["Texas Rangers (MLB)", "New York Rangers (NHL)"] }
    );
    // The filter runs first, so the schedule step never sees the dropped
    // league: a stale "has a game" answer for it can't bring it back.
    check(
      "Rangers ML, no MLB games, schedule check claims a Texas Rangers game -> still New York Rangers",
      await outcome("Rangers ML", { ...december, runScheduleCheck: fakeSchedule(["texas rangers|MLB"]) }),
      { resolved: "NHL new york rangers", method: "league_activity" }
    );
    // One league left is still checked against the pick's own line.
    check(
      "Rangers o14, no MLB games -> not forced onto the NHL Rangers; full prompt",
      await outcome("Rangers o14", december),
      { prompt: ["Texas Rangers (MLB)", "New York Rangers (NHL)"] }
    );
    // A league the lookup can't speak to (KBO has no feed) is never dropped,
    // and is never auto-picked by this step just for being the one left.
    const tigers = await outcome("Tigers ML", { runLeagueActivityCheck: fakeActivity({ MLB: true }), now: OCT });
    check("Tigers ML, MLB active, KBO unknown -> both kept", tigers, {
      prompt: ["Detroit Tigers (MLB)", "KIA Tigers (KBO)"],
    });
    const tigersDec = (await outcome("Tigers ML", { runLeagueActivityCheck: fakeActivity({ MLB: false, NFL: true }), now: OCT })) as Outcome;
    check("Tigers ML, no MLB games, KBO unknown -> not resolved by league_activity", tigersDec.method === "league_activity", false);

    const day = 24 * 60 * 60 * 1000;
    const at = (offsetDays: number) => [{ commenceTime: new Date(OCT.getTime() + offsetDays * day).toISOString() }];
    check("a game 7 days out is inside the window", hasGameWithinActivityWindow(at(7), OCT), true);
    check("a game 6 days back is inside the window", hasGameWithinActivityWindow(at(-6), OCT), true);
    check("a game 8 days out is outside it", hasGameWithinActivityWindow(at(8), OCT), false);
    check("a game 8 days back is outside it", hasGameWithinActivityWindow(at(-8), OCT), false);
    check("no games -> not active", hasGameWithinActivityWindow([], OCT), false);
  }

  console.log("\n########## PART E: a failed or empty lookup drops nothing ##########");
  {
    const full = { prompt: ["Texas Rangers (MLB)", "New York Rangers (NHL)"] };
    const throwing: LeagueActivityChecker = async () => {
      throw new Error("feed down");
    };
    check("lookup throws -> every option kept", await outcome("Rangers ML", { runLeagueActivityCheck: throwing }), full);
    check("lookup returns nothing -> every option kept", await outcome("Rangers ML", { runLeagueActivityCheck: fakeActivity({}) }), full);
    check(
      "lookup finds no game for ANY league -> every option kept",
      await outcome("Rangers ML", {
        runLeagueActivityCheck: fakeActivity({ MLB: false, NFL: false, NBA: false, NHL: false, WNBA: false, NCAAF: false }),
      }),
      full
    );
    check("no lookup wired at all -> every option kept", await outcome("Rangers ML"), full);
    // Every candidate of this key inactive, another league active: the key
    // keeps its options rather than being emptied.
    check(
      "every candidate league inactive -> the key keeps all its options",
      await outcome("Rangers ML", { runLeagueActivityCheck: fakeActivity({ MLB: false, NHL: false, NFL: true }) }),
      full
    );
    check(
      "lookup throws -> line bounds still apply (Panthers o50.5 -> NFL)",
      await outcome("Panthers o50.5", { runLeagueActivityCheck: throwing }),
      { resolved: "NFL carolina panthers", method: "plausibility" }
    );
  }

  console.log("\n########## PART F: a mascot two feed teams share ##########");
  {
    const KICKOFF = "2026-10-10T19:00:00Z";
    const game = (awayTeam: string, awayLocation: string, homeTeam: string, homeLocation: string) => ({
      awayTeam,
      awayLocation,
      homeTeam,
      homeLocation,
      commenceTime: KICKOFF,
    });
    const feedTeams = buildFeedTeams("NCAAF", [
      game("Idaho Vandals", "Idaho", "Montana State Bobcats", "Montana State"),
      game("Ohio Bobcats", "Ohio", "Akron Zips", "Akron"),
    ]);
    const bobcats = { prompt: ["Montana State Bobcats (NCAAF)", "Ohio Bobcats (NCAAF)"] };
    const bothPlaying = {
      runScheduleCheck: fakeSchedule(["montana state bobcats|NCAAF", "ohio bobcats|NCAAF"]),
      runLeagueActivityCheck: fakeActivity(ALL_ACTIVE),
    };

    check("Bobcats ML, no feed teams -> unresolved (unchanged)", await outcome("Bobcats ML"), { unresolved: ["Bobcats ML"] });
    check("Bobcats ML -> prompt with both schools", await outcome("Bobcats ML", bothPlaying, feedTeams), bobcats);
    check("Bobcats -3.5 -> prompt with both schools", await outcome("Bobcats -3.5", bothPlaying, feedTeams), bobcats);
    // Only one plays today, the other later in the week: the existing
    // tiebreaker keeps it a prompt.
    check(
      "Bobcats ML, one plays today and the other Saturday -> still a prompt",
      await outcome(
        "Bobcats ML",
        {
          runScheduleCheck: fakeSchedule(["ohio bobcats|NCAAF"]),
          runWideScheduleCheck: fakeSchedule(["montana state bobcats|NCAAF"]),
        },
        feedTeams
      ),
      bobcats
    );

    const pick = parseCatalog("Capper\nBobcats -3.5", [], undefined, feedTeams).picks[0];
    check("the pick's key is the mascot", pick.ambiguousKey, "bobcats");
    const chosen = resolveAmbiguousPick(pick, pick.ambiguous![0]);
    check(
      "choosing Montana State resolves to the full feed name",
      { sport: chosen.sportName, team: chosen.teamNicknames, betType: chosen.betType, ambiguous: chosen.ambiguous },
      { sport: "NCAAF", team: ["montana state bobcats"], betType: "SPREAD" }
    );
    const remembered = await quiet(() =>
      runAmbiguousHierarchy(parseCatalog("Capper\nBobcats ML", [], undefined, feedTeams).picks, { bobcats: pick.ambiguous![1] }, {
        runScheduleCheck: fakeSchedule(),
        runWideScheduleCheck: fakeSchedule(),
        now: OCT,
      })
    );
    check("an earlier answer in the same import is remembered", remembered.picks[0].teamNicknames, ["ohio bobcats"]);

    const inline = parseCatalog("SharpGuy: Bobcats -3.5", ["SharpGuy"], undefined, feedTeams);
    check(
      "inline capper form prompts too",
      { capper: inline.picks[0]?.capperName, options: inline.picks[0]?.ambiguous?.map((o) => o.label), unresolved: inline.unresolved },
      { capper: "SharpGuy", options: bobcats.prompt, unresolved: [] }
    );

    // Everything the feed already read is untouched.
    check("a mascot only one feed team has still resolves directly", await outcome("Vandals ML", {}, feedTeams), {
      resolved: "NCAAF idaho vandals",
    });
    check("a school name still resolves directly", await outcome("Montana State -14.5", {}, feedTeams), {
      resolved: "NCAAF montana state",
    });
    check("a shared mascot inside a longer name is not a hit", await outcome("Bobcats Brewing ML", {}, feedTeams), {
      unresolved: ["Bobcats Brewing ML"],
    });
  }

  console.log("\n########## PART G: over/under lines are checked against TOTAL bounds, NFL included ##########");
  {
    const active = { runLeagueActivityCheck: fakeActivity(ALL_ACTIVE) };
    const playing = (...keys: string[]) => ({
      ...active,
      runScheduleCheck: fakeSchedule(keys),
      runWideScheduleCheck: fakeSchedule(keys),
    });
    const bothJets = playing("new york jets|NFL", "winnipeg jets|NHL");

    // The unresolved pick stores a SPREAD placeholder; the line is checked
    // against the bet type parsed from its own text, not that placeholder.
    const jets = parseCatalog("Capper\nJets over 6.5").picks[0];
    check(
      "Jets over 6.5: stored market is the SPREAD placeholder, plausibility reads TOTAL 6.5",
      { stored: jets.betType, checkedAs: jets.ambiguousBetType, line: jets.ambiguousLine },
      { stored: "SPREAD", checkedAs: "TOTAL", line: 6.5 }
    );
    check(
      "a 6.5 TOTAL drops NFL; the same 6.5 as a SPREAD drops NHL instead",
      {
        total: filterPlausibleCandidates(jets.ambiguous!, "TOTAL", 6.5).map((o) => o.sport),
        spread: filterPlausibleCandidates(jets.ambiguous!, "SPREAD", 6.5).map((o) => o.sport),
      },
      { total: ["NHL"], spread: ["NFL"] }
    );

    check("Jets over 6.5, both Jets play today -> NHL, no prompt", await outcome("Jets over 6.5", bothJets), {
      resolved: "NHL winnipeg jets",
      method: "plausibility",
    });
    check("Jets over 6.5, neither plays today -> NHL, no prompt", await outcome("Jets over 6.5", active), {
      resolved: "NHL winnipeg jets",
      method: "plausibility",
    });
    check("Jets over 44.5 -> NFL, no prompt", await outcome("Jets over 44.5", bothJets), {
      resolved: "NFL new york jets",
      method: "plausibility",
    });
    check("Jets u5.5 -> NHL, no prompt", await outcome("Jets u5.5", bothJets), {
      resolved: "NHL winnipeg jets",
      method: "plausibility",
    });
    // Unchanged from #196: +6.5 is past the NHL puck-line bound, so the line
    // leaves NFL alone and nothing disagrees.
    check("Jets +6.5 -> NFL (NHL puck line is +/-1.5)", await outcome("Jets +6.5", bothJets), {
      resolved: "NFL new york jets",
      method: "plausibility",
    });
    check("Jets +1.5 -> plausible for both, still a prompt", await outcome("Jets +1.5", bothJets), {
      prompt: ["New York Jets (NFL)", "Winnipeg Jets (NHL)"],
    });
    const cardinalsDay = playing("arizona cardinals|NFL", "st. louis cardinals|MLB");
    check("Cardinals over 47.5 -> NFL, no prompt", await outcome("Cardinals over 47.5", cardinalsDay), {
      resolved: "NFL arizona cardinals",
      method: "plausibility",
    });
    // Pick context already read this as baseball before NFL totals were
    // bounded; the line now agrees with it.
    check("Cardinals over 8.5 -> MLB, no prompt", await outcome("Cardinals over 8.5", cardinalsDay), {
      resolved: "MLB st. louis cardinals",
      method: "pick_context",
    });

    // Another signal disagreeing still prompts: only the NFL Jets play today,
    // and the line says NHL.
    check("Jets over 6.5, only the NFL Jets play today -> conflict, prompt", await outcome("Jets over 6.5", playing("new york jets|NFL")), {
      prompt: ["Winnipeg Jets (NHL)"],
    });

    // Giants: the line drops NFL but leaves MLB and KBO. The schedule then
    // settles it among those two - and only when it can.
    const giantsDay = playing("new york giants|NFL", "san francisco giants|MLB");
    check("Giants over 8.5, NFL and MLB both play today -> MLB, no prompt", await outcome("Giants over 8.5", giantsDay), {
      resolved: "MLB san francisco giants",
      method: "plausibility",
    });
    check("Giants over 8.5, nobody plays today -> NFL dropped, MLB / KBO prompt", await outcome("Giants over 8.5", active), {
      prompt: ["San Francisco Giants (MLB)", "Lotte Giants (KBO)"],
    });
    check(
      "Giants over 8.5, the other survivor has a game later this week -> prompt",
      await outcome("Giants over 8.5", { ...giantsDay, runWideScheduleCheck: fakeSchedule(["lotte giants|KBO"]) }),
      { prompt: ["San Francisco Giants (MLB)", "Lotte Giants (KBO)"] }
    );
    check("Giants over 44.5 -> NFL, no prompt", await outcome("Giants over 44.5", giantsDay), {
      resolved: "NFL new york giants",
      method: "plausibility",
    });

    // Team totals and partial-game totals.
    check("Jets TT over 2.5 -> NHL (below any NFL team total)", await outcome("Jets TT over 2.5", bothJets), {
      resolved: "NHL winnipeg jets",
      method: "plausibility",
    });
    check("Jets TT over 20.5 -> NFL", await outcome("Jets TT over 20.5", bothJets), {
      resolved: "NFL new york jets",
      method: "plausibility",
    });
    check("Jets 1H over 20.5 -> NFL (the NFL game minimum is not applied to a half)", await outcome("Jets 1H over 20.5", bothJets), {
      resolved: "NFL new york jets",
      method: "plausibility",
    });
    check("Jets 1Q over 6.5 -> plausible for both, still a prompt", await outcome("Jets 1Q over 6.5", bothJets), {
      prompt: ["New York Jets (NFL)", "Winnipeg Jets (NHL)"],
    });
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
