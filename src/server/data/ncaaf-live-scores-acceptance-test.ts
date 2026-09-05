// Proof for getNcaafLiveScores() - run with:
//   npx tsx src/server/data/ncaaf-live-scores-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// getNcaafLiveScores is getEspnScores("football/college-football", { groups: "80" }).
// The 2026-09 catalog-import investigation flagged that the old call - a bare
// 3-day `dates=` range with NO `limit` and NO `groups` - risks a silently
// TRUNCATED response on a busy Saturday (60-90 FBS games across Fri+Sat+Sun,
// against ESPN's ~25-event default page), and a dropped event means every
// pick for that game fails to resolve with no error. This stubs global fetch
// and asserts the request now carries the two params that prevent that:
//   - limit=1000  (clears any real slate; harmless for the <=16-game sports)
//   - groups=80   (FBS only - matches NCAAF_SCHOOLS and the Odds API's NCAAF
//                  coverage; keeps FCS/DII/DIII games out of the count and
//                  out of name-collision range)
// plus a basic parse check (post/in/pre -> final/live/preview, displayName
// and date passthrough) and a check that an FCS-vs-FBS "money game" present
// in the response is still parsed (it rides in as the FBS team's game).

import { getNcaafLiveScores } from "./odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const FIXTURE = {
  events: [
    {
      id: "401752700",
      date: "2026-09-05T16:00:00Z",
      status: { type: { state: "in", detail: "2nd Quarter", shortDetail: "2nd" } },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: "James Madison Dukes" }, score: "14" },
            { homeAway: "away", team: { displayName: "Liberty Flames" }, score: "10" },
          ],
        },
      ],
    },
    {
      id: "401752701",
      date: "2026-09-05T16:00:00Z",
      status: { type: { state: "pre", detail: "Sat, September 5th at 12:00 PM EDT", shortDetail: "9/5 - 12:00 PM EDT" } },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: "Pittsburgh Panthers" }, score: "0" },
            { homeAway: "away", team: { displayName: "Miami (OH) RedHawks" }, score: "0" },
          ],
        },
      ],
    },
    {
      // FCS-vs-FBS money game: Tennessee State (FCS) at Georgia (FBS). Present
      // under groups=80 because it's the FBS team's game.
      id: "401752702",
      date: "2026-09-05T19:00:00Z",
      status: { type: { state: "post", detail: "Final", shortDetail: "Final" } },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: "Georgia Bulldogs" }, score: "48" },
            { homeAway: "away", team: { displayName: "Tennessee State Tigers" }, score: "7" },
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
    const games = await getNcaafLiveScores();

    check("fetch hit ESPN's football/college-football scoreboard path", calledUrl.includes("/sports/football/college-football/scoreboard"), true);
    check("request carries limit=1000 (prevents the busy-Saturday truncation)", /[?&]limit=1000(&|$)/.test(calledUrl), true);
    check("request carries groups=80 (FBS only)", /[?&]groups=80(&|$)/.test(calledUrl), true);
    check("request still spans the 3-day range", /[?&]dates=\d{8}-\d{8}(&|$)/.test(calledUrl), true);

    check("parsed all 3 events", games.length, 3);

    const jmu = games.find((g) => g.id === "401752700")!;
    check("in-progress game: status is live", jmu.status, "live");
    check("in-progress game: home/away displayName passthrough", [jmu.homeTeam, jmu.awayTeam], ["James Madison Dukes", "Liberty Flames"]);
    check("in-progress game: scores present", jmu.scores, [
      { name: "James Madison Dukes", score: "14" },
      { name: "Liberty Flames", score: "10" },
    ]);

    const pitt = games.find((g) => g.id === "401752701")!;
    check("scheduled game: status is preview", pitt.status, "preview");
    check("scheduled game: scores is null (not 0-0)", pitt.scores, null);
    check("scheduled game: commenceTime passthrough", pitt.commenceTime, "2026-09-05T16:00:00Z");

    const uga = games.find((g) => g.id === "401752702")!;
    check("FCS-vs-FBS money game: parsed as final with both sides", [uga.status, uga.homeTeam, uga.awayTeam], [
      "final",
      "Georgia Bulldogs",
      "Tennessee State Tigers",
    ]);
    check("FCS-vs-FBS money game: MLB-only fields are null", [uga.inningHalf, uga.inningOrdinal, uga.innings], [null, null, null]);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
