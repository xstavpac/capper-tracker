// Proof that matchPicksToGame (the /live and /live/[gameId] "picks on this
// game" association) only attaches a pick to a game when BOTH teams line up -
// never on a single shared team name.
//
// The bug this locks down: 6 picks on Colorado (@ Georgia Tech) showed up
// duplicated under two unrelated games on the same night - "West Georgia @
// Kennesaw State" (the curated key "georgia" matches as a whole word inside
// "West Georgia Wolves", and the Colorado picks' text contains "Georgia
// Tech") and "Albany @ Buffalo Bulls" ("buffalo" is a raw substring of
// "Buffaloes"). The fuzzy fallback matched on one side only, with includes()
// rather than a word-boundary test. This mirrors the same both-sides +
// word-boundary hardening grading's matchGameResult already has.
//
// Run with:
//   npx tsx src/server/data/live-picks-match-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { matchPicksToGame } from "./picks";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const HOUR = 3600000;
const AT = "2026-09-03T23:00:00Z";

type Pick = { homeTeam: string; awayTeam: string; betDetail: string | null; gameTime: Date };
const pick = (homeTeam: string, awayTeam: string, betDetail: string | null, iso: string = AT): Pick => ({
  homeTeam,
  awayTeam,
  betDetail,
  gameTime: new Date(iso),
});
const game = (homeTeam: string, awayTeam: string, iso: string = AT) => ({
  homeTeam,
  awayTeam,
  commenceTime: new Date(iso),
});

const ids = (picks: Pick[]) => picks.map((p) => p.betDetail);

// The 6 Colorado picks exactly as they were resolved on import: both teams
// carry the canonical ESPN schedule names, the bettor's own text (just
// "Colorado ...") lives in betDetail.
const coloradoPicks: Pick[] = [
  pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", "Colorado -7.5"),
  pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", "Colorado +7.5"),
  pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", "Colorado +7"),
  pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", "Colorado +7.5 "),
  pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", "Colorado +7 "),
  pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", "Colorado +6.5"),
];

// ---- 1-3: tonight's bug report --------------------------------------------

expect(
  "1. Colorado picks show under Colorado @ Georgia Tech",
  matchPicksToGame(coloradoPicks, game("Georgia Tech Yellow Jackets", "Colorado Buffaloes"), "NCAAF").length,
  6
);

expect(
  "2. Colorado picks do NOT show under West Georgia @ Kennesaw State",
  matchPicksToGame(coloradoPicks, game("Kennesaw State Owls", "West Georgia Wolves"), "NCAAF").length,
  0
);

expect(
  "3. Colorado picks do NOT show under Albany @ Buffalo Bulls",
  matchPicksToGame(coloradoPicks, game("Buffalo Bulls", "Albany"), "NCAAF").length,
  0
);

// ---- 4-5: free-text / cross-feed pick still finds its real game ----------

// A pick that names only one team in its text and carries non-canonical team
// fields (a manual entry, or a feed that spells the game differently than the
// board does). The fuzzy branch must still attach it to its real game.
const freeTextColorado = pick("Georgia Tech", "Colorado", "Colorado +7.5");

expect(
  "4. free-text Colorado pick still matches Colorado @ Georgia Tech (fuzzy)",
  matchPicksToGame([freeTextColorado], game("Georgia Tech Yellow Jackets", "Colorado Buffaloes"), "NCAAF").length,
  1
);

expect(
  "5. free-text Colorado pick does NOT match West Georgia @ Kennesaw State",
  matchPicksToGame([freeTextColorado], game("Kennesaw State Owls", "West Georgia Wolves"), "NCAAF").length,
  0
);

// ---- 6-7: the word boundary is doing the work ---------------------------

// Both teams curated, so awayNickname resolves ("ohio") and case 3's
// undefined-away shortcut is not what's excluding the picks here - it's that
// "buffaloes" does not satisfy the "buffalo" word-boundary regex.
expect(
  "6. Colorado picks do NOT match Buffalo Bulls @ Ohio (buffaloes != buffalo)",
  matchPicksToGame(coloradoPicks, game("Buffalo Bulls", "Ohio Bobcats"), "NCAAF").length,
  0
);

expect(
  "7. a real Buffalo pick still matches Buffalo Bulls @ Ohio",
  matchPicksToGame([pick("Buffalo Bulls", "Ohio Bobcats", "Buffalo -3")], game("Buffalo Bulls", "Ohio Bobcats"), "NCAAF")
    .length,
  1
);

// ---- 8-11: existing guarantees preserved -------------------------------

expect(
  "8. exact team-name match short-circuits even with empty betDetail",
  matchPicksToGame(
    [pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", null)],
    game("Georgia Tech Yellow Jackets", "Colorado Buffaloes"),
    "NCAAF"
  ).length,
  1
);

expect(
  "9. a pick 8h off the game's commence time is dropped (withinDrift)",
  matchPicksToGame(
    [pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", "Colorado +7.5", new Date(new Date(AT).getTime() + 8 * HOUR).toISOString())],
    game("Georgia Tech Yellow Jackets", "Colorado Buffaloes"),
    "NCAAF"
  ).length,
  0
);

expect(
  "10. unresolvable opponent -> no fuzzy match (NHL-style one-sided record tradeoff)",
  matchPicksToGame(
    [freeTextColorado],
    game("Colorado Buffaloes", "Nowhere State Directional Tech"),
    "NCAAF"
  ).length,
  0
);

// Same matchup, two different days: each game only gets its own picks.
const thu = "2026-09-04T23:00:00Z";
const fri = "2026-09-05T23:00:00Z";
const twoDayPicks: Pick[] = [
  pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", "Colorado +7.5 (Thu)", thu),
  pick("Georgia Tech Yellow Jackets", "Colorado Buffaloes", "Colorado +7.5 (Fri)", fri),
];
expect(
  "11. same matchup on adjacent days -> Thursday game gets only the Thursday pick",
  ids(matchPicksToGame(twoDayPicks, game("Georgia Tech Yellow Jackets", "Colorado Buffaloes", thu), "NCAAF")),
  ["Colorado +7.5 (Thu)"]
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
