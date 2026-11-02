// Proof for getNcaabLiveScores() and NCAAB's league registration - run with:
//   npx tsx src/server/data/ncaab-live-scores-acceptance-test.ts
//
// No test framework in this repo (see ncaaf-live-scores-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure. No DB, no network:
// global fetch is stubbed.
//
// Facts pinned here were verified live against ESPN on 2026-11-02:
//   - the scoreboard without `groups` returns ~18 featured games; groups=50 is
//     all of Division I (182 events that day, the 18 all inside it);
//   - a dates=A-B range is HTTP 400, so one request per date;
//   - a game at halftime is status.type { name: "STATUS_HALFTIME", state: "in" };
//   - a non-Division-I school (exhibition opponent) carries no team.conferenceId.

import {
  getNcaabLiveScores,
  toClientScores,
  LIVE_SPORTS,
  RESOLVABLE_SPORT_KEYS,
  type ScoreGame,
} from "./odds";
import { SPORT_SEASON_CONFIG, SPORT_LABEL_TO_KEY } from "@/lib/sport-seasons";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const team = (displayName: string, conferenceId?: string) => ({
  displayName,
  location: displayName.split(" ").slice(0, -1).join(" "),
  shortDisplayName: displayName.split(" ")[0],
  ...(conferenceId ? { conferenceId } : {}),
});
const event = (id: string, status: object, home: [string, string | undefined, string], away: [string, string | undefined, string], period = 1) => ({
  id,
  date: "2026-11-02T23:00Z",
  status: { type: status, period, displayClock: "7:41" },
  competitions: [
    {
      competitors: [
        { homeAway: "home", team: team(home[0], home[1]), score: home[2] },
        { homeAway: "away", team: team(away[0], away[1]), score: away[2] },
      ],
    },
  ],
});

const FIXTURE = {
  events: [
    // Real shape: a game at halftime. state "in" is all the mapping reads.
    event("h", { name: "STATUS_HALFTIME", state: "in", completed: false }, ["Florida Gators", "23", "34"], ["Miami Hurricanes", "2", "30"], 1),
    // In progress, second half.
    event("l", { name: "STATUS_IN_PROGRESS", state: "in", completed: false }, ["Duke Blue Devils", "2", "60"], ["Kansas Jayhawks", "8", "58"], 2),
    // Overtime.
    event("o", { name: "STATUS_IN_PROGRESS", state: "in", completed: false }, ["Gonzaga Bulldogs", "29", "80"], ["Houston Cougars", "25", "80"], 3),
    // Final, both Division I.
    event("f", { name: "STATUS_FINAL", state: "post", completed: true }, ["Grambling Tigers", "26", "89"], ["Northern Illinois Huskies", "45", "87"], 2),
    // D1 team vs a non-D1 exhibition opponent: ONE side without a conferenceId.
    event("x1", { name: "STATUS_SCHEDULED", state: "pre", completed: false }, ["UIC Flames", "18", "0"], ["St. Francis (IL) Fighting Saints", undefined, "0"]),
    // Neither side in Division I: kept for import / grading, hidden from browsers.
    event("x2", { name: "STATUS_SCHEDULED", state: "pre", completed: false }, ["Mount Marty Lancers", undefined, "0"], ["Dakota State Trojans", undefined, "0"]),
  ],
};

async function main() {
  // ---- registration ----
  check("LIVE_SPORTS carries NCAAB", LIVE_SPORTS.find((s) => s.key === "basketball_ncaab")?.label, "NCAAB");
  // refresh-odds, backfill-odds and ODDS_SPORT_KEYS all map over LIVE_SPORTS (read in the PR), so
  // registering it here is the whole change for them.
  check("RESOLVABLE_SPORT_KEYS carries NCAAB", RESOLVABLE_SPORT_KEYS.includes("basketball_ncaab"), true);
  check("SPORT_LABEL_TO_KEY maps NCAAB", SPORT_LABEL_TO_KEY["NCAAB"], "basketball_ncaab");
  check("season window: 2026-11-01 .. 2027-04-10", SPORT_SEASON_CONFIG["basketball_ncaab"], {
    seasonStart: "2026-11-01",
    seasonEnd: "2027-04-10",
  });

  // ---- the fetch: per-date fan-out, groups=50, no range, no limit ----
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return { ok: true, status: 200, json: async () => FIXTURE } as unknown as Response;
  }) as typeof fetch;

  let games: ScoreGame[];
  try {
    games = await getNcaabLiveScores();
  } finally {
    globalThis.fetch = realFetch;
  }

  check("3 requests: yesterday / today / tomorrow", urls.length, 3);
  check(
    "every request is the men's college basketball scoreboard",
    urls.every((u) => u.startsWith("https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?")),
    true
  );
  check("every request names groups=50 (all of Division I)", urls.every((u) => new URL(u).searchParams.get("groups") === "50"), true);
  check("every request carries ONE YYYYMMDD date, never a range", urls.every((u) => /^\d{8}$/.test(new URL(u).searchParams.get("dates") ?? "")), true);
  check("3 distinct dates", new Set(urls.map((u) => new URL(u).searchParams.get("dates"))).size, 3);
  check("no limit param on any request", urls.every((u) => !new URL(u).searchParams.has("limit")), true);

  // The same fixture came back for each date; events dedupe by id.
  check("events deduped by id across the 3 dates", games.map((g) => g.id), ["h", "l", "o", "f", "x1", "x2"]);

  // ---- status mapping ----
  const byId = new Map(games.map((g) => [g.id, g]));
  check("STATUS_HALFTIME (state in) -> live", byId.get("h")?.status, "live");
  check("halftime carries its period (1) and clock", [byId.get("h")?.period, byId.get("h")?.clock], [1, "7:41"]);
  check("second half -> live, period 2", [byId.get("l")?.status, byId.get("l")?.period], ["live", 2]);
  check("overtime -> live, period 3", [byId.get("o")?.status, byId.get("o")?.period], ["live", 3]);
  check("final -> final with both scores", [byId.get("f")?.status, byId.get("f")?.scores], [
    "final",
    [
      { name: "Grambling Tigers", score: "89" },
      { name: "Northern Illinois Huskies", score: "87" },
    ],
  ]);
  check("a final carries no live period / clock", [byId.get("f")?.period, byId.get("f")?.clock], [null, null]);

  // ---- non-Division-I games: kept, flagged like NCAAF's FCS-only games ----
  check("both sides D1: not flagged", byId.get("f")?.fcsOnly, undefined);
  check("ONE non-D1 side (exhibition vs a D1 team): not flagged - the odds board can carry it", byId.get("x1")?.fcsOnly, undefined);
  check("NO D1 side: flagged fcsOnly", byId.get("x2")?.fcsOnly, true);
  check("the flagged game is still on the feed (importable, gradable)", byId.has("x2"), true);
  check("import-only school / short names ride on the feed", [byId.get("f")?.homeLocation, byId.get("f")?.awayShortName], ["Grambling", "Northern"]);

  const client = toClientScores(games);
  check("browser feed drops the flagged game and nothing else", client.map((g) => g.id), ["h", "l", "o", "f", "x1"]);
  check(
    "browser feed carries no import-only fields",
    client.some((g) => "homeLocation" in g || "awayShortName" in g || "fcsOnly" in g || "scoreMissing" in g),
    false
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
