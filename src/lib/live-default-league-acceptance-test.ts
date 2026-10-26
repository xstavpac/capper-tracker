// Correctness proof for pickDefaultLeague (live-default-league.ts), the rule behind the league
// the /live tab opens on with no ?sport= in the URL.
// Run with:
//   npx tsx src/lib/live-default-league-acceptance-test.ts
//
// Exits non-zero if any assertion fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickDefaultLeague, type LeagueGameStub, type LeagueSlate } from "./live-default-league";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

// 2026-10-26 15:00 Eastern (EDT, UTC-4).
const NOW = new Date("2026-10-26T19:00:00Z");
const g = (status: LeagueGameStub["status"], iso: string): LeagueGameStub => ({ status, commenceTime: iso });
const slate = (sportKey: string, ...games: LeagueGameStub[]): LeagueSlate => ({ sportKey, games });

const MLB = "baseball_mlb";
const NBA = "basketball_nba";
const NHL = "icehockey_nhl";
const NFL = "americanfootball_nfl";

// Rule 1: in progress, earliest live start wins - even over an earlier upcoming game elsewhere.
expect(
  "rule 1: the league whose live game started earliest",
  pickDefaultLeague(
    [slate(MLB, g("live", "2026-10-26T18:30:00Z")), slate(NHL, g("live", "2026-10-26T18:00:00Z")), slate(NBA, g("preview", "2026-10-26T19:30:00Z"))],
    NOW
  ),
  NHL
);
expect(
  "rule 1: a live carry-over from last night counts",
  pickDefaultLeague([slate(MLB, g("preview", "2026-10-26T23:00:00Z")), slate(NBA, g("live", "2026-10-26T03:00:00Z"))], NOW),
  NBA
);
expect(
  "rule 1: a live tie goes to the earlier tab",
  pickDefaultLeague([slate(NBA, g("live", "2026-10-26T18:00:00Z")), slate(MLB, g("live", "2026-10-26T18:00:00Z"))], NOW),
  NBA
);

// Rule 2: nothing live - earliest upcoming game today (Eastern day), finals ignored.
expect(
  "rule 2: earliest upcoming game today",
  pickDefaultLeague(
    [slate(MLB, g("preview", "2026-10-26T23:05:00Z")), slate(NBA, g("preview", "2026-10-26T23:00:00Z"), g("final", "2026-10-26T14:00:00Z")), slate(NHL, g("final", "2026-10-26T16:00:00Z"))],
    NOW
  ),
  NBA
);
expect(
  "rule 2: today is the Eastern day - 03:30Z tomorrow is still today's late game",
  pickDefaultLeague([slate(MLB, g("preview", "2026-10-27T01:00:00Z")), slate(NBA, g("preview", "2026-10-27T23:00:00Z"))], NOW),
  MLB
);
expect(
  "rule 2: today's upcoming game beats a sooner-sorting tomorrow game",
  pickDefaultLeague([slate(NBA, g("preview", "2026-10-27T17:00:00Z")), slate(NHL, g("preview", "2026-10-27T01:30:00Z"))], NOW),
  NHL
);

// Rule 3: every league done today - the soonest next game on a later Eastern date.
expect(
  "rule 3: every league done today, the soonest game tomorrow",
  pickDefaultLeague(
    [slate(MLB, g("final", "2026-10-26T17:00:00Z"), g("preview", "2026-10-27T23:00:00Z")), slate(NBA, g("final", "2026-10-26T17:00:00Z"), g("preview", "2026-10-27T16:00:00Z"))],
    NOW
  ),
  NBA
);
expect(
  "rule 3: postponed and cancelled games never count",
  pickDefaultLeague([slate(NBA, g("postponed", "2026-10-27T16:00:00Z")), slate(NHL, g("cancelled", "2026-10-26T23:00:00Z")), slate(NFL, g("preview", "2026-10-28T00:30:00Z"))], NOW),
  NFL
);

// Rule 4: nothing at all keeps MLB.
expect("rule 4: no games anywhere", pickDefaultLeague([slate(NBA), slate(NHL)], NOW), MLB);
expect("rule 4: no leagues", pickDefaultLeague([], NOW), MLB);
expect(
  "rule 4: only finals",
  pickDefaultLeague([slate(NBA, g("final", "2026-10-26T14:00:00Z"))], NOW),
  MLB
);
expect(
  "an unparseable start time is skipped",
  pickDefaultLeague([slate(NBA, g("preview", "not a date")), slate(NHL, g("preview", "2026-10-26T23:00:00Z"))], NOW),
  NHL
);

// The page-side reader touches no database: only the cached score feed.
const reader = readFileSync(join(__dirname, "../server/data/live-default-sport.ts"), "utf8");
expect("live-default-sport.ts does not import prisma", /prisma/i.test(reader), false);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed");
