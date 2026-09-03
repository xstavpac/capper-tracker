// Proof for getNhlLiveScores() - run with:
//   npx tsx src/server/data/nhl-live-scores-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// getNhlLiveScores is getEspnScores("hockey/nhl"). This stubs global fetch
// with a captured-shape ESPN NHL scoreboard payload (real 2025-26 game shapes:
// a regulation final, an overtime final, a shootout final, and a scheduled
// preview) and asserts the parse:
//   - status maps post -> "final", pre -> "preview"
//   - a final game carries `scores` with the FINAL score (OT + shootout goal
//     included - the shootout game is Buffalo 3 / Dallas 4, Dallas' 4 carries
//     the +1 shootout goal), a preview game carries `scores: null`
//   - home/away team displayName and commenceTime pass through
//   - the NHL-irrelevant MLB fields (inningHalf/inningOrdinal/innings) are null
//
// The season gate (dispatchLiveScoresForSport returns [] for icehockey_nhl
// out of season) is identical to the NFL/NCAAF gate already in that function
// and is not re-tested here - getNhlLiveScores itself is the ungated fetcher.

import { getNhlLiveScores } from "./odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const FIXTURE = {
  events: [
    {
      id: "401803301",
      date: "2026-03-15T23:00:00Z",
      status: { type: { state: "post", detail: "Final", shortDetail: "Final" }, period: 3 },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: "Winnipeg Jets" }, score: "3" },
            { homeAway: "away", team: { displayName: "St. Louis Blues" }, score: "2" },
          ],
        },
      ],
    },
    {
      id: "401803575",
      date: "2026-04-05T23:00:00Z",
      status: { type: { state: "post", detail: "Final/OT", shortDetail: "Final/OT", altDetail: "OT" }, period: 4 },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: "Philadelphia Flyers" }, score: "2" },
            { homeAway: "away", team: { displayName: "Boston Bruins" }, score: "1" },
          ],
        },
      ],
    },
    {
      id: "401803410",
      date: "2026-04-15T23:00:00Z",
      status: { type: { state: "post", detail: "Final/SO", shortDetail: "Final/SO", altDetail: "SO" }, period: 5 },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: "Buffalo Sabres" }, score: "3" },
            { homeAway: "away", team: { displayName: "Dallas Stars" }, score: "4" },
          ],
        },
      ],
    },
    {
      id: "401803900",
      date: "2026-09-29T21:00:00Z",
      status: { type: { state: "pre", detail: "Tue, September 29th at 5:00 PM EDT", shortDetail: "9/29 - 5:00 PM EDT" }, period: 0 },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: "Carolina Hurricanes" }, score: "0" },
            { homeAway: "away", team: { displayName: "New York Rangers" }, score: "0" },
          ],
        },
      ],
    },
  ],
};

async function main() {
  const realFetch = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calledUrl = String(input);
    return { ok: true, json: async () => FIXTURE } as Response;
  }) as typeof fetch;

  try {
    const games = await getNhlLiveScores();

    check("fetch hit ESPN's hockey/nhl scoreboard path", calledUrl.includes("/sports/hockey/nhl/scoreboard"), true);
    check("parsed all 4 events", games.length, 4);

    const jets = games.find((g) => g.id === "401803301")!;
    check("regulation final: status", jets.status, "final");
    check("regulation final: home/away teams", [jets.homeTeam, jets.awayTeam], ["Winnipeg Jets", "St. Louis Blues"]);
    check("regulation final: scores carry the final score", jets.scores, [
      { name: "Winnipeg Jets", score: "3" },
      { name: "St. Louis Blues", score: "2" },
    ]);
    check("regulation final: commenceTime passes through", jets.commenceTime, "2026-03-15T23:00:00Z");
    check("regulation final: MLB-only fields are null", [jets.inningHalf, jets.inningOrdinal, jets.innings], [null, null, null]);

    const flyers = games.find((g) => g.id === "401803575")!;
    check("overtime final: status is final", flyers.status, "final");
    check("overtime final: score is the post-OT final (2-1)", flyers.scores, [
      { name: "Philadelphia Flyers", score: "2" },
      { name: "Boston Bruins", score: "1" },
    ]);

    const sabres = games.find((g) => g.id === "401803410")!;
    check("shootout final: status is final", sabres.status, "final");
    check("shootout final: away score carries the +1 shootout goal (Dallas 4)", sabres.scores, [
      { name: "Buffalo Sabres", score: "3" },
      { name: "Dallas Stars", score: "4" },
    ]);

    const preview = games.find((g) => g.id === "401803900")!;
    check("scheduled game: status is preview", preview.status, "preview");
    check("scheduled game: scores is null (not 0-0)", preview.scores, null);
    check("scheduled game: teams still parsed", [preview.homeTeam, preview.awayTeam], ["Carolina Hurricanes", "New York Rangers"]);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
