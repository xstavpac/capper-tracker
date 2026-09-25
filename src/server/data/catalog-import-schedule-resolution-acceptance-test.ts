// Proof for catalog-import game resolution over the two schedule feeds -
// run with:
//   npx tsx src/server/data/catalog-import-schedule-resolution-acceptance-test.ts
//
// The bug (investigated 2026-09-08): resolveGameForNickname / resolveGameForTeams
// only ever matched against getLiveScoresForSport, whose ESPN feed spans just
// ~yesterday..tomorrow. A weekly-sport capper posts a whole weekend's slate
// 2-4 days ahead, so every pick past the next ~24h silently failed to import
// ("Couldn't match N picks... NOT imported"). The full posted schedule was
// already in the system (the OddsSnapshot / odds feed).
//
// The fix: resolveScheduleGameFromFeeds - score feed first (authoritative for
// anything live/now), full odds feed as the fallback when the score feed has
// no upcoming match. This exercises the pure core directly; the async wrapper
// resolveScheduleGame just supplies real getLiveScoresForSport / getOddsForSport.
//
// A second bug (investigated 2026-09-23): resolveScheduleGameFromFeeds used
// to strip every FINAL game out of the score feed up front, before its
// same-slate-day preference ever ran, as long as any non-final game for that
// team existed anywhere in the ~yesterday..tomorrow window. For an MLB
// series (or any back-to-back), that meant a pick imported after today's
// game ended silently attached to tomorrow's game instead - it sat Pending
// waiting for a game the capper never picked, then graded against the wrong
// date/line/result. The fix: a same-slate-day score-feed match now wins
// outright, finished or not, before the finals-are-excluded fallback logic
// ever runs (see "the newly reported bug" below). Two follow-ups landed with
// it: a doubleheader guard (pickBestScheduleCandidate refuses to guess, and
// the pick surfaces on the import review screen instead, when the same-day
// pool for one matchup has both a finished and an unfinished game) and a
// slate-day boundary that rolls over at 6am ET instead of literal midnight,
// so a late-night import (Central time or later) or a West-Coast game ending
// after midnight ET still counts as "today" (see "slate-day boundary"
// below).
//
// No test framework in this repo (see odds-preseason-merge-acceptance-test.ts).
import { resolveScheduleGameFromFeeds, pickBestScheduleCandidate } from "./odds";
import type { OddsGame, ScoreGame } from "./odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}
function checkTrue(label: string, actual: boolean) {
  console.log(`${actual ? "PASS" : "FAIL"}: ${label}`);
  if (!actual) failures++;
}

// A Monday-evening ET import instant. All the game dates below are expressed
// relative to this so the ±7 Eastern-calendar-day window is deterministic.
const MON = new Date("2026-09-07T22:00:00-04:00"); // Mon Sep 7 2026, 10pm ET
const dayISO = (etDay: number, hourUtc = 17) =>
  `2026-09-${String(7 + etDay).padStart(2, "0")}T${String(hourUtc).padStart(2, "0")}:00:00Z`;

const score = (
  home: string,
  away: string,
  etDay: number,
  status: ScoreGame["status"] = "preview",
  id = `score-${home}-${away}-${etDay}`
): ScoreGame => ({
  id,
  homeTeam: home,
  awayTeam: away,
  status,
  scores: status === "preview" ? null : [{ name: home, score: "0" }, { name: away, score: "0" }],
  commenceTime: dayISO(etDay),
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
});

// MLB-only fields (see ScoreGame's own comment) - a separate builder rather
// than adding params to score() above, since every existing call site in
// this file represents a non-MLB or non-doubleheader game and must keep
// getting gameNumber/doubleHeaderStatus undefined (the "no metadata"
// default), not silently start carrying null.
const mlbGame = (
  home: string,
  away: string,
  hourUtc: number,
  gameNumber: 1 | 2,
  doubleHeaderStatus: "Y" | "S",
  status: ScoreGame["status"] = "preview",
  id = `${home}-${away}-g${gameNumber}`
): ScoreGame => ({
  id,
  homeTeam: home,
  awayTeam: away,
  status,
  scores: status === "preview" ? null : [{ name: home, score: "0" }, { name: away, score: "0" }],
  commenceTime: dayISO(0, hourUtc),
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
  gameNumber,
  doubleHeaderStatus,
});

const odds = (home: string, away: string, etDay: number, id = `odds-${home}-${away}-${etDay}`): OddsGame => ({
  id,
  sportKey: "americanfootball_nfl",
  homeTeam: home,
  awayTeam: away,
  commenceTime: dayISO(etDay),
  bookmakers: [],
});

const endsWith = (nick: string) => (g: { homeTeam: string; awayTeam: string }) =>
  g.homeTeam.toLowerCase().endsWith(nick) || g.awayTeam.toLowerCase().endsWith(nick);

// ---------------------------------------------------------------------------
console.log("########## the reported failure: an advance-posted NFL slate ##########");
{
  // Monday paste. Score feed = Sun..Tue only (the NFL Kickoff game). Odds
  // feed = the full posted week.
  const scores = [score("Seattle Seahawks", "New England Patriots", 2 /* Wed */)];
  const oddsFeed = [
    odds("Seattle Seahawks", "New England Patriots", 2),
    odds("Cincinnati Bengals", "Tampa Bay Buccaneers", 6 /* Sun */),
    odds("Los Angeles Chargers", "Arizona Cardinals", 6),
    odds("Kansas City Chiefs", "Denver Broncos", 7 /* Mon */),
  ];

  // Before the fix: score feed has no "buccaneers" match and the odds feed
  // was never consulted -> null -> pick dropped as unmatched.
  const bucs = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("buccaneers"), MON);
  check("Sunday Bucs pick (+6d) now resolves via the odds feed", bucs?.homeTeam, "Cincinnati Bengals");
  check("  ...to the right game", bucs?.awayTeam, "Tampa Bay Buccaneers");

  const chiefs = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("chiefs"), MON);
  check("Monday-night Chiefs pick (+7d, window edge) resolves", chiefs?.homeTeam, "Kansas City Chiefs");

  // The in-window score-feed game is unchanged - still resolved from the
  // score feed (its id), not the odds feed.
  const opener = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("seahawks"), MON);
  check("the Wed opener still resolves from the SCORE feed", opener?.id, "score-Seattle Seahawks-New England Patriots-2");
}

// ---------------------------------------------------------------------------
console.log("\n########## NCAAF: same shape, weekend slate posted mid-week ##########");
{
  const wed = new Date("2026-09-09T20:00:00-04:00");
  const scores: ScoreGame[] = []; // nothing in the Tue..Thu window
  const oddsFeed = [
    { ...odds("Alabama Crimson Tide", "Wisconsin Badgers", 4), sportKey: "americanfootball_ncaaf" },
    { ...odds("Georgia Bulldogs", "Clemson Tigers", 4), sportKey: "americanfootball_ncaaf" },
  ];
  const bama = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("crimson tide"), wed);
  check("weekend Alabama pick resolves via odds feed", bama?.homeTeam, "Alabama Crimson Tide");
  check("odds-feed game carries a 'preview' status", bama?.status, "preview");
  checkTrue("odds-feed game has no live scores", bama?.scores === null);
}

// ---------------------------------------------------------------------------
console.log("\n########## daily sport (MLB): near game unchanged, +3d now works ##########");
{
  // Score feed has tomorrow's Dodgers game; odds feed has it plus two more.
  const scores = [score("Los Angeles Dodgers", "San Diego Padres", 1)];
  const oddsFeed = [
    odds("Los Angeles Dodgers", "San Diego Padres", 1),
    odds("Los Angeles Dodgers", "San Diego Padres", 2),
    odds("Los Angeles Dodgers", "San Francisco Giants", 4),
  ];

  const dodgers = resolveScheduleGameFromFeeds(scores, oddsFeed, endsWith("dodgers"), MON);
  check("MLB near game still resolves from the SCORE feed (not odds)", dodgers?.id, "score-Los Angeles Dodgers-San Diego Padres-1");

  // A pick for the Friday series opener (+4d) - not in the score feed at all.
  const scoresEmpty: ScoreGame[] = [];
  const fri = resolveScheduleGameFromFeeds(scoresEmpty, oddsFeed, endsWith("giants"), MON);
  check("MLB +4d pick resolves via odds feed", fri?.awayTeam, "San Francisco Giants");

  // Repeated matchup, score feed empty: prefer the one nearest the import.
  const seriesOnly = oddsFeed.filter((g) => g.awayTeam === "San Diego Padres");
  const nearest = resolveScheduleGameFromFeeds([], seriesOnly, endsWith("padres"), MON);
  check("repeated MLB matchup in odds feed -> closest to import time", nearest?.commenceTime, dayISO(1));
}

// ---------------------------------------------------------------------------
console.log("\n########## guardrails: window edge + fallback-not-merge ##########");
{
  const oddsFeed = [odds("Cincinnati Bengals", "Tampa Bay Buccaneers", 10 /* +10d */)];
  const tooFar = resolveScheduleGameFromFeeds([], oddsFeed, endsWith("buccaneers"), MON);
  check("a game +10d out (past the 7-day window) still does NOT resolve", tooFar, null);

  // Same team, same day, in BOTH feeds - must not be doubled / must return
  // the score-feed row (its id), the odds row is ignored.
  const both = resolveScheduleGameFromFeeds(
    [score("Kansas City Chiefs", "Los Angeles Chargers", 0, "preview", "SCORE_ID")],
    [odds("Kansas City Chiefs", "Los Angeles Chargers", 0, "ODDS_ID")],
    endsWith("chiefs"),
    MON
  );
  check("game in both feeds -> the SCORE feed row wins (fallback, not merge)", both?.id, "SCORE_ID");

  // Score feed's only match already FINAL, an upcoming game exists in the
  // odds feed -> the upcoming game is the better guess.
  const nextWeek = resolveScheduleGameFromFeeds(
    [score("Buffalo Bills", "Baltimore Ravens", -1, "final", "FINAL_ID")],
    [odds("Miami Dolphins", "Buffalo Bills", 6)],
    endsWith("bills"),
    MON
  );
  check("score feed only has a FINISHED game -> use the upcoming odds game", nextWeek?.homeTeam, "Miami Dolphins");

  // ...but if nothing is upcoming anywhere, the finished score-feed game is
  // still returned (logging a pick right after its game).
  const justEnded = resolveScheduleGameFromFeeds(
    [score("Buffalo Bills", "Baltimore Ravens", -1, "final", "FINAL_ID")],
    [],
    endsWith("bills"),
    MON
  );
  check("nothing upcoming -> the just-finished score game is still resolvable", justEnded?.id, "FINAL_ID");

  check("no match in either feed -> null", resolveScheduleGameFromFeeds([], [], endsWith("jets"), MON), null);

  // The catalog-import disambiguation schedule check (checkAmbiguousTeamSchedules)
  // uses nearTermOnly, which is exactly "pass [] as the odds feed" - it asks
  // "is playing NOW", so a game only in the odds feed (days out) must not count.
  const nearTerm = (scoreGames: ScoreGame[], odds: OddsGame[], nick: string) =>
    resolveScheduleGameFromFeeds(scoreGames, [] /* nearTermOnly drops the odds feed */, endsWith(nick), MON) !== null;
  checkTrue(
    "nearTermOnly: a weekly team with a game +6d (odds feed only) does NOT count as playing now",
    nearTerm([], [odds("Cincinnati Bengals", "Tampa Bay Buccaneers", 6)], "buccaneers") === false
  );
  checkTrue(
    "nearTermOnly: a team with a game today (score feed) DOES count",
    nearTerm([score("Los Angeles Dodgers", "San Diego Padres", 0)], [], "dodgers") === true
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## the newly reported bug: MLB series, today's game already final ##########");
{
  // Importing Monday night, after Monday's game ended. Tuesday's game (next
  // in the series) is already sitting in the score feed too, not final.
  // Before the fix: the finals-prefilter dropped Monday's game before the
  // same-day preference ever saw it, so this resolved to Tuesday's game
  // instead - exactly the reported symptom (late pick attaches to the NEXT
  // game, sits Pending, grades against the wrong date/line).
  const scores = [
    score("St. Louis Cardinals", "Chicago Cubs", 0, "final", "MON_FINAL"),
    score("St. Louis Cardinals", "Chicago Cubs", 1, "preview", "TUE_PREVIEW"),
  ];
  const resolved = resolveScheduleGameFromFeeds(scores, [], endsWith("cardinals"), MON);
  check("a late pick attaches to TODAY's finished game, not tomorrow's", resolved?.id, "MON_FINAL");

  // Same shape, but nothing upcoming is in the feed at all (single game,
  // no series) - unchanged, still resolves to the just-finished game.
  const single = resolveScheduleGameFromFeeds(
    [score("St. Louis Cardinals", "Chicago Cubs", 0, "final", "MON_FINAL")],
    [],
    endsWith("cardinals"),
    MON
  );
  check("no next game at all -> still the finished one", single?.id, "MON_FINAL");
}

// ---------------------------------------------------------------------------
console.log("\n########## doubleheader: don't guess, flag instead ##########");
{
  // Two games, same matchup, same slate day - game 1 already final, game 2
  // still upcoming. A bare pick can't say which one it means, and a late
  // import is routinely about game 1. Must come back null (unresolved),
  // which bulk-picks.ts's existing unmatchedGames path already surfaces on
  // the import review screen - not a guess in either direction.
  const doubleheader = resolveScheduleGameFromFeeds(
    [
      score("New York Yankees", "Boston Red Sox", 0, "final", "GAME_1"),
      score("New York Yankees", "Boston Red Sox", 0, "preview", "GAME_2"),
    ],
    [],
    endsWith("yankees"),
    MON
  );
  check("doubleheader with a final + an upcoming leg -> unresolved, not guessed", doubleheader, null);

  // Both legs already final (import happens after the whole doubleheader) -
  // no final/non-final split to be ambiguous about, ordinary closest-by-time
  // tiebreak still applies.
  const bothFinal = resolveScheduleGameFromFeeds(
    [
      score("New York Yankees", "Boston Red Sox", 0, "final", "GAME_1"),
      { ...score("New York Yankees", "Boston Red Sox", 0, "final", "GAME_2"), commenceTime: dayISO(0, 23) },
    ],
    [],
    endsWith("yankees"),
    MON
  );
  checkTrue("both legs final (no split) -> still resolves (doesn't over-flag)", bothFinal !== null);
}

// ---------------------------------------------------------------------------
console.log("\n########## slate-day boundary: late-night imports around midnight ET ##########");
{
  // Central-time capper session, 11:15pm CT Monday = 12:15am ET Tuesday -
  // past Eastern midnight by the wall clock, but still "tonight" to the
  // person importing. Monday's game already ended; Tuesday's (next in the
  // series) is already in the feed too. Without the slate-day rollover,
  // referenceTime's literal Eastern day is already Tuesday, so this
  // reproduces the same wrong-game bug via the clock instead of the
  // multi-day window.
  const lateImport = new Date("2026-09-08T04:15:00Z"); // 12:15am ET Tue / 11:15pm CT Mon
  const scores = [
    score("San Diego Padres", "Colorado Rockies", 0, "final", "MON_FINAL"),
    score("San Diego Padres", "Colorado Rockies", 1, "preview", "TUE_PREVIEW"),
  ];
  const resolved = resolveScheduleGameFromFeeds(scores, [], endsWith("padres"), lateImport);
  check(
    "12:15am ET import still attaches to Monday's finished game, not Tuesday's",
    resolved?.id,
    "MON_FINAL"
  );

  // A West Coast night game that starts before midnight ET but runs past it -
  // commenceTime 10:10pm ET Monday, import right after it ends at 2:00am ET
  // Tuesday. The game's OWN slate day is anchored to its start time (Monday)
  // regardless of when it actually finished; the import instant needs the
  // same rollover to still agree it's "Monday's game".
  const westCoastGame: ScoreGame = {
    ...score("Los Angeles Dodgers", "San Francisco Giants", 0, "final", "MON_NIGHT_FINAL"),
    commenceTime: "2026-09-08T02:10:00Z", // 10:10pm ET Monday
  };
  const postGameImport = new Date("2026-09-08T06:00:00Z"); // 2:00am ET Tuesday
  const wcResolved = resolveScheduleGameFromFeeds([westCoastGame], [], endsWith("dodgers"), postGameImport);
  check(
    "2am ET import still attaches to the West Coast game that ended after midnight",
    wcResolved?.id,
    "MON_NIGHT_FINAL"
  );

  // Guardrail: 7am ET the same Tuesday is past the rollover - Monday's game
  // is genuinely a day old by then, so if Tuesday's game is also up it wins
  // (unchanged fallback-to-odds-feed / next-game behavior, not a regression
  // from the rollover swallowing every future import all day).
  const nextMorning = new Date("2026-09-08T11:00:00Z"); // 7:00am ET Tuesday
  const morningResolved = resolveScheduleGameFromFeeds(
    [
      score("San Diego Padres", "Colorado Rockies", 0, "final", "MON_FINAL"),
      score("San Diego Padres", "Colorado Rockies", 1, "preview", "TUE_PREVIEW"),
    ],
    [],
    endsWith("padres"),
    nextMorning
  );
  check("7am ET (past the rollover) -> Tuesday's game, not Monday's", morningResolved?.id, "TUE_PREVIEW");
}

// ---------------------------------------------------------------------------
console.log("\n########## pickBestScheduleCandidate: same-day > not-final > closest ##########");
{
  const g = (day: number, status: ScoreGame["status"], id: string) => score("H", "A", day, status, id);
  check("single candidate is returned as-is", pickBestScheduleCandidate([g(3, "preview", "one")], MON)?.id, "one");
  check(
    "same Eastern day beats a closer-in-absolute-time other day",
    pickBestScheduleCandidate([g(0, "preview", "sameday"), g(1, "preview", "nextday")], MON)?.id,
    "sameday"
  );
  check(
    // Changed 2026-09-23: was "not-final beats final" - a bare pick can't
    // actually tell which same-day game it means when one's a final and the
    // other's still upcoming (doubleheader shape), so this is now the
    // doubleheader guard's job to refuse instead of guess. See "doubleheader:
    // don't guess, flag instead" above for the end-to-end version.
    "within the day, a final + a not-final -> unresolved (doubleheader guard), not a guess",
    pickBestScheduleCandidate([g(0, "final", "done"), g(0, "preview", "upcoming")], MON),
    null
  );
  check("empty -> null", pickBestScheduleCandidate([], MON), null);
}

// ---------------------------------------------------------------------------
console.log("\n########## MLB gameNumber: authoritative over start-time order, closes the flag gap ##########");
{
  // Type-Y (traditional) doubleheader, modeled on the real 2026-09-25
  // Orioles/Yankees slate: two real games 5 minutes apart, BOTH still
  // preview (imported before either starts) - the exact shape PR #105's
  // original guard did NOT flag (no final/non-final split), which is the gap
  // this closes.
  const bothPreview = [
    mlbGame("New York Yankees", "Baltimore Orioles", 20, 1, "Y", "preview"),
    mlbGame("New York Yankees", "Baltimore Orioles", 20, 2, "Y", "preview", "yankees-orioles-g2"),
  ];

  check(
    "gameNumber=1 -> resolves g1 by MLB's own metadata, not start-time order",
    pickBestScheduleCandidate(bothPreview, MON, 1)?.id,
    "New York Yankees-Baltimore Orioles-g1"
  );
  check(
    "gameNumber=2 -> resolves g2 by MLB's own metadata",
    pickBestScheduleCandidate(bothPreview, MON, 2)?.id,
    "yankees-orioles-g2"
  );

  // Split doubleheader ("S"), modeled on the real Cubs/Red Sox slate: start
  // times hours apart, ONE already final and the other still preview - a mix
  // PR #105's original guard WOULD already have flagged, but gameNumber must
  // still resolve it directly rather than falling through to that check.
  const splitMixed = [
    mlbGame("Boston Red Sox", "Chicago Cubs", 17, 1, "S", "final", "cubs-g1"),
    mlbGame("Boston Red Sox", "Chicago Cubs", 21, 2, "S", "preview", "cubs-g2"),
  ];
  check("split doubleheader, mixed status: gameNumber=1 -> the final leg", pickBestScheduleCandidate(splitMixed, MON, 1)?.id, "cubs-g1");
  check("split doubleheader, mixed status: gameNumber=2 -> the preview leg", pickBestScheduleCandidate(splitMixed, MON, 2)?.id, "cubs-g2");

  // No gameNumber signal at all on a real doubleheader (MLB flags it Y/S) -
  // ALWAYS flagged now, regardless of status mix. Closes the gap: before this
  // change, an all-preview doubleheader pool fell through to the ordinary
  // closest-by-time tiebreak instead of refusing to guess.
  check(
    "no gameNumber, both preview, MLB flags it a doubleheader -> flagged (the gap this closes)",
    pickBestScheduleCandidate(bothPreview, MON, null),
    null
  );
  check(
    "no gameNumber, both final, MLB flags it a doubleheader -> still flagged",
    pickBestScheduleCandidate(
      [
        mlbGame("New York Yankees", "Baltimore Orioles", 20, 1, "Y", "final"),
        mlbGame("New York Yankees", "Baltimore Orioles", 20, 2, "Y", "final", "yankees-orioles-g2"),
      ],
      MON,
      null
    ),
    null
  );

  // gameNumber present but this matchup ISN'T actually a doubleheader at all
  // (no MLB doubleheader metadata on the one candidate) - ignore gameNumber,
  // resolve normally. This is the single-game slate case from Step 2's
  // original spec.
  const singleGameNoDoubleheader = [score("New York Yankees", "Baltimore Orioles", 0, "preview", "just-one-game")];
  check(
    "gameNumber present, matchup isn't a doubleheader -> ignored, resolves normally (not flagged)",
    pickBestScheduleCandidate(singleGameNoDoubleheader, MON, 2)?.id,
    "just-one-game"
  );

  // gameNumber=2 but Game 2 is missing from the feed entirely (postponed /
  // not yet loaded) - the ONE candidate that IS in the feed is confirmed by
  // MLB's own metadata to be Game 1 of a real doubleheader, so this can tell
  // the two cases apart: never falls back to Game 1.
  const onlyGame1OfARealDoubleheader = [mlbGame("New York Yankees", "Baltimore Orioles", 20, 1, "Y", "preview")];
  check(
    "gameNumber=2 asked for, only Game 1 of a REAL doubleheader is in the feed -> null, never falls back to game 1",
    pickBestScheduleCandidate(onlyGame1OfARealDoubleheader, MON, 2),
    null
  );

  // Non-MLB sport (or an MLB row from before this shipped): no gameNumber/
  // doubleHeaderStatus metadata at all. gameNumber falls back to start-time
  // order instead of being ignored.
  const noMetadata = [
    score("Team A", "Team B", 0, "preview", "early"),
    { ...score("Team A", "Team B", 0, "preview", "late"), commenceTime: dayISO(0, 22) },
  ];
  check(
    "no MLB metadata: gameNumber=1 falls back to start-time order (earliest)",
    pickBestScheduleCandidate(noMetadata, MON, 1)?.id,
    "early"
  );
  check(
    "no MLB metadata: gameNumber=2 falls back to start-time order (latest)",
    pickBestScheduleCandidate(noMetadata, MON, 2)?.id,
    "late"
  );
  // With no doubleheader metadata at all, a lone same-day candidate can't be
  // told apart from "this matchup just has one game today" - that residual
  // ambiguity is inherent without MLB's authoritative fields (see
  // isConfirmedMissingPartnerLeg's own comment), so this falls through to
  // "ignore gameNumber, resolve normally" rather than flagging.
  check(
    "no MLB metadata: gameNumber=2, only one game in the same-day pool -> resolved normally, not flagged",
    pickBestScheduleCandidate(
      [score("Team A", "Team B", 0, "preview", "only-one-in-pool"), score("Team A", "Team B", 3, "preview", "far")],
      MON,
      2
    )?.id,
    "only-one-in-pool"
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
