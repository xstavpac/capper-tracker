// Which stored category (Pick.category, pickCategory in server/data/stats.ts) a
// player prop gets: one permanent key per market per sport family, so an
// Anytime Goal Scorer record (~+150) is never averaged with an over at -110.
//
// The key does NOT depend on volume - a market keeps its key from its first pick,
// so a category never moves under a capper as its count grows. A market that is
// rare or that no parser for the family produces maps to "OTHER" and is stored as
// OTHER_PROP ("Other props"), so nothing disappears.
//
// Every table below is a full Record<PropMarket, ...>: adding a PropMarket enum
// value fails the typecheck until each family says what it is - its own key or
// "OTHER". prop-category-coverage-acceptance-test.ts checks that every market a
// family's parser produces has a key of its own.
//
// Keys never repeat across families: categoryRecordKey(capperId, category) has no
// league in it, so NBA points and NHL points must be different keys (PTS_PROP vs
// NHL_POINTS_PROP). Leagues in one family share keys (NBA and WNBA, NFL and NCAAF).
// The ten football keys keep the names they had before version 5.
//
// Client-safe: a type-only import.
import type { PropMarket } from "@prisma/client";
import { propSportFamily, type PropSportFamily } from "@/lib/prop-market-key";

type PropCategoryText = { label: string; noun: string; specialist: string };

// label: the tile / chip. noun: slots into "N% (W-L) All-Time ___ Picks" (the
// /live game-card record line). specialist: the /cappers tag.
export const PROP_CATEGORY_TEXT = {
  // Football (NFL; NCAAF shares the keys)
  PASS_YDS_PROP: { label: "Passing Yards", noun: "passing yards", specialist: "Passing-yards specialist" },
  RUSH_YDS_PROP: { label: "Rushing Yards", noun: "rushing yards", specialist: "Rushing-yards specialist" },
  REC_YDS_PROP: { label: "Receiving Yards", noun: "receiving yards", specialist: "Receiving-yards specialist" },
  RECEPTIONS_PROP: { label: "Receptions", noun: "receptions", specialist: "Receptions specialist" },
  RUSH_REC_YDS_PROP: { label: "Rush + Rec Yards", noun: "rushing + receiving yards", specialist: "Rush + rec yards specialist" },
  PASS_RUSH_YDS_PROP: { label: "Pass + Rush Yards", noun: "passing + rushing yards", specialist: "Pass + rush yards specialist" },
  PASS_ATTEMPTS_PROP: { label: "Pass Attempts", noun: "pass attempts", specialist: "Pass-attempts specialist" },
  PASS_COMPLETIONS_PROP: { label: "Completions", noun: "completions", specialist: "Completions specialist" },
  PASS_INTERCEPTIONS_PROP: { label: "Interceptions", noun: "interceptions thrown", specialist: "Interceptions specialist" },
  RUSH_ATTEMPTS_PROP: { label: "Rushing Attempts", noun: "rushing attempts", specialist: "Rushing-attempts specialist" },
  ANYTIME_TD_PROP: { label: "Anytime TD", noun: "anytime touchdown", specialist: "Anytime-TD specialist" },
  TD_COUNT_PROP: { label: "TD Count", noun: "touchdown count (2+ / over-under)", specialist: "TD-count specialist" },
  PASS_TDS_PROP: { label: "Passing TDs", noun: "passing touchdowns", specialist: "Passing-TDs specialist" },
  // Basketball (NBA; WNBA shares the keys)
  PTS_PROP: { label: "Points", noun: "points", specialist: "Points-prop specialist" },
  REB_PROP: { label: "Rebounds", noun: "rebounds", specialist: "Rebounds specialist" },
  AST_PROP: { label: "Assists", noun: "assists", specialist: "Assists specialist" },
  THREES_PROP: { label: "Threes Made", noun: "threes made", specialist: "Threes specialist" },
  PRA_PROP: { label: "Pts + Reb + Ast", noun: "points + rebounds + assists", specialist: "PRA specialist" },
  PR_PROP: { label: "Pts + Reb", noun: "points + rebounds", specialist: "Points + rebounds specialist" },
  PA_PROP: { label: "Pts + Ast", noun: "points + assists", specialist: "Points + assists specialist" },
  RA_PROP: { label: "Reb + Ast", noun: "rebounds + assists", specialist: "Rebounds + assists specialist" },
  STL_PROP: { label: "Steals", noun: "steals", specialist: "Steals specialist" },
  BLK_PROP: { label: "Blocks", noun: "blocks", specialist: "Blocks specialist" },
  DREB_PROP: { label: "Defensive Rebounds", noun: "defensive rebounds", specialist: "Defensive-rebounds specialist" },
  DOUBLE_DOUBLE_PROP: { label: "Double-Double", noun: "double-double", specialist: "Double-double specialist" },
  // Hockey (NHL)
  ANYTIME_GOAL_PROP: { label: "Anytime Goal", noun: "anytime goal scorer", specialist: "Anytime-goal specialist" },
  FIRST_GOAL_PROP: { label: "First Goal", noun: "first goal scorer", specialist: "First-goal specialist" },
  SOG_PROP: { label: "Shots on Goal", noun: "shots on goal", specialist: "Shots-on-goal specialist" },
  NHL_POINTS_PROP: { label: "Points", noun: "hockey points", specialist: "Hockey-points specialist" },
  NHL_ASSISTS_PROP: { label: "Assists", noun: "hockey assists", specialist: "Hockey-assists specialist" },
  SAVES_PROP: { label: "Saves", noun: "goalie saves", specialist: "Saves specialist" },
  // Baseball (MLB)
  K_PROP: { label: "Strikeouts", noun: "pitcher strikeouts", specialist: "Strikeouts specialist" },
  OUTS_PROP: { label: "Outs Recorded", noun: "outs recorded", specialist: "Outs-recorded specialist" },
  TB_PROP: { label: "Total Bases", noun: "total bases", specialist: "Total-bases specialist" },
  HITS_PROP: { label: "Hits", noun: "hits", specialist: "Hits specialist" },
  HR_PROP: { label: "Home Runs", noun: "home runs", specialist: "Home-run specialist" },
  RBI_PROP: { label: "RBIs", noun: "RBIs", specialist: "RBI specialist" },
  RUNS_PROP: { label: "Runs", noun: "runs scored", specialist: "Runs specialist" },
  WALKS_PROP: { label: "Walks", noun: "walks", specialist: "Walks specialist" },
  // Every sport: a prop whose market has no key of its own, or a sport with no family.
  OTHER_PROP: { label: "Other props", noun: "player prop", specialist: "Player-prop specialist" },
} as const satisfies Record<string, PropCategoryText>;

export type PropCategoryKey = keyof typeof PROP_CATEGORY_TEXT;
export const PROP_CATEGORY_KEYS = Object.keys(PROP_CATEGORY_TEXT) as PropCategoryKey[];

type Slot = Exclude<PropCategoryKey, "OTHER_PROP"> | "OTHER";

// Each family, every PropMarket. Order within a family is the tile order (the
// sport's chip set lists them in this order).
export const PROP_CATEGORY_BY_FAMILY = {
  FOOTBALL: {
    TD: "ANYTIME_TD_PROP",
    REC_YDS: "REC_YDS_PROP",
    RUSH_YDS: "RUSH_YDS_PROP",
    RECEPTIONS: "RECEPTIONS_PROP",
    PASS_YDS: "PASS_YDS_PROP",
    PASS_TDS: "PASS_TDS_PROP",
    RUSH_REC_YDS: "RUSH_REC_YDS_PROP",
    PASS_RUSH_YDS: "PASS_RUSH_YDS_PROP",
    TD_COUNT: "TD_COUNT_PROP",
    PASS_ATTEMPTS: "PASS_ATTEMPTS_PROP",
    PASS_COMPLETIONS: "PASS_COMPLETIONS_PROP",
    PASS_INTERCEPTIONS: "PASS_INTERCEPTIONS_PROP",
    RUSH_ATTEMPTS: "RUSH_ATTEMPTS_PROP",
    DEFENSIVE_REBOUNDS: "OTHER",
    ANYTIME_GOAL: "OTHER",
    FIRST_GOAL: "OTHER",
    SHOTS_ON_GOAL: "OTHER",
    POINTS: "OTHER",
    ASSISTS: "OTHER",
    SAVES: "OTHER",
    STRIKEOUTS: "OTHER",
    OUTS_RECORDED: "OTHER",
    TOTAL_BASES: "OTHER",
    HITS: "OTHER",
    WALKS: "OTHER",
    RUNS: "OTHER",
    RBIS: "OTHER",
    HOME_RUNS: "OTHER",
    REBOUNDS: "OTHER",
    THREES_MADE: "OTHER",
    STEALS: "OTHER",
    BLOCKS: "OTHER",
    POINTS_REBOUNDS_ASSISTS: "OTHER",
    POINTS_REBOUNDS: "OTHER",
    POINTS_ASSISTS: "OTHER",
    REBOUNDS_ASSISTS: "OTHER",
    DOUBLE_DOUBLE: "OTHER",
  },
  BASKETBALL: {
    POINTS: "PTS_PROP",
    REBOUNDS: "REB_PROP",
    ASSISTS: "AST_PROP",
    THREES_MADE: "THREES_PROP",
    POINTS_REBOUNDS_ASSISTS: "PRA_PROP",
    POINTS_REBOUNDS: "PR_PROP",
    POINTS_ASSISTS: "PA_PROP",
    REBOUNDS_ASSISTS: "RA_PROP",
    STEALS: "STL_PROP",
    BLOCKS: "BLK_PROP",
    DEFENSIVE_REBOUNDS: "DREB_PROP",
    DOUBLE_DOUBLE: "DOUBLE_DOUBLE_PROP",
    PASS_YDS: "OTHER",
    RUSH_YDS: "OTHER",
    REC_YDS: "OTHER",
    RECEPTIONS: "OTHER",
    TD: "OTHER",
    RUSH_REC_YDS: "OTHER",
    PASS_RUSH_YDS: "OTHER",
    PASS_TDS: "OTHER",
    PASS_ATTEMPTS: "OTHER",
    RUSH_ATTEMPTS: "OTHER",
    PASS_INTERCEPTIONS: "OTHER",
    PASS_COMPLETIONS: "OTHER",
    TD_COUNT: "OTHER",
    ANYTIME_GOAL: "OTHER",
    FIRST_GOAL: "OTHER",
    SHOTS_ON_GOAL: "OTHER",
    SAVES: "OTHER",
    STRIKEOUTS: "OTHER",
    OUTS_RECORDED: "OTHER",
    TOTAL_BASES: "OTHER",
    HITS: "OTHER",
    WALKS: "OTHER",
    RUNS: "OTHER",
    RBIS: "OTHER",
    HOME_RUNS: "OTHER",
  },
  HOCKEY: {
    ANYTIME_GOAL: "ANYTIME_GOAL_PROP",
    SHOTS_ON_GOAL: "SOG_PROP",
    POINTS: "NHL_POINTS_PROP",
    ASSISTS: "NHL_ASSISTS_PROP",
    SAVES: "SAVES_PROP",
    FIRST_GOAL: "FIRST_GOAL_PROP",
    PASS_YDS: "OTHER",
    RUSH_YDS: "OTHER",
    REC_YDS: "OTHER",
    RECEPTIONS: "OTHER",
    TD: "OTHER",
    RUSH_REC_YDS: "OTHER",
    PASS_RUSH_YDS: "OTHER",
    PASS_TDS: "OTHER",
    PASS_ATTEMPTS: "OTHER",
    RUSH_ATTEMPTS: "OTHER",
    PASS_INTERCEPTIONS: "OTHER",
    PASS_COMPLETIONS: "OTHER",
    TD_COUNT: "OTHER",
    DEFENSIVE_REBOUNDS: "OTHER",
    STRIKEOUTS: "OTHER",
    OUTS_RECORDED: "OTHER",
    TOTAL_BASES: "OTHER",
    HITS: "OTHER",
    WALKS: "OTHER",
    RUNS: "OTHER",
    RBIS: "OTHER",
    HOME_RUNS: "OTHER",
    REBOUNDS: "OTHER",
    THREES_MADE: "OTHER",
    STEALS: "OTHER",
    BLOCKS: "OTHER",
    POINTS_REBOUNDS_ASSISTS: "OTHER",
    POINTS_REBOUNDS: "OTHER",
    POINTS_ASSISTS: "OTHER",
    REBOUNDS_ASSISTS: "OTHER",
    DOUBLE_DOUBLE: "OTHER",
  },
  BASEBALL: {
    OUTS_RECORDED: "OUTS_PROP",
    STRIKEOUTS: "K_PROP",
    TOTAL_BASES: "TB_PROP",
    HITS: "HITS_PROP",
    HOME_RUNS: "HR_PROP",
    RBIS: "RBI_PROP",
    RUNS: "RUNS_PROP",
    WALKS: "WALKS_PROP",
    PASS_YDS: "OTHER",
    RUSH_YDS: "OTHER",
    REC_YDS: "OTHER",
    RECEPTIONS: "OTHER",
    TD: "OTHER",
    RUSH_REC_YDS: "OTHER",
    PASS_RUSH_YDS: "OTHER",
    PASS_TDS: "OTHER",
    PASS_ATTEMPTS: "OTHER",
    RUSH_ATTEMPTS: "OTHER",
    PASS_INTERCEPTIONS: "OTHER",
    PASS_COMPLETIONS: "OTHER",
    TD_COUNT: "OTHER",
    DEFENSIVE_REBOUNDS: "OTHER",
    ANYTIME_GOAL: "OTHER",
    FIRST_GOAL: "OTHER",
    SHOTS_ON_GOAL: "OTHER",
    POINTS: "OTHER",
    ASSISTS: "OTHER",
    SAVES: "OTHER",
    REBOUNDS: "OTHER",
    THREES_MADE: "OTHER",
    STEALS: "OTHER",
    BLOCKS: "OTHER",
    POINTS_REBOUNDS_ASSISTS: "OTHER",
    POINTS_REBOUNDS: "OTHER",
    POINTS_ASSISTS: "OTHER",
    REBOUNDS_ASSISTS: "OTHER",
    DOUBLE_DOUBLE: "OTHER",
  },
} as const satisfies Record<PropSportFamily, Record<PropMarket, Slot>>;

// A prop's category: its family's key for the market, else OTHER_PROP (a market
// the family has no key for, or a sport with no family - ATP, NCAAB, ...).
export function propCategoryFor(sportName: string, market: PropMarket): PropCategoryKey {
  const family = propSportFamily(sportName);
  const slot: Slot = family ? PROP_CATEGORY_BY_FAMILY[family][market] : "OTHER";
  return slot === "OTHER" ? "OTHER_PROP" : slot;
}

// A family's own keys, in tile order, then OTHER_PROP: what the family's sports
// list in their chip sets (stats.ts).
export function propTileKeysForFamily(family: PropSportFamily): PropCategoryKey[] {
  const own = Object.values(PROP_CATEGORY_BY_FAMILY[family]).filter((s): s is Exclude<Slot, "OTHER"> => s !== "OTHER");
  return [...own, "OTHER_PROP"];
}
