// Proof for deriveTeamTotalTarget - run with:
//   npx tsx src/lib/team-total-target-acceptance-test.ts
import { deriveTeamTotalTarget } from "@/lib/team-total-target";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const GAME = { homeTeam: "New York Yankees", awayTeam: "Boston Red Sox" };
const SPORT = "MLB";

check(
  "home team total resolves to home team's full name",
  deriveTeamTotalTarget({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5" }, GAME, SPORT),
  "New York Yankees"
);

check(
  "away team total resolves to away team's full name",
  deriveTeamTotalTarget({ betType: "TEAM_TOTAL", betDetail: "Red Sox Under 3.5" }, GAME, SPORT),
  "Boston Red Sox"
);

check(
  "unmatched alias -> null, never a guess",
  deriveTeamTotalTarget({ betType: "TEAM_TOTAL", betDetail: "USC Over 4.5" }, GAME, SPORT),
  null
);

check(
  "non-TEAM_TOTAL betType -> null (not this function's concern)",
  deriveTeamTotalTarget({ betType: "MONEYLINE", betDetail: "Yankees ML" }, GAME, SPORT),
  null
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
