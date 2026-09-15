// Proof for betTypeFilterCategory's PLAYER_PROP split (bet-type-filter.ts) -
// run with:
//   npx tsx src/lib/bet-type-filter-player-prop-split-acceptance-test.ts
//
// Before this change, every PLAYER_PROP pick collapsed into one flat
// "PLAYER_PROP" filter key regardless of market, so a capper filtering their
// picks list could only select the generic "Player Prop" option, not filter
// by TD/Passing Yards/Rushing Yards/Receiving Yards/Receptions specifically.
// This proves the new behavior:
//   - propMarket, when set, resolves directly to the matching one of the 5
//     new filter keys (TD/PASS_YDS/RUSH_YDS/REC_YDS/RECEPTIONS)
//   - propMarket === null falls back to re-parsing betDetail with the same
//     shared parser (parsePlayerProp) stats.ts/grading.ts already use for
//     this exact fallback, and resolves to the matching key
//   - a market that can't be resolved from either source (null propMarket,
//     unparseable betDetail) matches none of the 5 new keys - same as any
//     other unparseable pick today, not a silent match on one of them
//   - "PLAYER_PROP" itself is no longer a valid BetTypeFilterKey/exposed
//     option anywhere
//   - betTypeOptionsForChipSet/visibleBetTypeOptionsForChipSet (moved out of
//     picks/page.tsx so this sport-gating decision is covered here too, not
//     just the classification above) correctly expose all 5 new keys for a
//     chip set that includes TD_PROP (NFL), and none of them for one that
//     doesn't (MLB)
import {
  betTypeFilterCategory,
  betTypeOptionsForChipSet,
  BET_TYPE_FILTER_OPTIONS,
  type BetTypeFilterKey,
} from "@/lib/bet-type-filter";
import { MLB_CHIP_SET, NFL_CHIP_SET } from "@/server/data/stats";
import type { BetType, Period, PropMarket } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function propPick(over: { betDetail: string | null; propMarket?: PropMarket | null }) {
  return betTypeFilterCategory({
    betType: "PLAYER_PROP" as BetType,
    period: "FULL_GAME" as Period,
    betDetail: over.betDetail,
    propMarket: over.propMarket ?? null,
  });
}

function main() {
  // --- Structured path: propMarket set, trusted directly, one per market --

  check("propMarket=TD -> TD", propPick({ betDetail: "Josh Allen Anytime TD", propMarket: "TD" }), "TD");
  check(
    "propMarket=PASS_YDS -> PASS_YDS",
    propPick({ betDetail: "Josh Allen Over 275.5 Passing Yards", propMarket: "PASS_YDS" }),
    "PASS_YDS"
  );
  check(
    "propMarket=RUSH_YDS -> RUSH_YDS",
    propPick({ betDetail: "Bijan Robinson Under 65.5 Rushing Yards", propMarket: "RUSH_YDS" }),
    "RUSH_YDS"
  );
  check(
    "propMarket=REC_YDS -> REC_YDS",
    propPick({ betDetail: "CeeDee Lamb Over 85.5 Receiving Yards", propMarket: "REC_YDS" }),
    "REC_YDS"
  );
  check(
    "propMarket=RECEPTIONS -> RECEPTIONS",
    propPick({ betDetail: "Justin Jefferson Over 5.5 Receptions", propMarket: "RECEPTIONS" }),
    "RECEPTIONS"
  );

  // A structured propMarket is trusted even if betDetail looks nothing like
  // a prop - it's the real signal, not a re-derived guess.
  check(
    "propMarket set trusted directly, even over unrelated betDetail text",
    propPick({ betDetail: "garbled data", propMarket: "TD" }),
    "TD"
  );

  // --- Fallback path: propMarket null, resolved from betDetail text -------

  check(
    "fallback (propMarket null): TD text -> TD",
    propPick({ betDetail: "Puka Nacua Anytime TD" }),
    "TD"
  );
  check(
    "fallback (propMarket null): Passing Yards text -> PASS_YDS",
    propPick({ betDetail: "Josh Allen Over 275.5 Passing Yards" }),
    "PASS_YDS"
  );
  check(
    "fallback (propMarket null): Rushing Yards text -> RUSH_YDS",
    propPick({ betDetail: "Bijan Robinson Under 65.5 Rushing Yards" }),
    "RUSH_YDS"
  );
  check(
    "fallback (propMarket null): Receiving Yards text -> REC_YDS",
    propPick({ betDetail: "CeeDee Lamb Over 85.5 Receiving Yards" }),
    "REC_YDS"
  );
  check(
    "fallback (propMarket null): Receptions text -> RECEPTIONS",
    propPick({ betDetail: "Justin Jefferson Over 5.5 Receptions" }),
    "RECEPTIONS"
  );

  // --- Unresolvable market: matches none of the 5 new keys ----------------

  check(
    "fallback (propMarket null): malformed/unparseable prop text -> null, not any of the 5 keys",
    propPick({ betDetail: "Player Prop" }),
    null
  );
  check("fallback (propMarket null): empty betDetail -> null", propPick({ betDetail: "" }), null);
  check("fallback (propMarket null): null betDetail -> null", propPick({ betDetail: null }), null);

  // --- PLAYER_PROP is no longer a valid/exposed filter key -----------------

  const optionValues = BET_TYPE_FILTER_OPTIONS.map((o) => o.value);
  check(
    "BET_TYPE_FILTER_OPTIONS no longer exposes PLAYER_PROP",
    optionValues.includes("PLAYER_PROP" as BetTypeFilterKey),
    false
  );
  check(
    "BET_TYPE_FILTER_OPTIONS exposes all 5 concrete markets",
    ["TD", "PASS_YDS", "RUSH_YDS", "REC_YDS", "RECEPTIONS"].every((k) => optionValues.includes(k as BetTypeFilterKey)),
    true
  );

  // --- Chip-set gating: NFL exposes all 5, a non-prop sport exposes none --

  const nflOptions = betTypeOptionsForChipSet(NFL_CHIP_SET);
  check(
    "NFL chip set (has TD_PROP) exposes all 5 concrete prop markets",
    ["TD", "PASS_YDS", "RUSH_YDS", "REC_YDS", "RECEPTIONS"].every((k) => nflOptions.has(k as BetTypeFilterKey)),
    true
  );
  check("NFL chip set does not expose the removed generic PLAYER_PROP key", nflOptions.has("PLAYER_PROP" as BetTypeFilterKey), false);

  const mlbOptions = betTypeOptionsForChipSet(MLB_CHIP_SET);
  check(
    "MLB chip set (no TD_PROP) exposes none of the 5 concrete prop markets",
    ["TD", "PASS_YDS", "RUSH_YDS", "REC_YDS", "RECEPTIONS"].some((k) => mlbOptions.has(k as BetTypeFilterKey)),
    false
  );

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
