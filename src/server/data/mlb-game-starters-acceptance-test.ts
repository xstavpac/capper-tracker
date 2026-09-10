// Proof for the point-in-time starting-pitcher data layer
// (src/server/data/mlb-pitcher-history.ts + the GameStarters write path in
// stat-snapshots.ts). Covers the three things that have to be right before a
// pitcher-vs-pitcher stimulus can be built on top:
//
//   1. POINT-IN-TIME: a game's starting-pitcher line is only ever computed
//      over a window that ENDS the day BEFORE the game - never on or after
//      the game's own date. Same regression shape as the Zone Model
//      look-ahead bug fix: a snapshot dated the game's own day must not be
//      selected, and the byDateRange request must carry endDate = day - 1.
//   2. STARTER IDENTIFICATION: the probable starter is read from the
//      schedule response and the CONFIRMED starter from the boxscore
//      (pitchers[0]), verified against a real recorded slate.
//   3. TRADED-PITCHER AGGREGATION: byDateRange returns per-team splits plus
//      a no-team aggregate for a pitcher traded mid-season; findAggregateSplit
//      must pick the aggregate. Verified against Charlie Morton's real 2025
//      line (Baltimore -> Detroit).
//
// Pure: global fetch and the prisma singleton's methods are swapped for
// stubs before each call - no network, no database. Listed in
// PURE_DESPITE_PRISMA_IMPORT in scripts/run-tests.mjs. Run with:
//   npx tsx src/server/data/mlb-game-starters-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import {
  fetchMlbScheduleWithProbables,
  fetchActualStarters,
  fetchPointInTimePitcherLines,
  findAggregateSplit,
  inningsPitchedToInnings,
  pitcherLineFromStat,
  regularSeasonStartKey,
  getHistoricalStartingMatchup,
} from "@/server/data/mlb-pitcher-history";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
function ok(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

// ---- fixtures ----------------------------------------------------------
const FIX = join(__dirname, "__fixtures__");
const scheduleFixture = JSON.parse(readFileSync(join(FIX, "mlb-schedule-2025-06-15.json"), "utf8"));
const boxscoreFixture = JSON.parse(readFileSync(join(FIX, "mlb-boxscore-777505.json"), "utf8"));
const byDateRangeBatch = JSON.parse(readFileSync(join(FIX, "mlb-bydaterange-batch.json"), "utf8"));

// ---- fetch stub -------------------------------------------------------
const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
function stubFetch(handler: (url: string) => unknown) {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    const body = handler(url);
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

// ---- prisma stub -----------------------------------------------------
const prismaOriginals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  prismaOriginals[path] ??= target[method];
  target[method] = fn;
}
function restorePrisma() {
  for (const path of Object.keys(prismaOriginals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = prismaOriginals[path];
  }
}

async function main() {
  // =====================================================================
  // 1. Pure helpers
  // =====================================================================
  expect("regularSeasonStartKey(2025) sits before Opening Day", regularSeasonStartKey(2025), "2025-03-01");
  expect("inningsPitchedToInnings('6.1') = 6 + 1/3", Math.round(inningsPitchedToInnings("6.1") * 1000) / 1000, 6.333);
  expect("inningsPitchedToInnings('6.2') = 6 + 2/3", Math.round(inningsPitchedToInnings("6.2") * 1000) / 1000, 6.667);
  expect("inningsPitchedToInnings('7.0') = 7", inningsPitchedToInnings("7.0"), 7);

  // findAggregateSplit: synthetic + real fixture
  expect(
    "findAggregateSplit prefers the no-team aggregate",
    findAggregateSplit([{ team: { id: 1 } }, { team: { id: 2 } }, { stat: { era: "3.00" } }])?.stat?.era,
    "3.00"
  );
  expect(
    "findAggregateSplit falls back to splits[0] for a single-team season",
    findAggregateSplit([{ team: { id: 1 }, stat: { era: "2.50" } }])?.stat?.era,
    "2.50"
  );
  expect("findAggregateSplit(undefined) = undefined", findAggregateSplit(undefined), undefined);

  // =====================================================================
  // 2. Starter identification against a real recorded slate
  // =====================================================================
  stubFetch((url) => {
    if (url.includes("/schedule")) return scheduleFixture;
    return undefined;
  });
  const sched = await fetchMlbScheduleWithProbables("2025-06-15", "2025-06-15");
  restoreFetch();

  const g777505 = sched.find((g) => g.gamePk === "777505")!;
  ok("schedule: game 777505 present and Final", !!g777505 && g777505.isFinal, g777505);
  expect("schedule: 777505 home probable = Tyler Holton", g777505.homeProbable, { id: 663947, name: "Tyler Holton" });
  expect("schedule: 777505 away probable = Wade Miley", g777505.awayProbable, { id: 489119, name: "Wade Miley" });
  expect("schedule: 777505 team names carried through", [g777505.homeTeamName, g777505.awayTeamName], [
    "Detroit Tigers",
    "Cincinnati Reds",
  ]);

  stubFetch((url) => (url.includes("/boxscore") ? boxscoreFixture : undefined));
  const actual = await fetchActualStarters("777505");
  restoreFetch();
  expect("boxscore: 777505 home actual starter = pitchers[0] (Holton)", actual?.home, { id: 663947, name: "Tyler Holton" });
  expect("boxscore: 777505 away actual starter = pitchers[0] (Miley)", actual?.away, { id: 489119, name: "Wade Miley" });

  // reconcile guard: pitchers[0] explicitly flagged as a non-starter -> null
  const doctored = JSON.parse(JSON.stringify(boxscoreFixture));
  doctored.teams.home.players["ID663947"].stats.pitching.gamesStarted = 0;
  stubFetch((url) => (url.includes("/boxscore") ? doctored : undefined));
  const guarded = await fetchActualStarters("777505");
  restoreFetch();
  expect("boxscore guard: slot-0 pitcher with gamesStarted=0 is rejected", guarded?.home, null);
  expect("boxscore guard: the other side is unaffected", guarded?.away, { id: 489119, name: "Wade Miley" });

  // =====================================================================
  // 3. Point-in-time byDateRange window + traded-pitcher aggregation
  // =====================================================================
  stubFetch((url) => (url.includes("/people") && url.includes("byDateRange") ? byDateRangeBatch : undefined));
  const lines = await fetchPointInTimePitcherLines([554430, 450203], "2025-06-14", 2025);
  const requestedUrl = fetchCalls[0];
  restoreFetch();

  ok(
    "byDateRange request carries startDate = regular-season start",
    requestedUrl.includes("startDate=2025-03-01"),
    requestedUrl
  );
  ok("byDateRange request carries the caller's endDate verbatim", requestedUrl.includes("endDate=2025-06-14"), requestedUrl);

  const morton = lines.get(450203)!;
  expect("traded pitcher: Morton resolves to the no-team AGGREGATE line (ERA)", morton.era, 5.51);
  expect("traded pitcher: Morton aggregate WHIP", morton.whip, 1.51);
  expect("traded pitcher: Morton aggregate K/9 (from strikeoutsPer9Inn)", morton.k9, 9.52);
  expect("traded pitcher: Morton aggregate BB/9 (from walksPer9Inn)", morton.bb9, 4.22);
  ok(
    "traded pitcher: aggregate is NOT either single-team split",
    morton.era !== 5.42 && morton.era !== 5.81,
    morton.era
  );

  const wheeler = lines.get(554430)!;
  expect("single-team pitcher: Wheeler line (ERA)", wheeler.era, 2.71);
  expect("single-team pitcher: Wheeler K/9", wheeler.k9, 11.73);

  // a cutoff before the season even opened -> empty map, and NO request made
  stubFetch(() => byDateRangeBatch);
  const preSeason = await fetchPointInTimePitcherLines([554430], "2025-02-01", 2025);
  const madeRequest = fetchCalls.length > 0;
  restoreFetch();
  expect("cutoff before Opening Day returns nothing", preSeason.size, 0);
  ok("cutoff before Opening Day makes no API call at all", madeRequest === false);

  // k9/bb9 fall back to a raw compute when the per-9 fields are absent
  const rawStat = { era: "3.00", whip: "1.00", strikeOuts: 50, baseOnBalls: 10, inningsPitched: "50.0", outs: 150 };
  const rawLine = pitcherLineFromStat(111, "Raw", "2025-06-14", rawStat);
  expect("k9 computed from raw when strikeoutsPer9Inn absent", rawLine.k9, 9);
  expect("bb9 computed from raw when walksPer9Inn absent", rawLine.bb9, 1.8);

  // =====================================================================
  // 4. getHistoricalStartingMatchup: reader end to end, point-in-time
  //    regression (Zone Model look-ahead shape)
  // =====================================================================
  const GAME_DATE = new Date("2025-06-15T17:10:00.000Z"); // 1:10pm ET
  const DAY_OF_KEY = "2025-06-15";
  const DAY_BEFORE_KEY = "2025-06-14";

  const gameStartersRow = {
    id: "gs1",
    sportKey: "baseball_mlb",
    externalId: "777505",
    gameDate: GAME_DATE,
    homeStartingPitcherId: 663947,
    homeStartingPitcherName: "Tyler Holton",
    awayStartingPitcherId: null,
    awayStartingPitcherName: null,
    homeProbablePitcherId: 663947,
    homeProbablePitcherName: "Tyler Holton",
    awayProbablePitcherId: 489119,
    awayProbablePitcherName: "Wade Miley",
  };

  // 4a. No stored snapshot -> falls through to the API, cut at day-before.
  // The stub echoes back a byDateRange line for whatever personId was asked
  // for, so both sides resolve.
  const byDateRangeFor = (url: string) => {
    const id = Number(url.match(/personIds=(\d+)/)?.[1]);
    return {
      people: [
        {
          id,
          fullName: `Pitcher ${id}`,
          stats: [
            {
              type: { displayName: "byDateRange" },
              group: { displayName: "pitching" },
              splits: [{ stat: { era: "3.33", whip: "1.10", strikeOuts: 60, baseOnBalls: 15, inningsPitched: "60.0", strikeoutsPer9Inn: "9.00", walksPer9Inn: "2.25" } }],
            },
          ],
        },
      ],
    };
  };
  patch("gameStarters.findUnique", async () => gameStartersRow);
  patch("pitcherStatSnapshot.findMany", async () => []);
  stubFetch((url) => (url.includes("byDateRange") ? byDateRangeFor(url) : undefined));
  const m1 = await getHistoricalStartingMatchup("baseball_mlb", "777505");
  const apiUrls = [...fetchCalls];
  restoreFetch();

  expect("matchup: asOfDateKey is the day BEFORE the game", m1?.asOfDateKey, DAY_BEFORE_KEY);
  expect("matchup: home starter resolved from the ACTUAL field", m1?.home.starter, {
    pitcherId: 663947,
    pitcherName: "Tyler Holton",
    source: "actual",
  });
  expect("matchup: away starter falls back to PROBABLE (no actual stored)", m1?.away.starter, {
    pitcherId: 489119,
    pitcherName: "Wade Miley",
    source: "probable",
  });
  ok(
    "matchup: every byDateRange call ends strictly BEFORE the game's own day",
    apiUrls.every((u) => !u.includes("byDateRange") || u.includes(`endDate=${DAY_BEFORE_KEY}`)),
    apiUrls
  );
  ok(
    "matchup: no byDateRange call ever carries the game's own date",
    apiUrls.every((u) => !u.includes(`endDate=${DAY_OF_KEY}`)),
    apiUrls
  );
  expect("matchup: away line came from the API", m1?.away.lineSource, "api");
  expect("matchup: away API line value carried through", m1?.away.line?.era, 3.33);

  // 4b. LOOK-AHEAD REGRESSION: a snapshot dated the game's OWN day must be
  //     ignored; an older one is used instead. No API call needed.
  patch("gameStarters.findUnique", async () => gameStartersRow);
  patch("pitcherStatSnapshot.findMany", async ({ where }: { where: { pitcherId: number } }) => {
    // Same-day row has a deliberately wrong ERA so selecting it would show.
    return [
      { pitcherId: where.pitcherId, pitcherName: "P", snapshotDate: "2025-06-13", era: 3.0, whip: 1.0, strikeouts: 40, walks: 10, inningsPitched: "45.0" },
      { pitcherId: where.pitcherId, pitcherName: "P", snapshotDate: DAY_OF_KEY, era: 9.99, whip: 9.99, strikeouts: 0, walks: 0, inningsPitched: "0.0" },
    ];
  });
  let sawFetch = false;
  stubFetch(() => {
    sawFetch = true;
    return byDateRangeBatch;
  });
  const m2 = await getHistoricalStartingMatchup("baseball_mlb", "777505");
  restoreFetch();

  expect("look-ahead: home line uses the 06-13 snapshot, NOT the 06-15 same-day row", m2?.home.line?.era, 3.0);
  expect("look-ahead: away line likewise", m2?.away.line?.era, 3.0);
  expect("look-ahead: lineSource is the stored snapshot", m2?.home.lineSource, "snapshot");
  ok("look-ahead: a usable prior snapshot means no API fallback", sawFetch === false);

  // 4c. Unknown game -> null.
  patch("gameStarters.findUnique", async () => null);
  const m3 = await getHistoricalStartingMatchup("baseball_mlb", "does-not-exist");
  expect("matchup: unknown externalId returns null", m3, null);

  restorePrisma();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
