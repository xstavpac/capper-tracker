// An off-board slip pick is keyed to its real game by teams and time
// (off-board-game.ts), so the generator's max legs per game counts it against
// that game. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/off-board-game-acceptance-test.ts
import { findBoardGameForPick, type BoardGameRef } from "@/lib/parlay/off-board-game";
import { buildGeneratedParlay, type GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const H = 3600_000;
const T0 = Date.parse("2099-06-01T23:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const game = (id: string, home: string, away: string, at: number): BoardGameRef => ({ id, homeTeam: home, awayTeam: away, commenceTime: iso(at) });
const DRIFT = 6 * H;

{
  const games = [game("a", "Boston Red Sox", "New York Yankees", T0), game("b", "Boston Red Sox", "New York Yankees", T0 + 24 * H), game("c", "Houston Astros", "Texas Rangers", T0)];
  const pick = (home: string, away: string, at: number) => ({ homeTeam: home, awayTeam: away, gameTime: new Date(at) });
  check("same teams, same time: that game", findBoardGameForPick(pick("Boston Red Sox", "New York Yankees", T0), games, undefined, DRIFT)?.id, "a");
  check("a series: the nearest start wins", findBoardGameForPick(pick("Boston Red Sox", "New York Yankees", T0 + 23 * H + 30 * 60_000), games, undefined, DRIFT)?.id, "b");
  check("a doubleheader's second game: nearest start", findBoardGameForPick(pick("Boston Red Sox", "New York Yankees", T0 + 2 * H), [...games, game("a2", "Boston Red Sox", "New York Yankees", T0 + 4 * H)], undefined, DRIFT)?.id, "a");
  check("outside the drift window: no game", findBoardGameForPick(pick("Boston Red Sox", "New York Yankees", T0 + 10 * H), [games[0]], undefined, DRIFT), null);
  check("other teams: no game", findBoardGameForPick(pick("Chicago Cubs", "St. Louis Cardinals", T0), games, undefined, DRIFT), null);
  check("home and away swapped is a different game", findBoardGameForPick(pick("New York Yankees", "Boston Red Sox", T0), games, undefined, DRIFT), null);
}

// ---- the point of it: the cap counts the keyed pick -----------------------------
{
  const mk = (id: string, capperId: string, gameId: string, over: Partial<GeneratorPick> = {}): GeneratorPick =>
    ({
      pickId: id, capperId, capperName: "Capper " + capperId, capperColorTag: null, capperIsFavorite: false, category: "FAV_ML", leagueName: "MLB",
      gameId, gameLabel: "Yankees @ Red Sox", betDetail: "Red Sox ML", odds: -120, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME",
      rawBetDetail: "Red Sox ML", propMarket: null, line: null, homeTeam: "Boston Red Sox", awayTeam: "New York Yankees", gameTime: iso(T0),
      teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z", ...over,
    }) as GeneratorPick;
  const cand = mk("cand", "k1", "a", { betType: "TOTAL", betDetail: "Over 8.5", rawBetDetail: "Over 8.5", line: 8.5, category: "OVER" as GeneratorPick["category"], teamGroup: "HOME" });
  const g: GeneratorGame = { gameId: "a", gameLabel: "Yankees @ Red Sox", gameTime: iso(T0), leagueName: "MLB", picks: [cand] };
  const rec = { key: "OVER", label: "", wins: 70, losses: 30, pushes: 0, winPct: 70, count: 100 };
  const snap = (slip: GeneratorPick): GeneratorSnapshot => ({ builtAt: iso(T0 - H), games: [g], slipPicks: [slip], targets: [], leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords: { "k1|OVER": rec } as never });
  const S = { legCount: 2, maxLegsPerGame: 1, include: "ALL" as const, mix: null, fillFrom: "BEST_AVAILABLE" as const };
  const now = new Date(T0 - 12 * H);
  const unkeyed = buildGeneratedParlay(snap(mk("slip", "s1", "pick:slip")), S, null, now);
  check("unkeyed (own game id): the cap can't see it, 2 legs on one matchup", unkeyed.legs.length, 2);
  const keyed = buildGeneratedParlay(snap(mk("slip", "s1", "a")), S, null, now);
  check("keyed to its real game: max 1 holds, no second leg on that game", [keyed.legs.length, keyed.generated], [1, 0]);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
