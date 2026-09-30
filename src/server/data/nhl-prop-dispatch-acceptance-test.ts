// resolvePlayerProp's per-sport dispatch after NHL props were added. No network:
// every case here returns BEFORE any box-score fetch. Run with:
//   npx tsx src/server/data/nhl-prop-dispatch-acceptance-test.ts
//
// Pins that the NFL gate is unchanged (NFL still graded by the NFL path; every
// other non-NHL/non-MLB sport still declined with the NFL-only
// reason), and that an NHL pick with no recognizable NHL market is declined
// with an NHL-specific reason instead of being mis-graded as an NFL prop.
import { resolvePlayerProp } from "@/server/data/grading";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const base = { playerName: null, propMarket: null, homeTeam: "Buffalo Sabres", awayTeam: "Pittsburgh Penguins" } as const;

async function main() {
  // MLB props have their own grader now (mlb-prop-grading.ts); an MLB pick whose text is not an MLB market is
  // declined by it - before any box-score fetch - instead of by the NFL-only gate.
  const mlb = await resolvePlayerProp({ ...base, betDetail: "Josh Allen Over 275.5 Passing Yards" }, "1", "MLB");
  check("MLB pick with an NFL-market text is declined by the MLB grader", mlb, { outcome: null, reason: "this bet text isn't a recognized MLB prop market" });

  const nba = await resolvePlayerProp({ ...base, betDetail: "Nikola Jokic over 10.5 assists" }, "1", "NBA");
  check("NBA prop stays declined with the NFL-only reason", nba, { outcome: null, reason: "player-prop grading is NFL-only; this NBA pick needs manual grading" });

  const nflMarketOnNhl = await resolvePlayerProp({ ...base, betDetail: "Josh Allen Over 275.5 Passing Yards" }, "1", "NHL");
  check("NHL pick with an NFL-market text is declined by the NHL grader", nflMarketOnNhl, { outcome: null, reason: "this bet text isn't a recognized NHL prop market" });

  const nhlOnNfl = await resolvePlayerProp({ ...base, betDetail: "Sidney Crosby over 3.5 shots on goal" }, "1", "NFL");
  check("an NHL-market text on an NFL pick still goes down the untouched NFL path", nhlOnNfl, { outcome: null, reason: "this bet text isn't a recognized touchdown prop" });

  const nflTd = await resolvePlayerProp({ ...base, betDetail: "Puka Nacua Anytime TD", propMarket: "TD" }, "1", "MLB");
  check("NFL TD text on an MLB pick is declined by the MLB grader", nflTd, { outcome: null, reason: "this bet text isn't a recognized MLB prop market" });
  const nflTdWnba = await resolvePlayerProp({ ...base, betDetail: "Puka Nacua Anytime TD", propMarket: "TD" }, "1", "WNBA");
  check("NFL TD text on a still-unsupported sport keeps the NFL-only reason", nflTdWnba, { outcome: null, reason: "player-prop grading is NFL-only; this WNBA pick needs manual grading" });

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
