// Single-flight for cached reads, and the read-only contract it depends on.
//
// 1. cachedByTag: N concurrent calls on a cold key run the callback ONCE. A
//    rejection reaches every waiting caller and is not cached. Nothing is held
//    after the promise settles (no TTL of its own).
// 2. getOddsForSport: N concurrent calls on a cold key -> one OddsSnapshot read.
// 3. createRequestOddsLoader: one load per sport for the loader's life, however
//    the calls are spaced; a failed load is retried.
// 4. Roster reads (NFL / NHL / MLB): one table read per 60 s per process.
// 5. Sharing one object between callers is only safe if nobody edits it in
//    place. Every value below is DEEP-FROZEN and then pushed through its real
//    consumers; a consumer that sorts, pushes, splices or assigns onto what it
//    was handed throws here (modules are strict).
//
// No database, no network: prisma delegates are swapped for spies, global fetch
// serves a canned schedule, and the clock is frozen on a day when NFL, NCAAF,
// NHL and MLB are all in season (getOddsForSport never reads the table for an
// out-of-season sport). Outside a Next request context cachedByTag has no Data
// Cache and runs its callback directly, so every call here is a cold key.
//
// Run with:
//   npx tsx src/server/data/cached-single-flight-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { cachedByTag } from "./cached";
import { __clearTtlMemo } from "./ttl-memo";
import {
  getOddsForSport,
  createRequestOddsLoader,
  resolveGameForNickname,
  resolveGameForTeams,
  resolveOddsGame,
  findFavoredSide,
  findMarketPrice,
  findMarketSpreadLine,
  findMarketTotalLine,
  type OddsGame,
  type TickerOddsGame,
} from "./odds";
import { resolvePropOdds } from "./nfl-prop-odds";
import { persistFinalScores } from "./grading";
import { buildTickerGamesForSport, interleaveByCommenceTime } from "./live-ticker";
import { getCachedNflRoster } from "./nfl-roster-cache";
import { getCachedNhlRoster } from "./nhl-roster-cache";
import { getCachedMlbRoster } from "./mlb-roster-cache";
import { matchNflPlayerName } from "./nfl-boxscore-match";
import { dropPhantomCards } from "@/lib/live-board-dedup";
import { hasGameWithinActivityWindow } from "@/lib/ambiguous-hierarchy";
import { slateCutoffKey } from "@/components/live/live-scoreboard-ordering";
import { easternDateKey } from "@/lib/dates";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// ---- frozen clock ----
const NOW = Date.parse("2026-10-06T16:00:00Z");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW);
    else super(...(args as [string]));
  }
  static now() {
    return NOW;
  }
}
(globalThis as { Date: unknown }).Date = FakeDate;
const at = (hours: number) => new RealDate(NOW + hours * 3600000).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

// ---- fixtures ----
type Book = OddsGame["bookmakers"][number];
function book(key: string, home: string, away: string, n: number): Book {
  return {
    key,
    title: key,
    markets: [
      { key: "h2h", outcomes: [{ name: home, price: -150 - n }, { name: away, price: 130 + n }] },
      { key: "spreads", outcomes: [{ name: home, price: -110, point: -3.5 }, { name: away, price: -108, point: 3.5 }] },
      { key: "totals", outcomes: [{ name: "Over", price: -112, point: 44.5 }, { name: "Under", price: -106, point: 44.5 }] },
    ],
  };
}
function game(sportKey: string, id: string, home: string, away: string, hours: number): OddsGame {
  return { id, sportKey, homeTeam: home, awayTeam: away, commenceTime: at(hours), bookmakers: [book("bookA", home, away, 0), book("bookB", home, away, 5)] };
}

const NFL = "americanfootball_nfl";
const MLB = "baseball_mlb";
const kelceGame = game(NFL, "nfl1", "Kansas City Chiefs", "Buffalo Bills", 26);
kelceGame.bookmakers[0].markets.push({
  key: "player_reception_yds",
  outcomes: [
    { name: "Over", description: "Travis Kelce", price: -115, point: 42.5 },
    { name: "Under", description: "Travis Kelce", price: -105, point: 42.5 },
  ],
} as Book["markets"][number]);
// Already final (started three hours ago) - the game persistFinalScores derives
// ledger fields for.
const FINAL_MLB = { pk: 991001, home: "New York Yankees", away: "Boston Red Sox", at: at(-3), hs: 5, as: 3 };

const SNAPSHOTS: Record<string, OddsGame[]> = deepFreeze({
  [NFL]: [kelceGame, game(NFL, "nfl2", "Philadelphia Eagles", "Dallas Cowboys", 27)],
  [MLB]: [game(MLB, "mlb0", FINAL_MLB.home, FINAL_MLB.away, -3), game(MLB, "mlb1", "Los Angeles Dodgers", "Chicago Cubs", 24)],
  icehockey_nhl: [game("icehockey_nhl", "nhl1", "Boston Bruins", "Toronto Maple Leafs", 25)],
});

// ---- spies ----
const counts = { oddsSnapshot: {} as Record<string, number>, nflRoster: 0, nhlRoster: 0, mlbRoster: 0 };
type Delegate = Record<string, (...args: unknown[]) => Promise<unknown>>;
const db = prisma as unknown as Record<string, Delegate> & { $queryRaw: unknown };

db.oddsSnapshot.findUnique = async (args: unknown) => {
  const { sportKey, fetchDate } = (args as { where: { sportKey_fetchDate: { sportKey: string; fetchDate: string } } }).where.sportKey_fetchDate;
  counts.oddsSnapshot[sportKey] = (counts.oddsSnapshot[sportKey] ?? 0) + 1;
  await sleep(20);
  const data = SNAPSHOTS[sportKey];
  return data ? { id: "snap-" + sportKey, sportKey, fetchDate, data } : null;
};

const rosterRow = (n: number, fullName: string, team: string, position: string) => {
  const [firstName, ...rest] = fullName.split(" ");
  return { id: "r" + n, fullName, firstName, lastName: rest.join(" "), team, position, espnPlayerId: "e" + n, mlbPlayerId: "m" + n };
};
const ROSTER_ROWS = [
  rosterRow(1, "Travis Kelce", "Kansas City Chiefs", "TE"),
  rosterRow(2, "Christian McCaffrey", "San Francisco 49ers", "RB"),
  rosterRow(3, "Luke McCaffrey", "Washington Commanders", "WR"),
  rosterRow(4, "Josh Allen", "Buffalo Bills", "QB"),
];
db.nflRosterPlayer.findMany = async () => (counts.nflRoster++, await sleep(10), ROSTER_ROWS);
db.nhlRosterPlayer.findMany = async () => (counts.nhlRoster++, await sleep(10), ROSTER_ROWS);
db.mlbRosterPlayer.findMany = async () => (counts.mlbRoster++, await sleep(10), ROSTER_ROWS);

// persistFinalScores: no existing rows; capture what it would write.
const upserts: { create: Record<string, unknown> }[] = [];
db.$queryRaw = async () => [];
db.gameResult.upsert = async (args: unknown) => (upserts.push(args as { create: Record<string, unknown> }), {});

globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("statsapi.mlb.com/api/v1/schedule")) {
    return json({
      dates: [
        {
          games: [
            {
              gamePk: FINAL_MLB.pk,
              gameDate: FINAL_MLB.at,
              gameNumber: 1,
              doubleHeader: "N",
              status: { abstractGameState: "Final" },
              teams: { home: { team: { name: FINAL_MLB.home }, score: FINAL_MLB.hs }, away: { team: { name: FINAL_MLB.away }, score: FINAL_MLB.as } },
              linescore: { innings: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ num: n, home: { runs: n === 1 ? 5 : 0 }, away: { runs: n === 2 ? 3 : 0 } })) },
            },
          ],
        },
      ],
    });
  }
  if (url.includes("/feed/live")) {
    return json({ liveData: { linescore: { innings: [1, 2, 3, 4, 5].map((n) => ({ num: n, home: { runs: n === 1 ? 5 : 0 }, away: { runs: n === 2 ? 3 : 0 } })) } } });
  }
  // Every ESPN scoreboard: no events.
  return json({ events: [], dates: [] });
}) as typeof fetch;

const N = 50;

async function main() {
  // ---- 1. cachedByTag ----
  {
    let runs = 0;
    const fn = async () => (runs++, await sleep(20), { value: [3, 1, 2] });
    const results = await Promise.all(Array.from({ length: N }, () => cachedByTag("sf:a", 60, fn)));
    check(`${N} concurrent calls on a cold key run the callback once`, runs === 1, `(${runs} runs)`);
    check("every caller got the same object", results.every((r) => r === results[0]));

    await cachedByTag("sf:a", 60, fn);
    check("nothing is held after the promise settles (the next call runs again)", runs === 2, `(${runs} runs)`);

    let otherRuns = 0;
    await Promise.all([cachedByTag("sf:b", 60, fn), cachedByTag("sf:c", 60, async () => (otherRuns++, 1))]);
    check("different keys do not share a flight", runs === 3 && otherRuns === 1, `(${runs}, ${otherRuns})`);

    let joinerRan = false;
    await Promise.all([cachedByTag("sf:d", 60, fn), cachedByTag("sf:d", 60, async () => ((joinerRan = true), { value: [] }))]);
    check("a joiner's own callback does not run", joinerRan === false);

    let failing = 0;
    const boom = async () => {
      failing++;
      await sleep(10);
      throw new Error("db down");
    };
    const settled = await Promise.allSettled(Array.from({ length: N }, () => cachedByTag("sf:err", 60, boom)));
    check("a rejection reaches every waiting caller", settled.every((s) => s.status === "rejected") && failing === 1, `(${failing} runs)`);
    let recovered = 0;
    const ok = await cachedByTag("sf:err", 60, async () => (recovered++, "fine"));
    check("the rejection was not cached - the next call runs and succeeds", ok === "fine" && recovered === 1);
  }

  // ---- 2. getOddsForSport ----
  {
    counts.oddsSnapshot = {};
    const results = await Promise.all(Array.from({ length: N }, () => getOddsForSport(NFL)));
    check(`${N} concurrent getOddsForSport calls on a cold key -> 1 OddsSnapshot read`, counts.oddsSnapshot[NFL] === 1, `(${counts.oddsSnapshot[NFL]} reads)`);
    check("all of them resolved the same games", results.every((r) => r === results[0]) && results[0].length === 2);
    await Promise.all([getOddsForSport(NFL), getOddsForSport(MLB), getOddsForSport(NFL), getOddsForSport(MLB)]);
    check("two sports at once -> one read each", counts.oddsSnapshot[NFL] === 2 && counts.oddsSnapshot[MLB] === 1, JSON.stringify(counts.oddsSnapshot));
  }

  // ---- 3. createRequestOddsLoader ----
  {
    counts.oddsSnapshot = {};
    const getOdds = createRequestOddsLoader();
    await Promise.all(Array.from({ length: N }, () => getOdds(NFL)));
    await getOdds(NFL);
    await sleep(30);
    await Promise.all([getOdds(NFL), getOdds(MLB), getOdds(MLB)]);
    check("one read per sport for the loader's life, concurrent or spaced out", counts.oddsSnapshot[NFL] === 1 && counts.oddsSnapshot[MLB] === 1, JSON.stringify(counts.oddsSnapshot));

    let attempts = 0;
    const flaky = createRequestOddsLoader(async () => {
      attempts++;
      if (attempts === 1) throw new Error("blip");
      return [];
    });
    const first = await flaky(NFL).then(() => "ok", () => "failed");
    const second = await flaky(NFL).then(() => "ok", () => "failed");
    await flaky(NFL);
    check("a failed load is not held - the next call retries, then the result is kept", first === "failed" && second === "ok" && attempts === 2, `(${attempts} attempts)`);
  }

  // ---- 4. roster reads ----
  {
    __clearTtlMemo();
    for (const [name, read, key] of [
      ["NFL", getCachedNflRoster, "nflRoster"],
      ["NHL", getCachedNhlRoster, "nhlRoster"],
      ["MLB", getCachedMlbRoster, "mlbRoster"],
    ] as const) {
      const all = await Promise.all(Array.from({ length: 30 }, () => read()));
      await read();
      await read();
      check(`${name} roster: 32 calls -> 1 table read`, counts[key] === 1, `(${counts[key]} reads)`);
      check(`${name} roster rows are mapped as before`, all[0].length === 4 && all[0][0].playerName === "Travis Kelce" && all[0][0].externalPlayerId.length === 2);
    }
    __clearTtlMemo();
    await getCachedNflRoster();
    check("the roster memo is a TTL entry, not permanent (cleared -> reads again)", counts.nflRoster === 2, `(${counts.nflRoster} reads)`);
  }

  // ---- 5. deep-frozen values through their real consumers ----
  // Any in-place edit of a frozen value throws; reaching the end is the proof.
  try {
    const games = await getOddsForSport(NFL);
    check("getOddsForSport handed back the frozen snapshot itself", Object.isFrozen(games) && Object.isFrozen(games[0].bookmakers[0].markets));

    // Import: game match (odds feed, since the score feed is empty) + pricing + props.
    const ref = { homeTeam: kelceGame.homeTeam, awayTeam: kelceGame.awayTeam, commenceTime: kelceGame.commenceTime };
    const byNick = await resolveGameForNickname(NFL, "chiefs");
    const byTeams = await resolveGameForTeams(NFL, "chiefs", "bills");
    const priced = {
      oddsGame: (await resolveOddsGame(NFL, ref))?.id,
      favored: await findFavoredSide(NFL, ref),
      ml: await findMarketPrice(NFL, ref, "MONEYLINE", "away"),
      spread: await findMarketSpreadLine(NFL, ref, "home"),
      total: await findMarketTotalLine(NFL, ref, "over"),
      prop: await resolvePropOdds(NFL, ref, { playerName: "Travis Kelce", propMarket: "REC_YDS", side: "Over", point: 42.5 } as never),
    };
    check(
      "import resolvers read frozen odds without editing them",
      byNick.game?.homeTeam === "Kansas City Chiefs" && byTeams.game?.awayTeam === "Buffalo Bills" &&
        JSON.stringify(priced) === JSON.stringify({ oddsGame: "nfl1", favored: "HOME", ml: 130, spread: -3.5, total: 44.5, prop: -115 }),
      JSON.stringify(priced)
    );

    // Disambiguation's league-activity check.
    check("activity-window check reads frozen odds", hasGameWithinActivityWindow(games, new Date()) === true);

    // /live board: slate scoping, then phantom-card dedup over today's + yesterday's games.
    const todayKey = easternDateKey(new Date());
    const cutoff = slateCutoffKey(games.map((g) => g.commenceTime), todayKey);
    const board = games.filter((g) => easternDateKey(new Date(g.commenceTime)) <= cutoff);
    const yesterday = SNAPSHOTS.icehockey_nhl; // stands in for getYesterdayOddsForSport's (also cached) result
    const deduped = dropPhantomCards([...board, ...yesterday], []);
    check("/live board scoping + phantom-card dedup read frozen odds", deduped.games.length === board.length + yesterday.length);

    // Grading: ledger fields (favorite + total line) for a newly final game.
    upserts.length = 0;
    const persisted = await persistFinalScores(MLB);
    const row = upserts[0]?.create ?? {};
    check(
      "persistFinalScores derives ledger fields from frozen odds",
      persisted === 1 && row.favTeam === FINAL_MLB.home && row.totalLine === 44.5 && row.lineSource === "odds_snapshot",
      JSON.stringify({ persisted, favTeam: row.favTeam, totalLine: row.totalLine })
    );

    // Layout ticker: the slim per-sport odds slice (its own cachedByTag entry).
    const tickerOdds: TickerOddsGame[] = deepFreeze(
      SNAPSHOTS[NFL].map((g) => ({ id: g.id, homeTeam: g.homeTeam, awayTeam: g.awayTeam, commenceTime: g.commenceTime }))
    );
    const ticker = interleaveByCommenceTime([
      buildTickerGamesForSport(NFL, "NFL", tickerOdds, [], new Date()),
      buildTickerGamesForSport(MLB, "MLB", deepFreeze([]), [], new Date()),
    ]);
    check("ticker build + interleave read frozen ticker odds", Array.isArray(ticker));

    // Rosters: the memoized array, as prop grading uses it (name match, QB filter).
    __clearTtlMemo();
    const roster = deepFreeze(await getCachedNflRoster());
    const again = await getCachedNflRoster();
    const shared = matchNflPlayerName("McCaffrey", again, (r) => r.playerName, (r) => r.externalPlayerId, { getLastName: (r) => r.lastName, allowFuzzy: false });
    const one = matchNflPlayerName("Travis Kelce", again, (r) => r.playerName, (r) => r.externalPlayerId, { getLastName: (r) => r.lastName, allowFuzzy: false });
    const qbs = again.filter((r) => r.position === "QB");
    check(
      "prop grading's roster matching reads the frozen, shared roster",
      again === roster && shared.status === "many" && one.status === "one" && qbs.length === 1,
      `(${shared.status}, ${one.status}, ${qbs.length} QB)`
    );
  } catch (err) {
    check("no consumer edits a shared value in place", false, String(err instanceof Error ? err.stack : err));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
