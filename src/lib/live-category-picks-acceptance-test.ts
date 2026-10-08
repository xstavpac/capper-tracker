// Correctness proof for the /live category panel's slate list
// (live-category-picks.ts). Covers:
//   1. the pool - only picks on cards the board is showing, CANCELLED dropped,
//      and a tile's count equal to the length of the list it opens
//   2. the driving record - league+category from 10 decided picks, otherwise
//      all-time category (incl. a 4-2 league record next to a 27-17-2 all-time
//      one), otherwise none
//   3. the order - Wilson lower bound, then decided picks, game time, pick id;
//      no-record picks last; duplicates and repeat cappers kept as rows
//   4. the row - rank, pick, capper, and the game it opens - and the
//      weekly-league wording
//   5. the "Show N more" / "X of Y" maths
//   6. the tiles, incl. the 0-0 tile for a category with picks but no history
//   7. the 0-pick tile: still a tile, counts 0, opens to one line, no button
// Run with:
//   npx tsx src/lib/live-category-picks-acceptance-test.ts
//
// Exits non-zero if any assertion fails.
import type { LeagueRecordCard, PickCategoryKey } from "@/server/data/stats";
import type { ScoreGame } from "@/server/data/odds";
import {
  LIVE_LEAGUE_SPLIT_MIN_SAMPLE,
  buildCategoryTiles,
  categoryPickRows,
  drivingRecord,
  rankCategoryPicks,
  revealState,
  slateCountText,
  slateEmptyText,
  slateListHeader,
  slatePicksByCategory,
  visibleGameIndexes,
  type DrivingRecord,
  type LiveCategoryPick,
} from "./live-category-picks";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

const col = (wins: number, losses: number, pushes = 0) => ({
  wins,
  losses,
  pushes,
  winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
  count: wins + losses + pushes,
});
const card = (overall: [number, number, number?], league: [number, number, number?]): LeagueRecordCard => ({
  category: "FAV_ML",
  label: "Fav ML",
  overall: col(...overall),
  league: col(...league),
});

let seq = 0;
const pick = (over: Partial<LiveCategoryPick> & { capperId: string }): LiveCategoryPick => ({
  pickId: "p" + String(++seq).padStart(3, "0"),
  gameIndex: 0,
  category: "FAV_ML",
  betDetail: "Padres ML",
  capperName: over.capperId,
  status: "PENDING",
  gameTime: "2026-08-29T19:00:00-04:00",
  ...over,
});
// The record a pick was ranked on, for the order assertions only - no row shows it.
const rankedOn = (r: DrivingRecord | null) => (r ? r.wins + "-" + r.losses + " " + r.source : "none");
const key = (capperId: string, category: PickCategoryKey = "FAV_ML", league = "MLB") => capperId + "|" + league + "|" + category;

// ---- 1. the pool ----

{
  const TODAY = "2026-08-29";
  const games = [
    { id: "g-padres", homeTeam: "Padres", awayTeam: "Giants", commenceTime: "2026-08-29T19:00:00-04:00" }, // upcoming
    { id: "g-dodgers", homeTeam: "Dodgers", awayTeam: "Rockies", commenceTime: "2026-08-29T13:00:00-04:00" }, // final
    { id: "g-mets", homeTeam: "Mets", awayTeam: "Braves", commenceTime: "2026-08-29T16:00:00-04:00" }, // live
    { id: "g-cubs", homeTeam: "Cubs", awayTeam: "Reds", commenceTime: "2026-08-28T22:00:00-04:00" }, // last night, not live
  ];
  const score = (i: number, status: ScoreGame["status"]) => ({ ...games[i], status }) as ScoreGame;
  const visible = visibleGameIndexes(games, [score(1, "final"), score(2, "live")], TODAY);
  expect("visible games = the board's: upcoming + live, no final, no dead carry-over", Array.from(visible).sort(), [0, 2]);

  const pool = [
    pick({ capperId: "a", gameIndex: 0 }),
    pick({ capperId: "b", gameIndex: 0, status: "CANCELLED" }),
    pick({ capperId: "c", gameIndex: 1 }), // final game
    pick({ capperId: "d", gameIndex: 2, status: "WIN", category: "NRFI" }), // graded, game still live
    pick({ capperId: "e", gameIndex: 2, status: "LOSS" }),
    pick({ capperId: "f", gameIndex: 2, status: "PUSH" }),
    pick({ capperId: "g", gameIndex: 0, category: null }),
    pick({ capperId: "h", gameIndex: 3 }),
  ];
  const byCategory = slatePicksByCategory(pool, visible);
  expect(
    "pool keeps Pending/Win/Loss/Push on visible cards; drops Cancelled, hidden games, no-category",
    Array.from(byCategory, ([k, v]) => [k, v.map((p) => p.capperId)]),
    [
      ["FAV_ML", ["a", "e", "f"]],
      ["NRFI", ["d"]],
    ]
  );
  const favMl = byCategory.get("FAV_ML") ?? [];
  expect("tile count === length of the list it opens", rankCategoryPicks(favMl, "MLB", {}).length, favMl.length);
  expect("no board mounted (no visible games) -> every count is 0", slatePicksByCategory(pool, new Set()).size, 0);
}

// ---- 2. the driving record ----

expect("the league split needs 10 decided picks", LIVE_LEAGUE_SPLIT_MIN_SAMPLE, 10);
expect("10 league decided -> league record", drivingRecord(card([31, 14], [6, 4])), { wins: 6, losses: 4, pushes: 0, source: "LEAGUE" });
expect("pushes count toward the 10", drivingRecord(card([31, 14, 2], [6, 3, 1])), { wins: 6, losses: 3, pushes: 1, source: "LEAGUE" });
expect("9 league decided -> all-time record", drivingRecord(card([31, 14], [8, 1])), { wins: 31, losses: 14, pushes: 0, source: "ALL_TIME" });
expect(
  "Line Mover Leo: 4-2 in the league, 27-17-2 all-time -> ranked on all-time",
  drivingRecord(card([27, 17, 2], [4, 2])),
  { wins: 27, losses: 17, pushes: 2, source: "ALL_TIME" }
);
expect("no league history at all -> all-time record", drivingRecord(card([12, 7], [0, 0])), { wins: 12, losses: 7, pushes: 0, source: "ALL_TIME" });
expect("no card -> no record", [drivingRecord(null), drivingRecord(undefined)], [null, null]);

// ---- 3. the order ----

{
  const picks = [
    pick({ capperId: "hot-2-0" }),
    pick({ capperId: "none" }),
    pick({ capperId: "leo" }),
    pick({ capperId: "gus", betDetail: "Dodgers ML" }),
    pick({ capperId: "gus", betDetail: "Padres ML" }),
    pick({ capperId: "coin-flip" }),
    pick({ capperId: "vinny" }), // same pick as others - its own row
  ];
  const records: Record<string, LeagueRecordCard | null> = {
    [key("hot-2-0")]: card([2, 0], [2, 0]),
    [key("none")]: null,
    [key("leo")]: card([27, 17, 2], [4, 2]),
    [key("gus")]: card([73, 60], [71, 58]),
    [key("coin-flip")]: card([25, 23], [25, 23]),
    [key("vinny")]: card([14, 9], [14, 9]),
  };
  const ranked = rankCategoryPicks(picks, "MLB", records);
  expect(
    "Wilson order: established records first (27-17 edges 71-58), 2-0 below them, no-record last; repeat capper and duplicate pick kept",
    ranked.map((r) => r.pick.capperId + " " + rankedOn(r.record)),
    [
      "leo 27-17 ALL_TIME",
      "gus 71-58 LEAGUE",
      "gus 71-58 LEAGUE",
      "vinny 14-9 LEAGUE",
      "coin-flip 25-23 LEAGUE",
      "hot-2-0 2-0 ALL_TIME",
      "none none",
    ]
  );
  expect("every pick is a row", ranked.length, picks.length);

  // Under the old 5-pick threshold Leo would have been ranked on 4-2 and sat
  // below the coin-flip capper; on all-time he is above.
  const order = ranked.map((r) => r.pick.capperId);
  expect("Leo outranks a 25-23 capper", order.indexOf("leo") < order.indexOf("coin-flip"), true);
}

{
  // Ties: identical records -> more decided picks cannot differ, so game time, then pick id.
  const same = card([20, 10], [20, 10]);
  const late = pick({ capperId: "x", gameTime: "2026-08-29T22:00:00-04:00" });
  const earlyB = pick({ capperId: "y", gameTime: "2026-08-29T13:00:00-04:00" });
  const earlyA = pick({ capperId: "z", gameTime: "2026-08-29T13:00:00-04:00", pickId: "a000" });
  const ranked = rankCategoryPicks([late, earlyB, earlyA], "MLB", { [key("x")]: same, [key("y")]: same, [key("z")]: same });
  expect("ties: earlier game first, then pick id", ranked.map((r) => r.pick.pickId), ["a000", earlyB.pickId, late.pickId]);

  // Same Wilson value is not reachable with different n in practice, so the
  // decided-picks tie-break is exercised with two zero-win records (both 0).
  const ranked2 = rankCategoryPicks([pick({ capperId: "s" }), pick({ capperId: "b" })], "MLB", {
    [key("s")]: card([0, 1], [0, 1]),
    [key("b")]: card([0, 4], [0, 4]),
  });
  expect("ties on Wilson: more decided picks first", ranked2.map((r) => r.pick.capperId), ["b", "s"]);

  const noRec = rankCategoryPicks(
    [pick({ capperId: "n1", gameTime: "2026-08-29T22:00:00-04:00" }), pick({ capperId: "n2", gameTime: "2026-08-29T13:00:00-04:00" }), pick({ capperId: "r" })],
    "MLB",
    { [key("r")]: card([0, 3], [0, 3]) }
  );
  expect("a losing record still ranks above no record; no-record picks by game time", noRec.map((r) => r.pick.capperId), ["r", "n2", "n1"]);
}

// ---- 4. the row ----

{
  const games = [
    { id: "g-padres", homeTeam: "Padres", awayTeam: "Giants", commenceTime: "2026-08-29T19:00:00-04:00" },
    { id: "g-dodgers", homeTeam: "Dodgers", awayTeam: "Rockies", commenceTime: "2026-08-29T22:00:00-04:00" },
  ];
  const picks = [
    pick({ capperId: "nr", capperName: "New Guy", betDetail: "Dodgers ML", gameIndex: 1 }),
    pick({ capperId: "sp", capperName: "Sean Perry", betDetail: "Dodgers ML", gameIndex: 1 }),
    pick({ capperId: "vn", capperName: "Vinny", gameIndex: 0 }),
    pick({ capperId: "dv", capperName: "Darth Vader", gameIndex: 0 }),
  ];
  const rows = categoryPickRows(
    rankCategoryPicks(picks, "MLB", {
      [key("dv")]: card([40, 12], [40, 12]),
      [key("vn")]: card([14, 9], [14, 9]),
      [key("sp")]: card([11, 9], [4, 2]),
      [key("nr")]: null,
    }),
    games
  );
  expect(
    "a row reads rank, pick, capper; the no-record pick is last with nothing said about it",
    rows.map((r) => r.rank + " " + r.pick + " " + r.capper),
    ["1 Padres ML Darth Vader", "2 Padres ML Vinny", "3 Dodgers ML Sean Perry", "4 Dodgers ML New Guy"]
  );
  expect("a row carries nothing else to show - no odds, no record", Object.keys(rows[0]).sort(), ["capper", "gameId", "pick", "pickId", "rank"]);
  expect("each row opens its own pick's game", rows.map((r) => r.gameId), ["g-padres", "g-padres", "g-dodgers", "g-dodgers"]);
}
expect(
  "tile count wording: daily leagues say Today, football says This week",
  ["MLB", "NBA", "NHL", "WNBA", "NFL", "NCAAF"].map((l) => slateCountText(l, 47)),
  ["Today: 47 picks", "Today: 47 picks", "Today: 47 picks", "Today: 47 picks", "This week: 47 picks", "This week: 47 picks"]
);
expect("0 and 1", [slateCountText("MLB", 0), slateCountText("MLB", 1)], ["Today: 0 picks", "Today: 1 pick"]);
expect("list header", [slateListHeader("MLB", "Fav ML"), slateListHeader("NFL", "Spread +")], ["Today's Fav ML Picks", "This Week's Spread + Picks"]);

// ---- 5. reveal ----

{
  const walk = (total: number) => {
    const steps: string[] = [];
    let requested = 5;
    for (;;) {
      const r = revealState(requested, total);
      steps.push(r.progress + (r.more > 0 ? " / Show " + r.more + " more" : ""));
      if (r.more === 0) return steps;
      requested = r.shown + 5;
    }
  };
  expect("47 picks: 5 at a time, last button is Show 2 more at 45 of 47", walk(47).slice(-3), ["40 of 47 / Show 5 more", "45 of 47 / Show 2 more", "47 of 47"]);
  expect("47 picks: first step", walk(47)[0], "5 of 47 / Show 5 more");
  expect("6 picks", walk(6), ["5 of 6 / Show 1 more", "6 of 6"]);
  expect("5 picks: all shown, no button", walk(5), ["5 of 5"]);
  expect("3 picks: all shown, no button", walk(3), ["3 of 3"]);
  // The list shrinking under an expanded reveal (a game went final) never over-reports.
  expect("requested past the end clamps", revealState(15, 12), { shown: 12, more: 0, progress: "12 of 12" });
}

// ---- 6. tiles ----

{
  const chipSet: { key: PickCategoryKey; label: string }[] = [
    { key: "FAV_ML", label: "Fav ML" },
    { key: "DOG_ML", label: "Dog ML" },
    { key: "NRFI", label: "NRFI" },
    { key: "YRFI", label: "YRFI" },
  ];
  const breakdown = [
    { key: "FAV_ML" as const, wins: 972, losses: 893, pushes: 2, winPct: 52.1 },
    { key: "DOG_ML" as const, wins: 40, losses: 60, pushes: 0, winPct: 40 },
  ];
  const tiles = buildCategoryTiles(chipSet, breakdown, new Map<PickCategoryKey, number>([["FAV_ML", 47], ["NRFI", 3], ["SPREAD", 2]]));
  expect(
    "history tiles stay (0 picks = still there), a no-history category appears only with picks, off-chip-set categories never",
    tiles.map((t) => [t.key, t.wins + "-" + t.losses, t.slateCount]),
    [
      ["FAV_ML", "972-893", 47],
      ["DOG_ML", "40-60", 0],
      ["NRFI", "0-0", 3],
    ]
  );
}

// ---- 7. the 0-pick tile ----

{
  const chipSet: { key: PickCategoryKey; label: string }[] = [
    { key: "FAV_ML", label: "Fav ML" },
    { key: "DOG_ML", label: "Dog ML" },
  ];
  const breakdown = [
    { key: "FAV_ML" as const, wins: 972, losses: 893, pushes: 2, winPct: 52.1 },
    { key: "DOG_ML" as const, wins: 40, losses: 60, pushes: 0, winPct: 40 },
  ];
  const byCategory = slatePicksByCategory([pick({ capperId: "a" })], new Set([0]));
  const tiles = buildCategoryTiles(chipSet, breakdown, new Map(Array.from(byCategory, ([k, list]) => [k, list.length])));
  const empty = tiles.find((t) => t.key === "DOG_ML");
  expect(
    "a 0-pick tile is the same tile as any other - its record intact, nothing marking it apart but the count",
    [Object.keys(empty ?? {}).sort(), empty],
    [Object.keys(tiles[0]).sort(), { key: "DOG_ML", label: "Dog ML", wins: 40, losses: 60, pushes: 0, winPct: 40, slateCount: 0 }]
  );
  expect("it says 0 picks", [slateCountText("MLB", 0), slateCountText("NFL", 0)], ["Today: 0 picks", "This week: 0 picks"]);
  expect(
    "it opens to one line: today for daily leagues, this week for football",
    ["MLB", "NBA", "NHL", "WNBA", "NFL", "NCAAF", "nfl"].map((l) => slateEmptyText(l, "Dog ML")),
    [
      "No Dog ML picks today",
      "No Dog ML picks today",
      "No Dog ML picks today",
      "No Dog ML picks today",
      "No Dog ML picks this week",
      "No Dog ML picks this week",
      "No Dog ML picks this week",
    ]
  );
  const opened = byCategory.get("DOG_ML") ?? [];
  expect("it has no rows and no Show-more button", [opened.length, revealState(5, opened.length).more], [0, 0]);
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll live-category-picks assertions passed");
