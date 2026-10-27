// Proof for the NBA PropMarket values - run with:
//   npx tsx src/server/data/nba-prop-markets-acceptance-test.ts
//
// No database, no network. Two jobs:
//   PART A - the enum: the nine new values exist, POINTS / ASSISTS are the
//            only values two sports share, every value belongs to a sport.
//   PART B - adding the values changed nothing for the leagues that already
//            have props: an NHL POINTS / ASSISTS pick filters, categorizes,
//            labels and dedups exactly as before.
//   PART C - what a pick carrying an NBA value does TODAY, at every place that
//            reads PropMarket without the sport. Nothing imports such a pick
//            yet (NBA props are still rejected at import); these are pinned so
//            the PRs that add parsing, grading, odds and display each have to
//            change the one they own on purpose. Grading is now the NBA grader's
//            (nba-prop-grading.ts); fetch is stubbed, so still no network.
import { PropMarket } from "@prisma/client";
import { NBA_PROP_MARKETS, NBA_ONLY_PROP_MARKETS, isNbaPropMarket } from "@/lib/nba-prop";
import { NHL_PROP_MARKETS, isNhlPropMarket } from "@/lib/nhl-prop";
import { MLB_PROP_MARKETS, isMlbPropMarket } from "@/lib/mlb-prop";
import { parseAnyPlayerProp } from "@/lib/bet-line";
import { betTypeFilterCategory, betTypeOptionsForChipSet, BET_TYPE_FILTER_OPTIONS } from "@/lib/bet-type-filter";
import { dedupCategory } from "@/lib/duplicate-pick-detection";
import { buildPickDisplayLabel } from "@/lib/pick-display-label";
import { pickCategory, chipSetForLeague } from "@/server/data/stats";
import { resolvePlayerProp } from "@/server/data/grading";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const NFL_MARKETS = ["PASS_YDS", "RUSH_YDS", "REC_YDS", "RECEPTIONS", "TD", "RUSH_REC_YDS", "PASS_RUSH_YDS", "PASS_TDS", "PASS_ATTEMPTS", "RUSH_ATTEMPTS", "PASS_INTERCEPTIONS", "PASS_COMPLETIONS"];
const NEW_VALUES = ["REBOUNDS", "THREES_MADE", "STEALS", "BLOCKS", "POINTS_REBOUNDS_ASSISTS", "POINTS_REBOUNDS", "POINTS_ASSISTS", "REBOUNDS_ASSISTS", "DOUBLE_DOUBLE"];

const filterPick = (propMarket: PropMarket | null, betDetail: string) => ({ betType: "PLAYER_PROP" as const, period: "FULL_GAME" as const, betDetail, propMarket });
const categoryPick = (sportName: string, propMarket: PropMarket | null, betDetail: string) => ({
  betType: "PLAYER_PROP" as const,
  period: "FULL_GAME" as const,
  betDetail,
  odds: -110,
  line: null,
  sportName,
  propMarket,
});
const labelInput = (sportName: string, playerName: string, propMarket: string, betDetail: string) => ({
  betType: "PLAYER_PROP",
  matched: true,
  period: "FULL_GAME" as const,
  homeTeam: "Home Team",
  awayTeam: "Away Team",
  pickedSide: null,
  line: null,
  playerName,
  propMarket,
  sportName,
  betDetail,
});

async function main() {
  console.log("########## PART A: the enum ##########");
  {
    const all = Object.values(PropMarket) as string[];
    check("the nine new values are in the Prisma enum", NEW_VALUES.filter((v) => !all.includes(v)), []);
    check("the enum's last nine values are the new ones, in order (additive, nothing moved)", all.slice(-9), NEW_VALUES);
    check("NBA_PROP_MARKETS is POINTS, ASSISTS and the nine new values", [...NBA_PROP_MARKETS], ["POINTS", "ASSISTS", ...NEW_VALUES]);
    check("every NBA market is a real enum value", NBA_PROP_MARKETS.filter((m) => !all.includes(m)), []);
    check("NBA_ONLY_PROP_MARKETS is exactly the nine new values", [...NBA_ONLY_PROP_MARKETS], NEW_VALUES);

    // Reuse: one value, one stat. POINTS / ASSISTS are the only shared ones.
    const shared = (a: readonly string[], b: readonly string[]) => a.filter((m) => b.includes(m));
    check("NHL and NBA share exactly POINTS and ASSISTS", shared(NHL_PROP_MARKETS, NBA_PROP_MARKETS), ["POINTS", "ASSISTS"]);
    check("NBA shares nothing with MLB", shared(NBA_PROP_MARKETS, MLB_PROP_MARKETS), []);
    check("NBA shares nothing with NFL", shared(NBA_PROP_MARKETS, NFL_MARKETS), []);
    check("no new value is claimed by the NHL or MLB lists", NEW_VALUES.filter((v) => isNhlPropMarket(v) || isMlbPropMarket(v)), []);
    check("POINTS belongs to both leagues' lists - the sport has to decide", [isNhlPropMarket("POINTS"), isNbaPropMarket("POINTS"), isNhlPropMarket("ASSISTS"), isNbaPropMarket("ASSISTS")], [true, true, true, true]);
    check("isNbaPropMarket rejects other sports' values and junk", [isNbaPropMarket("SAVES"), isNbaPropMarket("TD"), isNbaPropMarket("HITS"), isNbaPropMarket(null), isNbaPropMarket("")], [false, false, false, false, false]);

    // Every enum value belongs to at least one sport's list - a value added to
    // the schema without one fails here.
    const owned = new Set<string>([...NFL_MARKETS, ...NHL_PROP_MARKETS, ...MLB_PROP_MARKETS, ...NBA_PROP_MARKETS]);
    check("every PropMarket value belongs to a sport's market list", all.filter((v) => !owned.has(v)), []);
    check("and no list names a value the enum lacks", [...owned].filter((v) => !all.includes(v)), []);
  }

  console.log("\n########## PART B: NHL POINTS / ASSISTS behave as before ##########");
  {
    check("NHL POINTS pick -> filter key POINTS", betTypeFilterCategory(filterPick("POINTS", "Connor McDavid Over 1.5 Points")), "POINTS");
    check("NHL ASSISTS pick -> filter key ASSISTS", betTypeFilterCategory(filterPick("ASSISTS", "Connor McDavid Over 0.5 Assists")), "ASSISTS");
    check("hockey's filter options still offer the six NHL markets", ["ANYTIME_GOAL", "FIRST_GOAL", "SHOTS_ON_GOAL", "POINTS", "ASSISTS", "SAVES"].filter((k) => !betTypeOptionsForChipSet(chipSetForLeague("NHL")).has(k as never)), []);
    check("NHL POINTS pick -> category TD_PROP (unchanged)", pickCategory(categoryPick("NHL", "POINTS", "Connor McDavid Over 1.5 Points")), "TD_PROP");
    check("NHL POINTS label", buildPickDisplayLabel(labelInput("NHL", "Connor McDavid", "POINTS", "Connor McDavid Over 1.5 Points")), "Connor McDavid Over 1.5 Points");
    check("NHL POINTS dedup key", dedupCategory("TD_PROP", "PLAYER_PROP", "Connor McDavid Over 1.5 Points", null, { propMarket: "POINTS", playerName: "Connor McDavid" }), "TD_PROP:POINTS:connormcdavid"); // the player part is normalizeName-d (no spaces/punctuation) so an alias and its full name share a key
    // The sport-blind text parser still reads a low points / assists line as the NHL market, and nothing as an NBA one.
    check("text parser: 'Connor McDavid over 1.5 points' -> NHL POINTS", parseAnyPlayerProp("Connor McDavid over 1.5 points")?.propMarket, "POINTS");
    check("text parser: no line returns an NBA-only market", ["LeBron James over 7.5 rebounds", "Stephen Curry over 4.5 threes", "Nikola Jokic over 48.5 PRA", "Nikola Jokic double-double"].map((t) => parseAnyPlayerProp(t)?.propMarket ?? null), [null, null, null, null]);
    // Other sports' filter options are untouched.
    check("no filter option lists a new value", BET_TYPE_FILTER_OPTIONS.filter((o) => NEW_VALUES.includes(o.value)).map((o) => o.value), []);
    check("the option list is the 31 from before plus the 4 NFL attempts / completions / interceptions markets", BET_TYPE_FILTER_OPTIONS.length, 35);
  }

  console.log("\n########## PART C: a pick carrying an NBA value, today (pinned for the PRs that follow) ##########");
  {
    // Grading: never the NHL grader, and no longer the NFL-only gate. An NBA pick
    // goes to the NBA grader (nba-prop-grading.ts) - with POINTS (shared) exactly
    // as with REBOUNDS (new). fetch is stubbed to fail, so each one stops at the
    // box-score read and the URL it asked for shows which grader it reached.
    const nba = { playerName: "Nikola Jokic", homeTeam: "Denver Nuggets", awayTeam: "Los Angeles Lakers" };
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const NO_BOX = { outcome: null, reason: "the box score isn't available yet for this game" };
    try {
      check("grading: NBA POINTS pick -> the NBA grader", await resolvePlayerProp({ ...nba, propMarket: "POINTS", betDetail: "Nikola Jokic Over 27.5 Points" }, "1", "NBA"), NO_BOX);
      check("grading: NBA ASSISTS pick with a hockey-sized line -> still the NBA grader", await resolvePlayerProp({ ...nba, propMarket: "ASSISTS", betDetail: "Nikola Jokic Over 2.5 Assists" }, "1", "NBA"), NO_BOX);
      check("grading: NBA REBOUNDS pick -> the NBA grader", await resolvePlayerProp({ ...nba, propMarket: "REBOUNDS", betDetail: "Nikola Jokic Over 12.5 Rebounds" }, "1", "NBA"), NO_BOX);
      check("grading: NBA DOUBLE_DOUBLE pick -> the NBA grader", await resolvePlayerProp({ ...nba, propMarket: "DOUBLE_DOUBLE", betDetail: "Nikola Jokic Double-Double" }, "1", "NBA"), NO_BOX);
    } finally {
      globalThis.fetch = realFetch;
    }
    check("grading: all four read ESPN's basketball summary, never hockey's", asked.map((u) => u.includes("/basketball/nba/summary?event=1")), [true, true, true, true]);

    // Filter: the key is the market alone, so an NBA POINTS pick answers to the
    // same "Points" option an NHL one does; the new values have no option.
    check("filter: NBA POINTS pick -> the same key as NHL (market alone, no sport)", betTypeFilterCategory(filterPick("POINTS", "Nikola Jokic Over 27.5 Points")), "POINTS");
    check("filter: NBA REBOUNDS pick -> a key no option offers", betTypeFilterCategory(filterPick("REBOUNDS", "Nikola Jokic Over 12.5 Rebounds")), "REBOUNDS");
    check("filter: the NBA chip set offers no prop option at all", [...betTypeOptionsForChipSet(chipSetForLeague("NBA"))].filter((k) => k === "POINTS" || k === "ASSISTS" || NEW_VALUES.includes(k)), []);

    // Category: everything outside the four NFL stat markets is TD_PROP, a tile the NBA chip set does not have.
    check("category: NBA REBOUNDS pick -> TD_PROP", pickCategory(categoryPick("NBA", "REBOUNDS", "Nikola Jokic Over 12.5 Rebounds")), "TD_PROP");
    check("category: the NBA chip set has no TD_PROP tile", chipSetForLeague("NBA").includes("TD_PROP"), false);

    // Label: POINTS / ASSISTS reuse the NHL phrase; a new value has none and falls back to the raw text.
    check("label: NBA POINTS", buildPickDisplayLabel(labelInput("NBA", "Nikola Jokic", "POINTS", "Nikola Jokic Over 27.5 Points")), "Nikola Jokic Over 27.5 Points");
    check("label: NBA REBOUNDS has no phrase yet", buildPickDisplayLabel(labelInput("NBA", "Nikola Jokic", "REBOUNDS", "Nikola Jokic Over 12.5 Rebounds")), null);

    // Dedup: market + player, no sport in the key.
    check("dedup: NBA REBOUNDS key", dedupCategory("TD_PROP", "PLAYER_PROP", "Nikola Jokic Over 12.5 Rebounds", null, { propMarket: "REBOUNDS", playerName: "Nikola Jokic" }), "TD_PROP:REBOUNDS:nikolajokic");
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
