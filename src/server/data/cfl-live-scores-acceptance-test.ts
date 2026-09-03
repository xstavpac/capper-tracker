// Proof for getCflLiveScores() - run with:
//   npx tsx src/server/data/cfl-live-scores-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// CFL has no free score source (ESPN dropped CFL after 2022, api.cfl.ca is
// discontinued), so getCflLiveScores hits The Odds API's own /scores endpoint.
// This stubs global fetch with a captured-shape /scores payload and asserts
// the parse:
//   - completed:true            -> status "final", scores carried
//   - scores set, completed:false -> status "live"
//   - scores null               -> status "preview"
//   - a tie game parses like any other final (grading handles the PUSH)
//   - score numbers become strings; the event id passes through unchanged
//     (it is the SAME id as the odds snapshot - same provider)
//   - the request carries daysFrom (required to get completed games at all)

import { getCflLiveScores } from "./odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// Real-shaped Odds API /scores payload. Team names / scores from real 2022 CFL
// results; a tie is constructed (real CFL ties are ~1 per 3-4 seasons).
const FIXTURE = [
  {
    id: "cfl-evt-final-1",
    sport_key: "americanfootball_cfl",
    commence_time: "2026-08-13T01:00:00Z",
    completed: true,
    home_team: "Calgary Stampeders",
    away_team: "BC Lions",
    scores: [
      { name: "Calgary Stampeders", score: 40 },
      { name: "BC Lions", score: 41 },
    ],
    last_update: "2026-08-13T04:20:00Z",
  },
  {
    id: "cfl-evt-tie-1",
    sport_key: "americanfootball_cfl",
    commence_time: "2026-08-15T23:00:00Z",
    completed: true,
    home_team: "Ottawa Redblacks",
    away_team: "Edmonton Elks",
    scores: [
      { name: "Ottawa Redblacks", score: 27 },
      { name: "Edmonton Elks", score: 27 },
    ],
    last_update: "2026-08-16T02:30:00Z",
  },
  {
    id: "cfl-evt-live-1",
    sport_key: "americanfootball_cfl",
    commence_time: "2026-09-04T23:30:00Z",
    completed: false,
    home_team: "Montreal Alouettes",
    away_team: "Toronto Argonauts",
    scores: [
      { name: "Montreal Alouettes", score: 14 },
      { name: "Toronto Argonauts", score: 10 },
    ],
    last_update: "2026-09-05T01:15:00Z",
  },
  {
    id: "cfl-evt-upcoming-1",
    sport_key: "americanfootball_cfl",
    commence_time: "2026-09-06T23:00:00Z",
    completed: false,
    home_team: "Saskatchewan Roughriders",
    away_team: "Winnipeg Blue Bombers",
    scores: null,
    last_update: null,
  },
];

async function main() {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ODDS_API_KEY;
  process.env.ODDS_API_KEY = "test-key";
  let calledUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calledUrl = String(input);
    return { ok: true, json: async () => FIXTURE, text: async () => "" } as Response;
  }) as typeof fetch;

  try {
    const games = await getCflLiveScores();

    check("hits The Odds API CFL /scores endpoint", calledUrl.includes("/sports/americanfootball_cfl/scores/"), true);
    check("request carries daysFrom (needed for completed games)", /[?&]daysFrom=\d/.test(calledUrl), true);
    check("parsed all 4 games", games.length, 4);

    const final = games.find((g) => g.id === "cfl-evt-final-1")!;
    check("completed game -> status final", final.status, "final");
    check("final: teams pass through", [final.homeTeam, final.awayTeam], ["Calgary Stampeders", "BC Lions"]);
    check("final: scores carried, numbers as strings", final.scores, [
      { name: "Calgary Stampeders", score: "40" },
      { name: "BC Lions", score: "41" },
    ]);
    check("final: id passes through unchanged (== odds snapshot id)", final.id, "cfl-evt-final-1");
    check("final: no half/inning fields", [final.inningHalf, final.inningOrdinal, final.innings], [null, null, null]);

    const tie = games.find((g) => g.id === "cfl-evt-tie-1")!;
    check("tie game -> status final, equal scores parsed straight through", { status: tie.status, scores: tie.scores }, {
      status: "final",
      scores: [
        { name: "Ottawa Redblacks", score: "27" },
        { name: "Edmonton Elks", score: "27" },
      ],
    });

    const live = games.find((g) => g.id === "cfl-evt-live-1")!;
    check("in-progress game (scores set, not completed) -> status live", live.status, "live");
    check("live: partial scores carried", live.scores, [
      { name: "Montreal Alouettes", score: "14" },
      { name: "Toronto Argonauts", score: "10" },
    ]);

    const upcoming = games.find((g) => g.id === "cfl-evt-upcoming-1")!;
    check("upcoming game (scores null) -> status preview", upcoming.status, "preview");
    check("upcoming: scores is null, not 0-0", upcoming.scores, null);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = realKey;
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
