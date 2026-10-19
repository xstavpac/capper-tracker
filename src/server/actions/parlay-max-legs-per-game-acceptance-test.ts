// Proof that autoGenerateParlayAction's "max legs per game" reaches the
// generator, defaults to 1, and never changes Parlay A, Hedge or Contrarian.
//
// The real action runs over the frozen slate (auto-generate-frozen-fixture.ts).
// Only what it loads from is replaced: the signed-in user, the live board and
// the record lookups.
// Run: npx tsx src/server/actions/parlay-max-legs-per-game-acceptance-test.ts
// Exits non-zero if any assertion fails.
import { FROZEN_CATEGORY_RECORDS, FROZEN_GAMES, FROZEN_LEAGUE_RECORDS } from "@/lib/parlay/auto-generate-frozen-fixture";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// The clock sits before every fixture game, on their own Eastern day.
const RealDate = Date;
const NOW = new RealDate("2026-09-23T15:00:00.000Z").getTime();
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW);
    else super(...(args as [number]));
  }
  static now() {
    return NOW;
  }
}
globalThis.Date = FixedDate as DateConstructor;

function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../auth", { requireUser: async () => ({ id: "user-1" }) });
stub("../data/odds", { LIVE_SPORTS: [{ key: "baseball_mlb", label: "MLB" }] });
// The board as the action reads it: no doubleheader flag on the games - the
// action has to work that out itself from the two same-teams cards.
stub("../data/live-board-picks", {
  getLiveBoardData: async () => ({
    odds: FROZEN_GAMES.map((g) => ({ id: g.gameId, commenceTime: g.gameTime, homeTeam: g.picks[0].homeTeam, awayTeam: g.picks[0].awayTeam })),
    scores: [],
    expanderPicksByGame: FROZEN_GAMES.map((g) => g.picks),
  }),
});
stub("../data/picks", {
  getCapperLeagueRecords: async () => FROZEN_LEAGUE_RECORDS,
  getCapperCategoryRecords: async () => FROZEN_CATEGORY_RECORDS,
  getCapperRecordBundle: async () => ({ leagueRecords: FROZEN_LEAGUE_RECORDS, categoryRecords: FROZEN_CATEGORY_RECORDS }),
  categoryRecordKey: (capperId: string, category: string) => capperId + "|" + category,
});

async function main() {
  const { autoGenerateParlayAction } = await import("./parlay-generator");
  async function generate(legCount: number, maxLegsPerGame?: number) {
    const r = maxLegsPerGame === undefined ? await autoGenerateParlayAction(["MLB"], legCount) : await autoGenerateParlayAction(["MLB"], legCount, maxLegsPerGame);
    if ("error" in r) throw new Error(r.error);
    return r;
  }
  const added = (r: Awaited<ReturnType<typeof generate>>) => r.sameGame.legs.map((l) => l.pick.pickId);

  const byDefault = await generate(20);
  const one = await generate(20, 1);
  const two = await generate(20, 2);
  const three = await generate(20, 3);

  check("no setting sent: max 1, no same-game legs", [byDefault.sameGame.maxLegsPerGame, added(byDefault)], [1, []]);
  check("max 1: no same-game legs", added(one), []);
  check("max 2: one extra leg per game where one qualifies and fits", added(two), ["g2-c", "g4-b", "g1-d"]);
  check("max 3: a third where one fits", added(three), ["g2-c", "g4-b", "g1-d", "g1-b", "g2-d"]);
  check("the action marked the doubleheader itself: game 2's pick with no game number is not paired", added(three).includes("g5-b"), false);

  const core = (r: Awaited<ReturnType<typeof generate>>) => JSON.stringify([r.parlayA, r.hedge, r.contrarian]);
  check("Parlay A, Hedge and Contrarian are identical at max 1, 2 and 3", [core(two) === core(one), core(three) === core(one), core(byDefault) === core(one)], [true, true, true]);
  check("Hedge and Contrarian have Parlay A's 5 legs at max 3, not 10", [three.hedge.legs.length, three.contrarian.legs.length], [5, 5]);

  check("a setting that isn't 1, 2 or 3 is treated as 1", [(await generate(20, 7)).sameGame, (await generate(20, 0)).sameGame], [{ maxLegsPerGame: 1, legs: [] }, { maxLegsPerGame: 1, legs: [] }]);
  check("enough games for the count asked: nothing added even at max 3", added(await generate(5, 3)), []);
  const capped = await autoGenerateParlayAction(["MLB"], 21, 3);
  check("past the leg cap is still refused", "error" in capped, true);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
