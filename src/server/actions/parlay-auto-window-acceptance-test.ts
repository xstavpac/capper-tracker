// Proof of Auto-Generate's time window: NFL and NCAAF build from the current
// football week's unstarted games - the Live board's slate for those leagues
// - while every other league stays today-only.
//
// The real autoGenerateParlayAction runs. Only what it loads from is
// replaced: the signed-in user, the live board, and the record lookups. The
// clock is fixed on a Tuesday at noon Eastern, with no football that day.
// Run: npx tsx src/server/actions/parlay-auto-window-acceptance-test.ts
// Exits non-zero if any assertion fails.

import type { ExpanderPick } from "@/components/live/game-picks-expander";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const RealDate = Date;
const NOW = new RealDate("2026-10-13T16:00:00.000Z").getTime(); // Tuesday, noon Eastern
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

type Fixture = { id: string; league: string; time: string; picks: number };
const GAMES: Fixture[] = [
  // NFL: last night's game (carried over on the board), this week's
  // Thursday / Sunday / Monday games, and next week's Thursday game.
  { id: "nfl-last-mon", league: "NFL", time: "2026-10-13T00:15:00.000Z", picks: 1 },
  { id: "nfl-thu", league: "NFL", time: "2026-10-16T00:15:00.000Z", picks: 1 },
  { id: "nfl-sun-early", league: "NFL", time: "2026-10-18T17:00:00.000Z", picks: 2 },
  { id: "nfl-sun-late", league: "NFL", time: "2026-10-18T20:25:00.000Z", picks: 1 },
  { id: "nfl-mon", league: "NFL", time: "2026-10-20T00:15:00.000Z", picks: 1 },
  { id: "nfl-next-thu", league: "NFL", time: "2026-10-23T00:15:00.000Z", picks: 1 },
  // NCAAF: a midweek game tonight, Saturday's, and the Saturday after.
  { id: "ncaaf-tue", league: "NCAAF", time: "2026-10-13T23:30:00.000Z", picks: 1 },
  { id: "ncaaf-sat", league: "NCAAF", time: "2026-10-17T19:30:00.000Z", picks: 1 },
  { id: "ncaaf-next-sat", league: "NCAAF", time: "2026-10-24T19:30:00.000Z", picks: 1 },
  // MLB: an afternoon game already under way, tonight's, and tomorrow's.
  { id: "mlb-started", league: "MLB", time: "2026-10-13T15:05:00.000Z", picks: 1 },
  { id: "mlb-tonight", league: "MLB", time: "2026-10-13T23:05:00.000Z", picks: 1 },
  { id: "mlb-tomorrow", league: "MLB", time: "2026-10-14T23:05:00.000Z", picks: 1 },
  // NHL: tonight's and Thursday's.
  { id: "nhl-tonight", league: "NHL", time: "2026-10-13T23:00:00.000Z", picks: 1 },
  { id: "nhl-thu", league: "NHL", time: "2026-10-15T23:00:00.000Z", picks: 1 },
];

function pick(game: Fixture, n: number): ExpanderPick {
  const home = "Home " + game.id;
  const away = "Away " + game.id;
  const id = game.id + "-p" + n;
  return {
    pickId: id, capperId: "capper-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false,
    category: null, leagueName: game.league, gameId: game.id, gameLabel: away + " @ " + home, betDetail: home + " ML",
    odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: home + " ML", line: null,
    homeTeam: home, awayTeam: away, gameTime: game.time, teamGroup: "HOME", teamLabel: home, teamColor: null,
    datePosted: "2026-10-12T13:00:00.000Z",
  };
}

let boardLoads: string[] = [];
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../auth", { requireUser: async () => ({ id: "user-1" }) });
stub("../data/odds", {
  LIVE_SPORTS: [
    { key: "baseball_mlb", label: "MLB" },
    { key: "americanfootball_nfl", label: "NFL" },
    { key: "americanfootball_ncaaf", label: "NCAAF" },
    { key: "icehockey_nhl", label: "NHL" },
  ],
});
stub("../data/live-board-picks", {
  getLiveBoardData: async (_userId: string, _sportKey: string, label: string) => {
    boardLoads.push(label);
    const games = GAMES.filter((g) => g.league === label);
    return {
      odds: games.map((g) => ({ id: g.id, commenceTime: g.time, homeTeam: "Home " + g.id, awayTeam: "Away " + g.id })),
      scores: [],
      expanderPicksByGame: games.map((g) => Array.from({ length: g.picks }, (_, n) => pick(g, n + 1))),
    };
  },
});
stub("../data/picks", {
  getCapperLeagueRecords: async () => ({ records: {}, streaks: {}, last20: {} }),
  getCapperCategoryRecords: async () => ({}),
  getCapperRecordBundle: async () => ({ leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords: {} }),
});

async function main() {
  const { autoGenerateParlayAction } = await import("./parlay-generator");
  // The games a generate built from, in id order, and how many it had to pick from.
  async function generate(leagues: string[], legCount = 20) {
    boardLoads = [];
    const result = await autoGenerateParlayAction(leagues, legCount);
    if ("error" in result) return { games: ["error: " + result.error], available: -1, legs: -1 };
    return { games: result.parlayA.legs.map((l) => l.gameId).sort(), available: result.parlayA.available, legs: result.parlayA.legs.length };
  }

  const nfl = await generate(["NFL"]);
  check(
    "Tuesday, NFL: finds the week's games - Thursday, both Sunday games, Monday",
    nfl.games,
    ["nfl-mon", "nfl-sun-early", "nfl-sun-late", "nfl-thu"]
  );
  check("NFL: last night's started game is not in it", nfl.games.includes("nfl-last-mon"), false);
  check("NFL: next week's Thursday game is not in it", nfl.games.includes("nfl-next-thu"), false);
  check("NFL: still one leg per game (the Sunday game with two picks gives one)", [nfl.available, nfl.legs], [4, 4]);

  const ncaaf = await generate(["NCAAF"]);
  check("Tuesday, NCAAF: tonight's game and Saturday's, not the Saturday after", ncaaf.games, ["ncaaf-sat", "ncaaf-tue"]);

  const mlb = await generate(["MLB"]);
  check("Tuesday, MLB: today only - tonight's game, not the started one, not tomorrow's", mlb.games, ["mlb-tonight"]);

  const nhl = await generate(["NHL"]);
  check("Tuesday, NHL: today only - not Thursday's game, though football reaches Thursday", nhl.games, ["nhl-tonight"]);

  const all = await generate(["MLB", "NFL", "NCAAF", "NHL"]);
  check(
    "every league on: the football week plus today's games elsewhere",
    all.games,
    ["mlb-tonight", "ncaaf-sat", "ncaaf-tue", "nfl-mon", "nfl-sun-early", "nfl-sun-late", "nfl-thu", "nhl-tonight"]
  );
  check("...from one board load per league, nothing extra", boardLoads, ["MLB", "NFL", "NCAAF", "NHL"]);

  const three = await generate(["NFL"], 3);
  check("NFL, 3 legs asked: 3 built from the 4 games available", [three.legs, three.available], [3, 4]);

  // ---------------------------------------------------------------------
  // Primary + alternates, slip locks, Regenerate (lib/parlay/alternates.ts)
  // ---------------------------------------------------------------------
  const keyOf = (legs: { top: { pick: { pickId: string } } }[]) => legs.map((l) => l.top.pick.pickId).sort().join(",");
  const first = await autoGenerateParlayAction(["NFL", "NCAAF"], 3);
  if ("error" in first) throw new Error(first.error);
  check("first Generate: the set's first parlay is Parlay A", first.parlays[0]?.parlay === first.parlayA, true);
  check("first Generate: not a Regenerate", first.regenerated, false);
  check("first Generate: up to three parlays, all distinct", new Set(first.parlays.map((p) => keyOf(p.parlay.legs))).size, first.parlays.length);
  const plain = await autoGenerateParlayAction(["NFL", "NCAAF"], 3, 1, "ALL", null, { slip: { picks: [], games: [] } });
  if ("error" in plain) throw new Error(plain.error);
  check("an empty slip: Parlay A is the same as with no slip at all", keyOf(plain.parlayA.legs), keyOf(first.parlayA.legs));

  const shown = first.parlays.map((p) => keyOf(p.parlay.legs));
  const again = await autoGenerateParlayAction(["NFL", "NCAAF"], 3, 1, "ALL", null, { exclude: shown });
  if ("error" in again) throw new Error(again.error);
  check("Regenerate: flagged as one", again.regenerated, true);
  check("Regenerate: nothing it returns was shown before", again.parlays.some((p) => shown.includes(keyOf(p.parlay.legs))), false);

  // With equal (empty) records Parlay A takes games by pick id, so nfl-thu and
  // nfl-sun-late would not both make a 2-leg Parlay A on their own.
  const locked = await autoGenerateParlayAction(["NFL"], 2, 1, "ALL", null, { slip: { picks: [{ pickId: "nfl-thu-p1", locked: true }], games: [{ gameId: "nfl-sun-late", locked: true }] } });
  if ("error" in locked) throw new Error(locked.error);
  check(
    "locks: the locked pick and a leg from the locked game are in every parlay",
    locked.parlays.every((p) => p.parlay.legs.some((l) => l.top.pick.pickId === "nfl-thu-p1") && p.parlay.legs.some((l) => l.gameId === "nfl-sun-late")),
    true
  );
  const missing = await autoGenerateParlayAction(["MLB"], 2, 1, "ALL", null, { slip: { picks: [{ pickId: "nfl-thu-p1", locked: true }], games: [] } });
  check("locks: a locked pick outside these games is an error that lists it", "error" in missing && "missing" in missing ? missing.missing : null, ["nfl-thu-p1"]);

  const bad = await Promise.all([
    autoGenerateParlayAction(["NFL"], 2, 1, "ALL", null, "nope" as never),
    autoGenerateParlayAction(["NFL"], 2, 1, "ALL", null, { slip: { picks: [{ pickId: 7 }] } } as never),
    autoGenerateParlayAction(["NFL"], 2, 1, "ALL", null, { exclude: "a,b" } as never),
    autoGenerateParlayAction(["NFL"], 2, 1, "ALL", null, { exclude: Array.from({ length: 1001 }, () => "x") }),
  ]);
  check("malformed options are refused", bad.map((r) => "error" in r), [true, true, true, true]);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
