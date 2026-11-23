// Live-game matching and the far-future threshold at catalog import (2026-11-23). Pure: no DB, no network - the
// feeds are fixtures and the hierarchy's schedule checkers are fakes. Run with:
//   npx tsx src/server/data/import-live-game-match-acceptance-test.ts
//
// The bug: an Oklahoma State line entered while OSU's basketball game was live was filed as the next football game.
// For a school NCAAF and NCAAB share, the hierarchy's schedule step only counted games not yet STARTED
// (ResolveGameOpts.upcomingOnly), so the live basketball game did not count and football won. Now:
//   - a game in progress decides the league outright (HierarchyDeps.runInProgressCheck);
//   - upcomingOnly drops only FINAL games;
//   - the game resolver itself already matched live games - pinned here, with doubleheaders (#121) and the
//     late-import roll-forward (#105), so neither regresses.
// Far future: lib/far-future-game.ts, one threshold per sport (daily leagues 36 h, NFL / NCAAF 8 days).
import { resolveScheduleGameFromFeeds, isInProgressAt, type ScoreGame } from "@/server/data/odds";
import { teamNameEndsWith } from "@/lib/team-name-match";
import { parseCatalog, TEAM_NICKNAME_CANONICAL, type ParsedPick } from "@/lib/parse-catalog";
import { NCAAB_LISTED_TEAMS } from "@/lib/college-teams";
import { runAmbiguousHierarchy, type ScheduleChecker } from "@/lib/ambiguous-hierarchy";
import { isFarFutureGame, farFutureHoursFor, farFutureWarning, FAR_FUTURE_HOURS_BY_SPORT } from "@/lib/far-future-game";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const H = 3600000;
const score = (
  id: string,
  home: string,
  away: string,
  commenceTime: string,
  status: ScoreGame["status"],
  dh?: { doubleHeaderStatus: "Y" | "S" | "N"; gameNumber: number }
): ScoreGame => ({
  id,
  homeTeam: home,
  awayTeam: away,
  status,
  scores: null,
  commenceTime,
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
  ...(dh ?? {}),
});
const team = (sportKey: string, nickname: string) => (g: { homeTeam: string; awayTeam: string }) =>
  teamNameEndsWith(g.homeTeam, nickname, sportKey) || teamNameEndsWith(g.awayTeam, nickname, sportKey);
const iso = (t: number) => new Date(t).toISOString();

async function main() {
  // Tue 2026-11-24 9:00 PM ET - an evening import.
  const NOW = Date.parse("2026-11-25T02:00:00Z");
  const now = new Date(NOW);

  // ---- 1. isInProgressAt --------------------------------------------------------------------------------------------
  expect("live status is in progress", isInProgressAt({ status: "live", commenceTime: iso(NOW - H) }, now), true);
  expect("preview whose start passed (feed lag) is in progress", isInProgressAt({ status: "preview", commenceTime: iso(NOW - 10 * 60000) }, now), true);
  expect("preview not started is not", isInProgressAt({ status: "preview", commenceTime: iso(NOW + H) }, now), false);
  expect("a stale preview from 7 h ago is not", isInProgressAt({ status: "preview", commenceTime: iso(NOW - 7 * H) }, now), false);
  expect("final is not", isInProgressAt({ status: "final", commenceTime: iso(NOW - 2 * H) }, now), false);

  // ---- 2. Live game match -------------------------------------------------------------------------------------------
  {
    const NBA = "basketball_nba";
    const feed = [
      score("live", "Denver Nuggets", "Phoenix Suns", iso(NOW - H), "live"),
      score("next", "Phoenix Suns", "Utah Jazz", iso(NOW + 22 * H), "preview"),
    ];
    const r = resolveScheduleGameFromFeeds(feed, [], team(NBA, "suns"), now);
    expect("live game match: the game in progress, not the next one", r.game?.id, "live");
    expect("live game match: nothing skipped", r.skippedCurrent, undefined);
    const ingest = resolveScheduleGameFromFeeds(feed, [], team(NBA, "suns"), now, null, [], { excludeFinal: true, sportKey: NBA });
    expect("live game match, real-time ingest: also the live game", ingest.game?.id, "live");
  }

  // ---- 3. Live + doubleheader (#121) --------------------------------------------------------------------------------
  {
    const MLB = "baseball_mlb";
    const g1 = score("g1", "Chicago Cubs", "St. Louis Cardinals", iso(NOW - 2 * H), "live", { doubleHeaderStatus: "S", gameNumber: 1 });
    const g2 = score("g2", "Chicago Cubs", "St. Louis Cardinals", iso(NOW + 2 * H), "preview", { doubleHeaderStatus: "S", gameNumber: 2 });
    const feed = [g1, g2];
    expect("live + doubleheader: a bare pick is the live leg (earliest not final)", resolveScheduleGameFromFeeds(feed, [], team(MLB, "cubs"), now).game?.id, "g1");
    expect("live + doubleheader: 'Game 2' is still game 2", resolveScheduleGameFromFeeds(feed, [], team(MLB, "cubs"), now, 2).game?.id, "g2");
    expect("live + doubleheader: 'Game 1' is the live leg", resolveScheduleGameFromFeeds(feed, [], team(MLB, "cubs"), now, 1).game?.id, "g1");
    const g1Final = { ...g1, status: "final" as const };
    expect(
      "doubleheader, game 1 final: a bare pick rolls to game 2, as before",
      resolveScheduleGameFromFeeds([g1Final, g2], [], team(MLB, "cubs"), now).game?.id,
      "g2"
    );
    expect(
      "doubleheader, both legs final: still the both-final message, as before",
      resolveScheduleGameFromFeeds([g1Final, { ...g2, status: "final" as const }], [], team(MLB, "cubs"), now).doubleheaderBothLegsFinal,
      true
    );
  }

  // ---- 4. A final game rolls to the next one (#105 kept) ------------------------------------------------------------
  {
    const NBA = "basketball_nba";
    const yesterdayFinal = score("y", "Boston Celtics", "Miami Heat", iso(NOW - 24 * H), "final");
    const tomorrow = score("t", "Miami Heat", "Orlando Magic", iso(NOW + 22 * H), "preview");
    const r = resolveScheduleGameFromFeeds([yesterdayFinal, tomorrow], [], team(NBA, "heat"), now);
    expect("final game from an earlier slate day rolls to the next game", r.game?.id, "t");
    expect("rolling past an earlier day's final is not logged as skipping the current game", r.skippedCurrent, undefined);

    const todayFinal = score("f", "Boston Celtics", "Miami Heat", iso(NOW - 3 * H), "final");
    expect(
      "manual paste: today's just-finished game still wins (late import, #105)",
      resolveScheduleGameFromFeeds([todayFinal, tomorrow], [], team(NBA, "heat"), now).game?.id,
      "f"
    );
    const ingest = resolveScheduleGameFromFeeds([todayFinal, tomorrow], [], team(NBA, "heat"), now, null, [], { excludeFinal: true, sportKey: NBA });
    expect("real-time ingest: today's final is out, so the next game", ingest.game?.id, "t");
    expect(
      "real-time ingest: skipping today's final is reported for the log",
      ingest.skippedCurrent && { status: ingest.skippedCurrent.status, at: ingest.skippedCurrent.commenceTime },
      { status: "final", at: todayFinal.commenceTime }
    );
  }

  // ---- 5. Oklahoma State: NCAAB live, NCAAF upcoming -> the live NCAAB game -----------------------------------------
  {
    // A fresh parse per run: runAmbiguousHierarchy writes its answers into the array it is given.
    const parse = (): ParsedPick[] => parseCatalog("Sharp\nOklahoma State -3.5\n", ["Sharp"], undefined, NCAAB_LISTED_TEAMS).picks;
    expect("Oklahoma State parses as the school (the hierarchy asks NCAAF or NCAAB)", parse().map((p) => p.teamNicknames), [["oklahoma state"]]);
    // NCAAB tipped off an hour ago; football plays Saturday. Both have a "game" for the plain and upcoming checks.
    const asked: string[] = [];
    const playing: ScheduleChecker = async (qs) => {
      qs.forEach((q) => asked.push(q.sport));
      return Object.fromEntries(qs.map((q) => [q.nickname + "|" + q.sport, true]));
    };
    const live: ScheduleChecker = async (qs) => Object.fromEntries(qs.map((q) => [q.nickname + "|" + q.sport, q.sport === "NCAAB"]));
    const log = console.log;
    console.log = () => {};
    const withLive = await runAmbiguousHierarchy(parse(), {}, { runScheduleCheck: playing, runWideScheduleCheck: playing, runInProgressCheck: live, now });
    const withoutLive = await runAmbiguousHierarchy(parse(), {}, { runScheduleCheck: playing, runWideScheduleCheck: playing, now });
    console.log = log;
    expect("the schedule question covers both leagues", [...new Set(asked)].sort(), ["NCAAB", "NCAAF"]);
    const resolved = withLive.picks[0];
    expect("Oklahoma State, NCAAB game live: resolved to NCAAB, no prompt", [resolved.ambiguous ? "PROMPT" : resolved.sportName], ["NCAAB"]);
    expect("the decision says why", withLive.logs.map((l) => l.method + ": " + l.resolvedSport), ["schedule: NCAAB"]);
    expect("without the in-progress signal the same line is not auto-filed as NCAAB", withoutLive.picks[0].sportName === "NCAAB" && !withoutLive.picks[0].ambiguous, false);

    // Then the game: the live NCAAB game, not OSU's next basketball game.
    const NCAAB = "basketball_ncaab";
    const feed = [
      score("osu-live", "Oklahoma State Cowboys", "Tulsa Golden Hurricane", iso(NOW - H), "live"),
      score("osu-next", "Wichita State Shockers", "Oklahoma State Cowboys", iso(NOW + 48 * H), "preview"),
    ];
    // The import maps a school key to its canonical mascot name first (bulk-import-core, TEAM_NICKNAME_CANONICAL).
    const nick = TEAM_NICKNAME_CANONICAL[resolved.teamNicknames[0]] ?? resolved.teamNicknames[0];
    expect("the NCAAB nickname matches the feed's Oklahoma State", team(NCAAB, nick)(feed[0]), true);
    expect("Oklahoma State pick attaches to the live NCAAB game", resolveScheduleGameFromFeeds(feed, [], team(NCAAB, nick), now).game?.id, "osu-live");
  }

  // ---- 6. Far-future threshold, per sport ---------------------------------------------------------------------------
  expect("the map", FAR_FUTURE_HOURS_BY_SPORT, { NBA: 36, NHL: 36, MLB: 36, NCAAB: 36, WNBA: 36, NFL: 192, NCAAF: 192 });
  expect("NFL 5 days out: no flag", isFarFutureGame("NFL", iso(NOW + 5 * 24 * H), NOW), false);
  expect("NBA 3 days out: flag", isFarFutureGame("NBA", iso(NOW + 3 * 24 * H), NOW), true);
  expect("NBA 30 h out (within the threshold): no flag", isFarFutureGame("NBA", iso(NOW + 30 * H), NOW), false);
  expect("NHL exactly 36 h out: no flag (strictly beyond)", isFarFutureGame("NHL", iso(NOW + 36 * H), NOW), false);
  expect("NCAAF 9 days out: flag", isFarFutureGame("NCAAF", iso(NOW + 9 * 24 * H), NOW), true);
  expect("NCAAF 7 days out: no flag", isFarFutureGame("NCAAF", iso(NOW + 7 * 24 * H), NOW), false);
  expect("a sport with no entry gets 36 h", farFutureHoursFor("KBO"), 36);
  expect("sport labels are case-insensitive", farFutureHoursFor("nfl"), 192);
  expect(
    "the warning names the days and the date",
    farFutureWarning(iso(Date.parse("2026-11-28T00:30:00Z")), NOW),
    "Game is 3 days away: Fri, Nov 27, 7:30 PM. Is this the right game?"
  );

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
