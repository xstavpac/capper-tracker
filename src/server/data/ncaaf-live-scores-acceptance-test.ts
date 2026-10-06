// Proof for getNcaafLiveScores() - run with:
//   npx tsx src/server/data/ncaaf-live-scores-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// getNcaafLiveScores is getEspnScores("football/college-football") for BOTH
// divisions - groups=80 (FBS) and groups=81 (FCS) - merged by event id (see
// the 2026-10 note at the bottom of this header).
// The 2026-09 catalog-import investigation flagged that the old call - a bare
// 3-day `dates=` range with NO `limit` and NO `groups` - risks a silently
// TRUNCATED response on a busy Saturday (60-90 FBS games across Fri+Sat+Sun,
// against ESPN's ~25-event default page), and a dropped event means every
// pick for that game fails to resolve with no error.
//
// A follow-up 2026-09 investigation found ESPN's scoreboard now rejects a
// `dates=YYYYMMDD-YYYYMMDD` RANGE outright (HTTP 400), which had been
// silently swallowed into an empty score feed for every ESPN-backed sport -
// invisible for upcoming games (the odds-feed fallback still had them) but
// breaking catalog-import matching and grading for every completed game,
// since a finished game has no odds-feed fallback to hide behind.
// getEspnScores now fans out ONE request per date across yesterday/today/
// tomorrow instead, so this also asserts exactly 3 requests go out, each
// carrying a single `dates=YYYYMMDD` (never a range).
//
// A third 2026-09-21 investigation (63 stuck NCAAF picks) found the
// `limit=1000` param added to defend against the original truncation is now
// itself the truncator: ESPN caps the per-date response at exactly 25 events
// whenever `limit` is set above ~500, confirmed live against real Saturdays
// with 68-80 actual games. `limit` was removed entirely - the per-date fetch
// this file already exercises doesn't need it (verified live: omitting it
// reliably returns the full slate across 4 different high-volume dates) - so
// this now asserts `limit` is ABSENT from every request instead of present.
//
// plus a basic parse check (post/in/pre -> final/live/preview, displayName
// and date passthrough) and a check that an FCS-vs-FBS "money game" present
// in the response is still parsed (it rides in as the FBS team's game).
//
// 2026-10: the feed was FBS-only, so an FCS-vs-FCS game was in no feed and a
// pick on one could never match or grade. The FCS group is now fetched
// alongside: 3 dates x 2 groups = 6 requests, an FBS-vs-FCS game (present in
// both groups) appears once, and an FCS fetch failure leaves the FBS slate.
//
// Follow-up (same PR): FCS-only games are server-side only. toClientScores -
// what every browser-bound read goes through - must return exactly the FBS
// slate in exactly the pre-FCS shape. And the ESPN fan-out is per server cache
// window, not per caller: many concurrent readers trigger one set of fetches.

import { getNcaafLiveScores, getLiveScoresForSport, getClientScoresForSport, toClientScores } from "./odds";
import { isSportInSeason } from "@/lib/sport-seasons";

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

// What groups=81 returns: one FCS-vs-FCS game, plus the FBS-vs-FCS money game
// again under the same event id.
const FCS_FIXTURE = {
  events: [
    {
      id: "401868120",
      date: "2026-09-05T20:00:00Z",
      status: { type: { state: "post", detail: "Final", shortDetail: "Final" } },
      competitions: [
        {
          competitors: [
            {
              homeAway: "home",
              team: { displayName: "Montana State Bobcats", location: "Montana State", shortDisplayName: "Montana St" },
              score: "38",
            },
            { homeAway: "away", team: { displayName: "Idaho Vandals", location: "Idaho", shortDisplayName: "Idaho" }, score: "20" },
          ],
        },
      ],
    },
    FIXTURE.events[2],
  ],
};

async function main() {
  const realFetch = globalThis.fetch;
  const calledUrls: string[] = [];
  let fcsFails = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calledUrls.push(url);
    const isFcs = /[?&]groups=81(&|$)/.test(url);
    if (isFcs && fcsFails) throw new Error("network down");
    return { ok: true, json: async () => (isFcs ? FCS_FIXTURE : FIXTURE) } as Response;
  }) as typeof fetch;

  try {
    const allGames = await getNcaafLiveScores();

    check("fetches 3 dates (yesterday/today/tomorrow) per division, not one range request", calledUrls.length, 6);
    check("3 requests carry groups=80 (FBS)", calledUrls.filter((u) => /[?&]groups=80(&|$)/.test(u)).length, 3);
    check("3 requests carry groups=81 (FCS)", calledUrls.filter((u) => /[?&]groups=81(&|$)/.test(u)).length, 3);
    check("FBS games first, then the FCS-only game; the game in both groups once", allGames.map((g) => g.id), [
      "401752700",
      "401752701",
      "401752702",
      "401868120",
    ]);
    const fcsGame = allGames.find((g) => g.id === "401868120")!;
    check("FCS-vs-FCS game: final with both sides and scores", [fcsGame.status, fcsGame.homeTeam, fcsGame.awayTeam, fcsGame.scores], [
      "final",
      "Montana State Bobcats",
      "Idaho Vandals",
      [
        { name: "Montana State Bobcats", score: "38" },
        { name: "Idaho Vandals", score: "20" },
      ],
    ]);
    check(
      "school and short form pass through for team recognition",
      [fcsGame.homeLocation, fcsGame.homeShortName, fcsGame.awayLocation, fcsGame.awayShortName],
      ["Montana State", "Montana St", "Idaho", "Idaho"]
    );

    check("only the FCS-vs-FCS game is tagged fcsOnly", allGames.filter((g) => g.fcsOnly).map((g) => g.id), ["401868120"]);

    // What a browser gets: the FBS-only fetch, mapped the way it was before
    // the feed carried FCS (no school / short-form fields, no fcsOnly).
    const clientView = toClientScores(allGames);
    check("client view drops the FCS-only game, keeps the FBS-vs-FCS one", clientView.map((g) => g.id), [
      "401752700",
      "401752701",
      "401752702",
    ]);
    check(
      "client view carries no import-only fields",
      clientView.flatMap((g) => Object.keys(g)).filter((k) => /Location|ShortName|fcsOnly/.test(k)),
      []
    );
    check(
      "client view keys are exactly the pre-FCS ScoreGame shape",
      Object.keys(clientView[0]),
      ["id", "homeTeam", "awayTeam", "status", "scores", "commenceTime", "inningHalf", "inningOrdinal", "innings", "period", "clock"]
    );

    // Fan-out: 25 concurrent readers (full feed and client view mixed), then
    // 5 more inside the TTL, share ONE refresh - 6 ESPN requests in total (3
    // dates x 2 divisions), not 6 per reader.
    if (isSportInSeason("americanfootball_ncaaf")) {
      const before = calledUrls.length;
      const readers = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          i % 2 ? getLiveScoresForSport("americanfootball_ncaaf") : getClientScoresForSport("americanfootball_ncaaf")
        )
      );
      for (let i = 0; i < 5; i++) await getClientScoresForSport("americanfootball_ncaaf");
      check("30 readers inside one TTL window -> one refresh (6 ESPN requests)", calledUrls.length - before, 6);
      check("full-feed readers see 4 games, client-view readers 3", [readers[1].length, readers[0].length], [4, 3]);
    }

    fcsFails = true;
    check("an FCS fetch failure still serves the FBS slate", (await getNcaafLiveScores()).map((g) => g.id), [
      "401752700",
      "401752701",
      "401752702",
    ]);
    fcsFails = false;

    const games = allGames.filter((g) => g.id !== "401868120");
    for (const url of calledUrls.filter((u) => /[?&]groups=80(&|$)/.test(u))) {
      check(`fetch hit ESPN's football/college-football scoreboard path (${url})`, url.includes("/sports/football/college-football/scoreboard"), true);
      check(`request carries NO limit param - ESPN caps busy-Saturday responses at 25 events whenever limit is set above ~500 (${url})`, /[?&]limit=/.test(url), false);
      check(`request carries groups=80 (${url})`, /[?&]groups=80(&|$)/.test(url), true);
      check(`request carries a SINGLE date, never a range - ESPN 400s on dates=YYYYMMDD-YYYYMMDD (${url})`, /[?&]dates=\d{8}(&|$)/.test(url), true);
    }

    // Each fetch call returns the same 3-event fixture (a stub can't tell
    // dates apart) - real distinct per-date responses obviously wouldn't
    // repeat the same ids, but the dedupe-by-id in getEspnScores means this
    // stub still exercises the "parsed all 3 events" shape correctly.
    check("parsed all 3 FBS events (deduped across the 3 per-date fetches)", games.length, 3);

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
