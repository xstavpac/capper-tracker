// resolveMlSides (ml-side-resolution.ts): the decisions behind the --ml-side
// backfill. A legacy moneyline resolves only when its game is unambiguous; every
// other shape is reported with its reason and left to the forward rule.
//
// Pure (no database). Run with:
//   npx tsx src/server/data/ml-side-resolution-acceptance-test.ts
import { resolveMlSides, type LedgerGame, type MlSidePick } from "@/server/data/ml-side-resolution";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const HOME = "Philadelphia Phillies";
const AWAY = "Arizona Diamondbacks";
const T = new Date("2026-08-01T23:05:00Z");
const hoursLater = (h: number) => new Date(T.getTime() + h * 3600000);

const game = (over: Partial<LedgerGame> = {}): LedgerGame => ({
  homeTeam: HOME,
  awayTeam: AWAY,
  gameDate: T,
  gameNumber: null,
  homeScore: 5,
  awayScore: 3,
  favTeam: HOME,
  ...over,
});
const pick = (over: Partial<MlSidePick> = {}): MlSidePick => ({
  homeTeam: HOME,
  awayTeam: AWAY,
  gameTime: T,
  betDetail: "Diamondbacks ML",
  gameNumber: null,
  pickedSide: null,
  ...over,
});
const summary = (r: ReturnType<typeof resolveMlSides>) =>
  r.resolved ? { pickedSide: r.pickedSide, mlFavoredSide: r.mlFavoredSide, pickedSideWasNull: r.pickedSideWasNull } : { reason: r.reason };

const KEY = "baseball_mlb";

// ---- resolved ----
check("text names the away team, home was the favorite", summary(resolveMlSides(pick(), [game()], KEY)), {
  pickedSide: "AWAY",
  mlFavoredSide: "HOME",
  pickedSideWasNull: true,
});
check("text names the favorite", summary(resolveMlSides(pick({ betDetail: "Phillies ML" }), [game()], KEY)), {
  pickedSide: "HOME",
  mlFavoredSide: "HOME",
  pickedSideWasNull: true,
});
check("away favorite", summary(resolveMlSides(pick({ betDetail: "Phillies ML" }), [game({ favTeam: AWAY })], KEY)), {
  pickedSide: "HOME",
  mlFavoredSide: "AWAY",
  pickedSideWasNull: true,
});
check("a stored pickedSide is used (and not reported as newly stored)", summary(resolveMlSides(pick({ pickedSide: "HOME", betDetail: "garbage" }), [game()], KEY)), {
  pickedSide: "HOME",
  mlFavoredSide: "HOME",
  pickedSideWasNull: false,
});

// ---- not resolved ----
check("no GameResult in the window", summary(resolveMlSides(pick(), [], KEY)), { reason: "NO_GAME_RESULT" });
check("a game two days away is not this game", summary(resolveMlSides(pick(), [game({ gameDate: hoursLater(48) })], KEY)), { reason: "NO_GAME_RESULT" });
check("a 0-0 MLB row is a game never played, not a match", summary(resolveMlSides(pick(), [game({ homeScore: 0, awayScore: 0 })], KEY)), { reason: "NO_GAME_RESULT" });
check("a fuzzy (nickname-only) match is not used", summary(resolveMlSides(pick({ homeTeam: "Phillies", awayTeam: "D-backs" }), [game()], KEY)), { reason: "FUZZY_MATCH_ONLY" });
check("the ledger row has no favorite", summary(resolveMlSides(pick(), [game({ favTeam: null })], KEY)), { reason: "NO_FAVORITE" });
check("a favorite that is neither team", summary(resolveMlSides(pick(), [game({ favTeam: "Somebody Else" })], KEY)), { reason: "NO_FAVORITE" });
check("text naming neither team", summary(resolveMlSides(pick({ betDetail: "ML" }), [game()], KEY)), { reason: "NO_PICK_SIDE" });
check("text naming both teams", summary(resolveMlSides(pick({ betDetail: "Phillies Diamondbacks ML" }), [game()], KEY)), { reason: "NO_PICK_SIDE" });
check(
  "Red Sox / White Sox: 'Sox ML' names no side",
  summary(
    resolveMlSides(
      pick({ homeTeam: "Boston Red Sox", awayTeam: "Chicago White Sox", betDetail: "Sox ML" }),
      [game({ homeTeam: "Boston Red Sox", awayTeam: "Chicago White Sox", favTeam: "Boston Red Sox" })],
      KEY
    )
  ),
  { reason: "NO_PICK_SIDE" }
);

// ---- doubleheaders ----
const g1 = game({ gameDate: T, gameNumber: 1, favTeam: HOME });
const g2Same = game({ gameDate: hoursLater(3), gameNumber: 2, favTeam: HOME });
const g2Other = game({ gameDate: hoursLater(3), gameNumber: 2, favTeam: AWAY });
check("doubleheader, legs agree on the favorite -> resolved", summary(resolveMlSides(pick(), [g1, g2Same], KEY)), {
  pickedSide: "AWAY",
  mlFavoredSide: "HOME",
  pickedSideWasNull: true,
});
check("doubleheader, legs disagree, pick has no game number -> ambiguous", summary(resolveMlSides(pick(), [g1, g2Other], KEY)), { reason: "AMBIGUOUS_GAME" });
check("doubleheader, a leg with no favorite, no game number -> ambiguous", summary(resolveMlSides(pick(), [g1, game({ gameDate: hoursLater(3), gameNumber: 2, favTeam: null })], KEY)), { reason: "AMBIGUOUS_GAME" });
check("doubleheader, legs disagree, pick is game 2 -> that leg's favorite", summary(resolveMlSides(pick({ gameNumber: 2, gameTime: hoursLater(3) }), [g1, g2Other], KEY)), {
  pickedSide: "AWAY",
  mlFavoredSide: "AWAY",
  pickedSideWasNull: true,
});
check("the same two teams a day later do not make it ambiguous", summary(resolveMlSides(pick(), [g1, game({ gameDate: hoursLater(24), favTeam: AWAY })], KEY)), {
  pickedSide: "AWAY",
  mlFavoredSide: "HOME",
  pickedSideWasNull: true,
});

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
