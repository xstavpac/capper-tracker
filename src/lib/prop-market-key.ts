// A player prop's market record key: which stat the pick is on, scoped to the
// sport the stat belongs to - "BASKETBALL:POINTS", "HOCKEY:SHOTS_ON_GOAL". The
// stored category (Pick.category, pickCategory in stats.ts) blends every prop
// outside the 10 NFL stat markets into one TD_PROP "Player Props" record; this
// key is the per-market split of the same picks, kept ALONGSIDE that category
// and never replacing it. Every record surface (capper tiles, /cappers, charts,
// Savant, dashboard) still reads the category; the Parlay Generator is the only
// reader of this key so far (getCapperPropMarketRecords in server/data/picks.ts,
// recordForGate in lib/parlay/pick-record.ts).
//
// Built from two stored columns - the pick's sport and Pick.propMarket - so it
// needs no column of its own and no backfill. The family is what makes one
// PropMarket value mean one stat: POINTS is shared by the NHL (goals + assists)
// and the NBA (PTS), so an NHL POINTS pick and an NBA POINTS pick get different
// keys. Leagues in one family play the same stat (NBA and WNBA points, NFL and
// NCAAF passing yards), so a family's leagues share a key - that is the
// all-time record's reach. A market outside its family's list (a stored value
// no parser for that sport produces) gets no key, like a pick with no
// propMarket at all (rows predating the column, an unparsable prop): those
// picks have no per-market record.
//
// Client-safe: a type-only import, so the generator's engine can read it in the
// browser.
import type { PropMarket } from "@prisma/client";

export type PropSportFamily = "FOOTBALL" | "BASKETBALL" | "HOCKEY" | "BASEBALL";

const FAMILY_BY_SPORT: Record<string, PropSportFamily> = {
  NFL: "FOOTBALL",
  NCAAF: "FOOTBALL",
  NBA: "BASKETBALL",
  WNBA: "BASKETBALL",
  NHL: "HOCKEY",
  MLB: "BASEBALL",
};

export function propSportFamily(sportName: string): PropSportFamily | null {
  return FAMILY_BY_SPORT[sportName.toUpperCase()] ?? null;
}

// Each family's markets, as each sport's parser produces them (bet-line.ts for
// football, nba-prop.ts, nhl-prop.ts, mlb-prop.ts), labelled as a noun that
// slots into "62% (21–10) · NBA ___". The football nouns are
// PICK_CATEGORY_MARKET_NOUN's for the same markets, so an NFL stat prop reads
// the same as it does by category.
const MARKET_NOUNS = {
  FOOTBALL: {
    PASS_YDS: "passing yards",
    RUSH_YDS: "rushing yards",
    REC_YDS: "receiving yards",
    RECEPTIONS: "receptions",
    RUSH_REC_YDS: "rushing + receiving yards",
    PASS_RUSH_YDS: "passing + rushing yards",
    PASS_ATTEMPTS: "pass attempts",
    PASS_COMPLETIONS: "completions",
    PASS_INTERCEPTIONS: "interceptions thrown",
    RUSH_ATTEMPTS: "rushing attempts",
    TD: "touchdowns",
    PASS_TDS: "passing touchdowns",
  },
  BASKETBALL: {
    POINTS: "points",
    REBOUNDS: "rebounds",
    ASSISTS: "assists",
    THREES_MADE: "threes made",
    STEALS: "steals",
    BLOCKS: "blocks",
    POINTS_REBOUNDS_ASSISTS: "points + rebounds + assists",
    POINTS_REBOUNDS: "points + rebounds",
    POINTS_ASSISTS: "points + assists",
    REBOUNDS_ASSISTS: "rebounds + assists",
    DOUBLE_DOUBLE: "double-double",
  },
  HOCKEY: {
    POINTS: "points",
    ASSISTS: "assists",
    SHOTS_ON_GOAL: "shots on goal",
    SAVES: "saves",
    ANYTIME_GOAL: "anytime goal",
    FIRST_GOAL: "first goal",
  },
  BASEBALL: {
    HITS: "hits",
    TOTAL_BASES: "total bases",
    HOME_RUNS: "home runs",
    RBIS: "RBIs",
    RUNS: "runs",
    WALKS: "walks",
    STRIKEOUTS: "pitcher strikeouts",
    OUTS_RECORDED: "outs recorded",
  },
} as const satisfies Record<PropSportFamily, Partial<Record<PropMarket, string>>>;

type Nouns = typeof MARKET_NOUNS;
export type PropMarketKey = { [F in PropSportFamily]: `${F}:${keyof Nouns[F] & string}` }[PropSportFamily];

export const PROP_MARKET_LABELS = Object.fromEntries(
  (Object.keys(MARKET_NOUNS) as PropSportFamily[]).flatMap((family) =>
    Object.entries(MARKET_NOUNS[family]).map(([market, noun]) => [`${family}:${market}`, noun])
  )
) as Record<PropMarketKey, string>;

export const PROP_MARKET_KEYS = Object.keys(PROP_MARKET_LABELS) as PropMarketKey[];

// The pick's key, or null: not a player prop, no propMarket, a sport with no
// family, or a market its family has no key for.
export function propMarketKey(pick: { betType: string; sportName: string; propMarket?: string | null }): PropMarketKey | null {
  if (pick.betType !== "PLAYER_PROP" || !pick.propMarket) return null;
  const family = propSportFamily(pick.sportName);
  if (!family) return null;
  const key = `${family}:${pick.propMarket}`;
  return key in PROP_MARKET_LABELS ? (key as PropMarketKey) : null;
}

// The key's PropMarket half - what the record bundle's SQL matches on
// (Pick.propMarket), the family half being applied in JS.
export function propMarketOf(key: PropMarketKey): PropMarket {
  return key.slice(key.indexOf(":") + 1) as PropMarket;
}
