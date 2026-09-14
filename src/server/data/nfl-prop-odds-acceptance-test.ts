// Proof for normalizePlayerPropLines (nfl-prop-odds.ts) against two
// fixtures of different provenance - keep that distinction in mind reading
// this file:
//
//   - __fixtures__/odds-api-event-anytime-td-response.json is a REAL,
//     unmodified response captured live 2026-09-14 (production $30/20K
//     key, confirmed via x-requests-remaining 20000 -> 19999 on this exact
//     call - see nfl-prop-odds.ts's header comment on
//     PLAYER_ANYTIME_TD_MARKET_KEY). This is what proves player_anytime_td
//     is one-sided ("Yes" only), never carries `point`, and can include
//     non-player sentinel outcomes ("No Scorer", team-defense entries).
//   - __fixtures__/odds-api-event-pass-tds-doc-example.json is DOC-DERIVED,
//     built from the Odds API's own published example for player_pass_tds
//     (David Blough, Over/Under 0.5) - not independently live-verified the
//     way the anytime-TD fixture is. Flagged here so a future reader
//     doesn't mistake one for the other's level of confidence.
//
// Pure - no network, no database. Run with:
//   npx tsx src/server/data/nfl-prop-odds-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePlayerPropLines, NFL_PROP_MARKET_KEYS, type PlayerPropLine } from "@/server/data/nfl-prop-odds";
import type { OddsGame } from "@/server/data/odds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
function ok(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const FIX = join(__dirname, "__fixtures__");
function loadFixture(name: string): OddsGame {
  const raw = JSON.parse(readFileSync(join(FIX, name), "utf8"));
  // Same raw-passthrough shape fetchMergedOddsListing stores - bookmakers
  // copied verbatim, only the top-level game fields renamed snake->camel.
  return {
    id: raw.id,
    sportKey: raw.sport_key,
    homeTeam: raw.home_team,
    awayTeam: raw.away_team,
    commenceTime: raw.commence_time,
    bookmakers: raw.bookmakers,
  };
}
function find(lines: PlayerPropLine[], bookmakerKey: string, playerName: string): PlayerPropLine | undefined {
  return lines.find((l) => l.bookmakerKey === bookmakerKey && l.playerName === playerName);
}

async function main() {
  // =====================================================================
  // 1. player_anytime_td - real captured response
  // =====================================================================
  const anytimeTdGame = loadFixture("odds-api-event-anytime-td-response.json");
  const anytimeLines = normalizePlayerPropLines(anytimeTdGame);

  ok("real anytime-TD response: produced at least one line per bookmaker", anytimeLines.length > 50, anytimeLines.length);
  ok(
    "every normalized anytime-TD line has side 'Yes' - confirmed one-sided, no 'No' outcome anywhere",
    anytimeLines.every((l) => l.side === "Yes")
  );
  ok(
    "every normalized anytime-TD line has point === null - confirmed no `point` field on this market",
    anytimeLines.every((l) => l.point === null)
  );
  ok(
    "marketKey is 'player_anytime_td' on every line here",
    anytimeLines.every((l) => l.marketKey === "player_anytime_td")
  );

  const mahomes = find(anytimeLines, "draftkings", "Patrick Mahomes");
  expect("Patrick Mahomes (DraftKings) anytime-TD line", mahomes && { side: mahomes.side, point: mahomes.point, price: mahomes.price }, {
    side: "Yes",
    point: null,
    price: 700,
  });

  // Non-player sentinel exclusion: "No Scorer" (Fanatics) must never be
  // normalized as if it were a player.
  ok(
    "'No Scorer' sentinel (Fanatics: nobody scores a TD) is excluded, not stored as a player",
    !anytimeLines.some((l) => l.playerName === "No Scorer")
  );

  // Team-defense outcome exclusion - both spellings observed live
  // ("... D/ST" on DraftKings/BetMGM, "... Defense" on FanDuel).
  ok(
    "team-defense outcomes ('Kansas City Chiefs D/ST') are excluded, not stored as a player",
    !anytimeLines.some((l) => l.playerName.includes("D/ST") || l.playerName.endsWith("Defense"))
  );
  ok(
    "no normalized line's playerName equals either team's full name (the defense-outcome exclusion actually fired, not a no-op)",
    !anytimeLines.some((l) => l.playerName === anytimeTdGame.homeTeam || l.playerName === anytimeTdGame.awayTeam)
  );

  // lineKey distinctness for the exact ambiguity case the task calls out:
  // two DIFFERENT players' anytime-TD lines must never collide with each
  // other just because they're the same market/side/point.
  const kelce = find(anytimeLines, "draftkings", "Travis Kelce");
  ok("Mahomes and Kelce (same market/side/point=null) get different lineKeys", mahomes!.lineKey !== kelce!.lineKey, {
    mahomes: mahomes!.lineKey,
    kelce: kelce!.lineKey,
  });

  // =====================================================================
  // 2. player_pass_tds - doc-derived fixture (Over/Under + point)
  // =====================================================================
  const passTdsGame = loadFixture("odds-api-event-pass-tds-doc-example.json");
  const passTdsLines = normalizePlayerPropLines(passTdsGame);

  expect("doc-example: exactly 2 lines (Over + Under)", passTdsLines.length, 2);
  const over = passTdsLines.find((l) => l.side === "Over");
  const under = passTdsLines.find((l) => l.side === "Under");
  expect("David Blough Over 0.5 Passing TDs", over && { player: over.playerName, point: over.point, price: over.price }, {
    player: "David Blough",
    point: 0.5,
    price: -205,
  });
  expect("David Blough Under 0.5 Passing TDs", under && { player: under.playerName, point: under.point, price: under.price }, {
    player: "David Blough",
    point: 0.5,
    price: 155,
  });

  // =====================================================================
  // 3. The exact ambiguity case from the task: "Josh Allen Anytime TD" vs
  //    "Josh Allen Over 1.5 Passing TDs" must be unambiguously distinct.
  // =====================================================================
  const mixedGame: OddsGame = {
    id: "mixed-event",
    sportKey: "americanfootball_nfl",
    homeTeam: "Buffalo Bills",
    awayTeam: "Miami Dolphins",
    commenceTime: "2026-09-21T17:00:00Z",
    bookmakers: [
      {
        key: "draftkings",
        title: "DraftKings",
        markets: [
          { key: "player_anytime_td", outcomes: [{ name: "Yes", description: "Josh Allen", price: 550 }] },
          {
            key: "player_pass_tds",
            outcomes: [
              { name: "Over", description: "Josh Allen", price: -110, point: 1.5 },
              { name: "Under", description: "Josh Allen", price: -120, point: 1.5 },
            ],
          },
        ],
      },
    ],
  };
  const mixedLines = normalizePlayerPropLines(mixedGame);
  expect("mixed game: 3 lines total (1 anytime-TD + Over + Under passing-TD)", mixedLines.length, 3);
  const allanKeys = new Set(mixedLines.map((l) => l.lineKey));
  expect("all 3 lineKeys are distinct - anytime-TD never collides with passing-TD Over/Under", allanKeys.size, 3);
  const anytimeAllen = mixedLines.find((l) => l.marketKey === "player_anytime_td")!;
  const overAllen = mixedLines.find((l) => l.marketKey === "player_pass_tds" && l.side === "Over")!;
  ok(
    "Josh Allen Anytime TD and Josh Allen Over 1.5 Passing TDs have different marketKey (the actual disambiguator)",
    anytimeAllen.marketKey !== overAllen.marketKey
  );
  expect("Josh Allen Anytime TD: point stays null even though the game also has a pointed passing-TD market", anytimeAllen.point, null);
  expect("Josh Allen Over 1.5 Passing TDs: point is 1.5", overAllen.point, 1.5);

  // =====================================================================
  // 4. Markets outside the five gradeable ones are ignored, not normalized.
  // =====================================================================
  const ungraded: OddsGame = {
    id: "ungraded-event",
    sportKey: "americanfootball_nfl",
    homeTeam: "Buffalo Bills",
    awayTeam: "Miami Dolphins",
    commenceTime: "2026-09-21T17:00:00Z",
    bookmakers: [
      {
        key: "draftkings",
        title: "DraftKings",
        markets: [
          { key: "h2h", outcomes: [{ name: "Buffalo Bills", price: -150 }] },
          { key: "player_rush_yds", outcomes: [{ name: "Over", description: "James Cook III", price: -110, point: 65.5 }] },
        ],
      },
    ],
  };
  expect("h2h and ungraded prop markets (e.g. player_rush_yds) produce zero normalized lines", normalizePlayerPropLines(ungraded), []);

  expect("NFL_PROP_MARKET_KEYS is exactly the 5 gradeable markets", [...NFL_PROP_MARKET_KEYS].sort(), [
    "player_anytime_td",
    "player_pass_attempts",
    "player_pass_completions",
    "player_pass_tds",
    "player_pass_yds",
  ]);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
