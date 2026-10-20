// "Live" vs "final" is decided by the feed's explicit state and nothing else -
// run with:
//   npx tsx src/server/data/live-status-mapping-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// The Live board drops a game only when its ScoreGame says "final", so the
// mapping that produces that word must never infer it from a period number or
// a 0:00 clock. This stubs global fetch and runs each league's real fetcher
// (getNflLiveScores, ... getMlbLiveScores - the ungated ones, so the season
// windows don't matter here) over events covering every in-game state between
// the end of regulation and the final whistle, then puts the result on the
// board as a past-midnight carry-over.
//
// ESPN: status comes from status.type.state ("pre" / "in" / "post"); the
// status.type.name beside it (STATUS_END_PERIOD, STATUS_HALFTIME, ...) is not
// read at all. The Final/OT event below is the real one from the incident
// (event 401864519, captured 2026-10-12). The in-progress shapes follow ESPN's
// status-type convention - no overtime game was in progress to capture one
// from - which is exactly why the assertion is on `state`, the one field the
// code reads.
// MLB: status comes from the Stats API's abstractGameState ("Preview" / "Live"
// / "Final").

import { getNflLiveScores, getNcaafLiveScores, getNbaLiveScores, getWnbaLiveScores, getNhlLiveScores, getMlbLiveScores } from "./odds";
import type { ScoreGame } from "./odds";
import { orderBoardGames, matchScoreToGame } from "@/components/live/live-scoreboard-ordering";
import { easternDateKey } from "@/lib/dates";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// Kicked off 9:00 PM ET on Oct 9; "now" is 12:40 AM ET on Oct 10.
const KICKOFF = "2026-10-10T01:00Z";
const NOW = new Date("2026-10-10T04:40:00Z");

type EspnCase = { id: string; name: string; state: "pre" | "in" | "post"; period: number; clock: string; detail: string; want: ScoreGame["status"] };

function espnEvent(c: EspnCase, home: string, away: string) {
  return {
    id: c.id,
    date: KICKOFF,
    status: {
      clock: 0,
      displayClock: c.clock,
      period: c.period,
      type: { id: "0", name: c.name, state: c.state, completed: c.state === "post", description: c.detail, detail: c.detail, shortDetail: c.detail },
    },
    competitions: [
      {
        competitors: [
          { homeAway: "home", score: "13", team: { displayName: home } },
          { homeAway: "away", score: "16", team: { displayName: away } },
        ],
      },
    ],
  };
}

// `reg` = regulation periods. Every "in" row must come out live, whatever its
// name, period or clock says.
function espnCases(reg: number, extra: EspnCase[] = []): EspnCase[] {
  return [
    { id: "1", name: "STATUS_IN_PROGRESS", state: "in", period: 2, clock: "8:45", detail: "8:45 - 2nd", want: "live" },
    { id: "2", name: "STATUS_HALFTIME", state: "in", period: 2, clock: "0:00", detail: "Halftime", want: "live" },
    { id: "3", name: "STATUS_END_PERIOD", state: "in", period: reg - 1, clock: "0:00", detail: "End of period", want: "live" },
    { id: "4", name: "STATUS_END_PERIOD", state: "in", period: reg, clock: "0:00", detail: "End of regulation", want: "live" },
    { id: "5", name: "STATUS_IN_PROGRESS", state: "in", period: reg + 1, clock: "4:12", detail: "4:12 - OT", want: "live" },
    { id: "6", name: "STATUS_END_PERIOD", state: "in", period: reg + 1, clock: "0:00", detail: "End of OT", want: "live" },
    { id: "7", name: "STATUS_IN_PROGRESS", state: "in", period: reg + 2, clock: "0:00", detail: "2OT", want: "live" },
    { id: "8", name: "STATUS_OVERTIME", state: "in", period: reg + 1, clock: "0:00", detail: "OT", want: "live" },
    { id: "9", name: "STATUS_FINAL", state: "post", period: reg + 1, clock: "0:00", detail: "Final/OT", want: "final" },
    { id: "10", name: "STATUS_FINAL", state: "post", period: reg, clock: "0:00", detail: "Final", want: "final" },
    { id: "11", name: "STATUS_SCHEDULED", state: "pre", period: 0, clock: "0:00", detail: "Scheduled", want: "preview" },
    ...extra,
  ];
}

const ESPN_LEAGUES: { league: string; path: string; fetcher: () => Promise<ScoreGame[]>; reg: number; extra?: EspnCase[] }[] = [
  { league: "NFL", path: "/sports/football/nfl/", fetcher: getNflLiveScores, reg: 4 },
  { league: "NCAAF", path: "/sports/football/college-football/", fetcher: getNcaafLiveScores, reg: 4 },
  { league: "NBA", path: "/sports/basketball/nba/", fetcher: getNbaLiveScores, reg: 4 },
  { league: "WNBA", path: "/sports/basketball/wnba/", fetcher: getWnbaLiveScores, reg: 4 },
  {
    league: "NHL",
    path: "/sports/hockey/nhl/",
    fetcher: getNhlLiveScores,
    reg: 3,
    extra: [
      { id: "20", name: "STATUS_IN_PROGRESS", state: "in", period: 5, clock: "0:00", detail: "Shootout", want: "live" },
      { id: "21", name: "STATUS_FINAL", state: "post", period: 5, clock: "0:00", detail: "Final/SO", want: "final" },
    ],
  },
];

// Is this game still on the board at 12:40 AM, as a carry-over from last night?
function onBoard(scores: ScoreGame[], home: string, away: string): boolean {
  const game = { id: "odds", homeTeam: home, awayTeam: away, commenceTime: KICKOFF };
  return orderBoardGames([{ game, score: matchScoreToGame(scores, game) }], easternDateKey(NOW), NOW).length === 1;
}

async function main() {
  const realFetch = globalThis.fetch;
  try {
    for (const { league, path, fetcher, reg, extra } of ESPN_LEAGUES) {
      console.log(`\n########## ${league} (ESPN) ##########`);
      const cases = espnCases(reg, extra);
      // Each case is its own matchup so the board check can pick it out by team.
      const home = (c: EspnCase) => `Home ${league} ${c.id}`;
      const away = (c: EspnCase) => `Away ${league} ${c.id}`;
      const events = cases.map((c) => espnEvent(c, home(c), away(c)));

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.includes(path)) throw new Error("unexpected fetch: " + url);
        return new Response(JSON.stringify({ events }), { status: 200 });
      }) as typeof fetch;

      const scores = await fetcher();
      const byId = new Map(scores.map((s) => [s.id, s]));
      check(`${league}: every event parsed once (the per-date fan-out is de-duplicated)`, scores.length, cases.length);

      for (const c of cases) {
        const label = `${league}: ${c.name} state=${c.state} period=${c.period} clock=${c.clock} ("${c.detail}")`;
        check(`${label} -> ${c.want}`, byId.get(c.id)?.status, c.want);
        // preview: no live score to hold it, but 3h40m after kickoff is inside the 8h bound.
        check(`${label} -> ${c.want === "final" ? "off" : "on"} the board after midnight`, onBoard(scores, home(c), away(c)), c.want !== "final");
      }
      check(`${league}: an OT game keeps its period number while live`, byId.get("5")?.period, reg + 1);
    }

    console.log("\n########## the incident's real Final/OT event ##########");
    {
      // ESPN event 401864519 as returned on 2026-10-12, trimmed to the fields read.
      const real = {
        id: "401864519",
        date: "2026-10-10T01:00Z",
        status: { clock: 0, displayClock: "0:00", period: 5, type: { id: "3", name: "STATUS_FINAL", state: "post", completed: true, description: "Final", detail: "Final/OT", shortDetail: "Final/OT", altDetail: "OT" } },
        competitions: [
          {
            competitors: [
              { homeAway: "home", score: "13", team: { displayName: "San José State Spartans" } },
              { homeAway: "away", score: "16", team: { displayName: "Wyoming Cowboys" } },
            ],
          },
        ],
      };
      globalThis.fetch = (async () => new Response(JSON.stringify({ events: [real] }), { status: 200 })) as typeof fetch;
      const [g] = await getNflLiveScores(); // any ESPN fetcher - the mapping is shared
      check("real Final/OT event -> final", g.status, "final");
      check("real Final/OT event carries the OT-inclusive score", g.scores, [
        { name: "San José State Spartans", score: "13" },
        { name: "Wyoming Cowboys", score: "16" },
      ]);
    }

    console.log("\n########## MLB (Stats API) ##########");
    {
      type MlbCase = { gamePk: number; abstract: string; detailed: string; half: string | null; ordinal: string | null; want: ScoreGame["status"] };
      const cases: MlbCase[] = [
        { gamePk: 1, abstract: "Live", detailed: "In Progress", half: "Bottom", ordinal: "9th", want: "live" },
        { gamePk: 2, abstract: "Live", detailed: "In Progress", half: "End", ordinal: "9th", want: "live" },
        { gamePk: 3, abstract: "Live", detailed: "In Progress", half: "Top", ordinal: "10th", want: "live" },
        { gamePk: 4, abstract: "Live", detailed: "In Progress", half: "Middle", ordinal: "13th", want: "live" },
        { gamePk: 5, abstract: "Live", detailed: "In Progress", half: "Bottom", ordinal: "18th", want: "live" },
        { gamePk: 6, abstract: "Final", detailed: "Final", half: null, ordinal: null, want: "final" },
        { gamePk: 7, abstract: "Preview", detailed: "Scheduled", half: null, ordinal: null, want: "preview" },
      ];
      const home = (c: MlbCase) => `Home MLB ${c.gamePk}`;
      const away = (c: MlbCase) => `Away MLB ${c.gamePk}`;
      const games = cases.map((c) => ({
        gamePk: c.gamePk,
        gameDate: "2026-10-10T01:00:00Z",
        gameNumber: 1,
        doubleHeader: "N",
        status: { abstractGameState: c.abstract, codedGameState: c.abstract === "Final" ? "F" : c.abstract === "Live" ? "I" : "S", detailedState: c.detailed },
        teams: { home: { score: 4, team: { name: home(c) } }, away: { score: 4, team: { name: away(c) } } },
        linescore: { inningState: c.half, currentInningOrdinal: c.ordinal, innings: [] },
      }));
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (!String(input).includes("statsapi.mlb.com")) throw new Error("unexpected fetch: " + String(input));
        return new Response(JSON.stringify({ dates: [{ games }] }), { status: 200 });
      }) as typeof fetch;

      const scores = await getMlbLiveScores();
      const byId = new Map(scores.map((s) => [s.id, s]));
      for (const c of cases) {
        const label = `MLB: ${c.abstract}${c.half ? ` ${c.half} ${c.ordinal}` : ""}`;
        check(`${label} -> ${c.want}`, byId.get(String(c.gamePk))?.status, c.want);
        check(`${label} -> ${c.want === "final" ? "off" : "on"} the board after midnight`, onBoard(scores, home(c), away(c)), c.want !== "final");
      }
      check("MLB: an extra-inning game keeps its inning while live", [byId.get("3")?.inningHalf, byId.get("3")?.inningOrdinal], ["Top", "10th"]);
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
