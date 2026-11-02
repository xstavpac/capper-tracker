// Proof for the Phase 1 forward-only fix to moneyline favorite/underdog
// classification. The odds sign alone can't tell FAV_ML from DOG_ML in a juiced
// near-pick'em where BOTH sides are priced negative (Phillies -112 / Diamondbacks
// -104) - both read as "favorite". The fix stores the real favored side
// (Pick.mlFavoredSide, captured from the h2h market at bulk-import time) and has
// favoriteOrUnderdog prefer it. When it (or pickedSide) is missing the odds sign is
// still read, but only for a STATED / MARKET price other than -110 (PICK_CATEGORY_VERSION
// 4): a DEFAULTED -110 placeholder, a legacy row with no oddsSource, or a -110 carries no
// side, so those return no category instead of being filed as favorites.
//
// Pure: favoriteOrUnderdog / pickCategory / computeCategoryBreakdown all take
// plain objects, and favoredSideFromOddsGame takes a plain OddsGame. Run with:
//   npx tsx src/server/data/ml-favorite-classification-acceptance-test.ts
import { favoriteOrUnderdog } from "@/lib/bet-line";
import { pickCategory, computeCategoryBreakdown, ALL_CATEGORY_KEYS } from "@/server/data/stats";
import { favoredSideFromOddsGame, type OddsGame } from "@/server/data/odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

type CatRow = Parameters<typeof computeCategoryBreakdown>[0][number];

// The original bug scenario: a real MLB game, both moneylines negative.
// Phillies (home) -112 are the slight favorite, Diamondbacks (away) -104 the
// slight underdog.
function mlPick(over: {
  pickedSide?: "HOME" | "AWAY" | null;
  mlFavoredSide?: "HOME" | "AWAY" | null;
  odds: number;
}): CatRow {
  return {
    id: "p",
    status: "WIN",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    betDetail: over.pickedSide === "AWAY" ? "Diamondbacks ML" : "Phillies ML",
    odds: over.odds,
    line: null,
    units: 1,
    gameTime: new Date("2026-09-02T19:41:00Z"),
    pickedSide: over.pickedSide ?? null,
    mlFavoredSide: over.mlFavoredSide ?? null,
    sport: { name: "MLB" },
  } as unknown as CatRow;
}

function main() {
  // ---- A. favoriteOrUnderdog directly ----
  {
    // The Diamondbacks pick: -104, on AWAY, favorite was HOME -> UNDERDOG.
    // The odds-sign heuristic alone would wrongly say FAVORITE here.
    check(
      "A: dog side with mlFavoredSide set -> UNDERDOG (heuristic would say FAVORITE)",
      favoriteOrUnderdog({ betType: "MONEYLINE", odds: -104, line: null, pickedSide: "AWAY", mlFavoredSide: "HOME" }),
      "UNDERDOG"
    );
    // The Phillies pick: -112, on HOME, favorite was HOME -> FAVORITE.
    check(
      "A: fav side with mlFavoredSide set -> FAVORITE",
      favoriteOrUnderdog({ betType: "MONEYLINE", odds: -112, line: null, pickedSide: "HOME", mlFavoredSide: "HOME" }),
      "FAVORITE"
    );
    // No mlFavoredSide -> odds-sign fallback, for a real (STATED / MARKET) price only.
    check(
      "A: mlFavoredSide null, STATED -104 -> falls back to odds sign",
      favoriteOrUnderdog({ betType: "MONEYLINE", odds: -104, line: null, pickedSide: "AWAY", mlFavoredSide: null, oddsSource: "STATED" }),
      "FAVORITE"
    );
    check("A: fallback, MARKET -145 -> FAVORITE", favoriteOrUnderdog({ betType: "MONEYLINE", odds: -145, line: null, oddsSource: "MARKET" }), "FAVORITE");
    check("A: fallback, MARKET +130 -> UNDERDOG", favoriteOrUnderdog({ betType: "MONEYLINE", odds: 130, line: null, oddsSource: "MARKET" }), "UNDERDOG");
    check("A: fallback, STATED -110 -> null (carries no side)", favoriteOrUnderdog({ betType: "MONEYLINE", odds: -110, line: null, oddsSource: "STATED" }), null);
    check("A: fallback, MARKET -110 -> null", favoriteOrUnderdog({ betType: "MONEYLINE", odds: -110, line: null, oddsSource: "MARKET" }), null);
    check("A: fallback, DEFAULTED -110 placeholder -> null", favoriteOrUnderdog({ betType: "MONEYLINE", odds: -110, line: null, oddsSource: "DEFAULTED" }), null);
    check("A: fallback, DEFAULTED -150 -> null (a placeholder is never evidence)", favoriteOrUnderdog({ betType: "MONEYLINE", odds: -150, line: null, oddsSource: "DEFAULTED" }), null);
    check("A: fallback, legacy row (null source) -145 -> null", favoriteOrUnderdog({ betType: "MONEYLINE", odds: -145, line: null, oddsSource: null }), null);
    check("A: fallback, source omitted -145 -> null", favoriteOrUnderdog({ betType: "MONEYLINE", odds: -145, line: null }), null);
    check("A: stored sides win over a DEFAULTED price", favoriteOrUnderdog({ betType: "MONEYLINE", odds: -110, line: null, pickedSide: "AWAY", mlFavoredSide: "HOME", oddsSource: "DEFAULTED" }), "UNDERDOG");
    check("A: SPREAD ignores oddsSource", favoriteOrUnderdog({ betType: "SPREAD", odds: -110, line: 1.5, oddsSource: "DEFAULTED" }), "UNDERDOG");
    // mlFavoredSide known but pickedSide null -> can't compare -> fallback.
    check(
      "A: mlFavoredSide set but pickedSide null -> odds-sign fallback",
      favoriteOrUnderdog({ betType: "MONEYLINE", odds: -104, line: null, pickedSide: null, mlFavoredSide: "HOME", oddsSource: "STATED" }),
      "FAVORITE"
    );
    // Stored value wins even against a positive price (a coin-flip game where
    // this side closed as the favorite despite plus money).
    check(
      "A: stored favored side overrides a positive price",
      favoriteOrUnderdog({ betType: "MONEYLINE", odds: 115, line: null, pickedSide: "AWAY", mlFavoredSide: "AWAY" }),
      "FAVORITE"
    );
    // SPREAD path is untouched - still purely the line sign.
    check(
      "A: SPREAD still classified by line sign, ignoring the new fields",
      favoriteOrUnderdog({ betType: "SPREAD", odds: -110, line: -1.5, pickedSide: "AWAY", mlFavoredSide: "HOME" }),
      "FAVORITE"
    );
  }

  // ---- B. pickCategory end-to-end ----
  {
    check(
      "B: Diamondbacks -104 (AWAY, fav HOME) -> DOG_ML",
      pickCategory({
        betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Diamondbacks ML",
        odds: -104, line: null, sportName: "MLB", pickedSide: "AWAY", mlFavoredSide: "HOME", oddsSource: "DEFAULTED",
      }),
      "DOG_ML"
    );
    check(
      "B: Phillies -112 (HOME, fav HOME) -> FAV_ML",
      pickCategory({
        betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Phillies ML",
        odds: -112, line: null, sportName: "MLB", pickedSide: "HOME", mlFavoredSide: "HOME", oddsSource: null,
      }),
      "FAV_ML"
    );
    check(
      "B: legacy pick (-104, no sides, no oddsSource) -> no category (was FAV_ML)",
      pickCategory({
        betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Diamondbacks ML",
        odds: -104, line: null, sportName: "MLB", oddsSource: null,
      }),
      null
    );
    check(
      "B: DEFAULTED -110 with no sides -> no category (was FAV_ML)",
      pickCategory({ betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Diamondbacks ML", odds: -110, line: null, sportName: "MLB", oddsSource: "DEFAULTED" }),
      null
    );
    check(
      "B: STATED -150 with no sides -> FAV_ML (manual picks keep reading by sign)",
      pickCategory({ betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Phillies ML", odds: -150, line: null, sportName: "MLB", oddsSource: "STATED" }),
      "FAV_ML"
    );
  }

  // ---- C. favoredSideFromOddsGame ----
  {
    const oddsGame = (homePrice: number | null, awayPrice: number | null, includeH2h = true): OddsGame => ({
      id: "g1",
      sportKey: "baseball_mlb",
      homeTeam: "Philadelphia Phillies",
      awayTeam: "Arizona Diamondbacks",
      commenceTime: "2026-09-02T19:41:00Z",
      bookmakers: [
        {
          key: "fanduel",
          title: "FanDuel",
          markets: [
            ...(includeH2h
              ? [
                  {
                    key: "h2h",
                    outcomes: [
                      ...(homePrice !== null ? [{ name: "Philadelphia Phillies", price: homePrice }] : []),
                      ...(awayPrice !== null ? [{ name: "Arizona Diamondbacks", price: awayPrice }] : []),
                    ],
                  },
                ]
              : []),
            { key: "totals", outcomes: [{ name: "Over", price: -110, point: 9.5 }, { name: "Under", price: -110, point: 9.5 }] },
          ],
        },
      ],
    });

    check("C: -112 home / -104 away -> HOME favored", favoredSideFromOddsGame(oddsGame(-112, -104)), "HOME");
    check("C: -104 home / -112 away -> AWAY favored", favoredSideFromOddsGame(oddsGame(-104, -112)), "AWAY");
    check("C: equal prices (-110 / -110) -> null (true pick'em)", favoredSideFromOddsGame(oddsGame(-110, -110)), null);
    check("C: one side's price missing -> null", favoredSideFromOddsGame(oddsGame(-112, null)), null);
    check("C: no h2h market -> null", favoredSideFromOddsGame(oddsGame(-112, -104, false)), null);
  }

  // ---- D. computeCategoryBreakdown: opposite sides of one pick'em now split ----
  {
    // Two picks on the SAME juiced pick'em game, opposite sides. Before the fix
    // both landed in FAV_ML (both odds negative); now one is FAV_ML, one DOG_ML.
    const picks: CatRow[] = [
      mlPick({ pickedSide: "HOME", mlFavoredSide: "HOME", odds: -112 }), // Phillies - favorite
      mlPick({ pickedSide: "AWAY", mlFavoredSide: "HOME", odds: -104 }), // Diamondbacks - underdog
    ];
    const items = computeCategoryBreakdown(picks, ALL_CATEGORY_KEYS);
    const fav = items.find((i) => i.key === "FAV_ML");
    const dog = items.find((i) => i.key === "DOG_ML");
    check("D: FAV_ML has exactly the one favorite pick", fav?.count, 1);
    check("D: DOG_ML has exactly the one underdog pick (not blended into FAV_ML)", dog?.count, 1);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
