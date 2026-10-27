// Single source of truth for the "Supported pick formats" section on the
// Catalog Import page (components/import/supported-formats.tsx renders from
// this; nothing about a format's status is written in the UI itself).
//
// A row is "supported" only when the text both PARSES and GRADES end-to-end.
// Each row carries a `check` describing how supported-pick-formats-acceptance-
// test.ts proves the parsing half against the real parsers, so a status here
// can't silently drift from what the import actually does. Grading coverage
// was verified by hand against grading.ts / nhl-prop-grading.ts /
// mlb-prop-grading.ts when this list was written - see each group's comment.
//
// Client-safe: type-only imports, no parser code pulled into the bundle.

import type { ParsedPick } from "./parse-catalog";
import type { PlayerPropMarket } from "./bet-line";
import type { MlbPropMarket } from "./mlb-prop";
import type { NhlPropMarket } from "./nhl-prop";
import type { NbaPropMarket } from "./nba-prop";

export type FormatStatus = "supported" | "asks" | "coming-soon" | "not-yet";

export const FORMAT_STATUS_LABEL: Record<FormatStatus, string> = {
  supported: "Supported",
  asks: "Asks you",
  "coming-soon": "Coming soon",
  "not-yet": "Not yet",
};

// How the acceptance test verifies a row's examples.
export type FormatCheck =
  // Through parseCatalog: resolves to one pick with this bet type (and sport).
  | {
      via: "catalog";
      betType: ParsedPick["betType"];
      // Omitted when the examples span leagues - the test then only requires a resolved one.
      sport?: string;
      gameNumber?: 1 | 2;
      explicitOdds?: number;
    }
  // Through parseCatalog: recognized as a 2-leg moneyline parlay.
  | { via: "catalog-parlay" }
  // Through parseCatalog: parses, but the team is ambiguous so the import asks.
  | { via: "catalog-asks" }
  // Through the prop parsers directly (surname/roster matching is server-side).
  | { via: "nfl-prop"; market: PlayerPropMarket; anytimeTd?: boolean }
  | { via: "mlb-prop"; market: MlbPropMarket }
  | { via: "nhl-prop"; market: NhlPropMarket }
  | { via: "nba-prop"; market: NbaPropMarket }
  // Recognized as an NBA prop with no graded market (triple-double, first basket).
  | { via: "nba-ungraded" }
  // Recognized as a touchdown prop that grading declines (first / multi TD).
  | { via: "nfl-td-ungraded" }
  // Flagged by detectUnsupportedNflStat - never imported as a pick.
  | { via: "nfl-unsupported-stat" };

export type FormatRow = {
  market: string;
  examples: string[];
  status: FormatStatus;
  // Short note shown after the examples (e.g. what the import asks).
  note?: string;
  check: FormatCheck;
};

export type FormatGroup = { title: string; rows: FormatRow[] };

export const SUPPORTED_PICK_FORMATS: FormatGroup[] = [
  {
    // Graded by gradePick (grading.ts): MONEYLINE / SPREAD / TOTAL, NRFI from
    // the first-inning score source, MLP via parlay-grading.ts.
    title: "Game lines",
    rows: [
      {
        market: "Moneyline",
        examples: ["Yankees ML", "Yankees moneyline"],
        status: "supported",
        check: { via: "catalog", betType: "MONEYLINE", sport: "MLB" },
      },
      {
        market: "Spread / run line / puck line",
        examples: ["Chiefs -3.5", "White Sox -1.5"],
        status: "supported",
        check: { via: "catalog", betType: "SPREAD" },
      },
      {
        market: "Game total",
        examples: ["Dodgers under 8.5", "Dodgers u 8.5"],
        status: "supported",
        check: { via: "catalog", betType: "TOTAL", sport: "MLB" },
      },
      {
        market: "With the capper's own odds",
        examples: ["Yankees ML -132", "Yankees ML (-132)"],
        status: "supported",
        check: { via: "catalog", betType: "MONEYLINE", sport: "MLB", explicitOdds: -132 },
      },
      {
        market: "Doubleheader game",
        examples: ["Cubs ML Gm 2", "Cubs Game Two ML"],
        status: "supported",
        check: { via: "catalog", betType: "MONEYLINE", sport: "MLB", gameNumber: 2 },
      },
      {
        market: "NRFI / YRFI",
        examples: ["Yankees NRFI", "Yankees YRFI"],
        status: "supported",
        check: { via: "catalog", betType: "NRFI", sport: "MLB" },
      },
      {
        market: "Moneyline parlay (MLP)",
        examples: ["Chiefs ML + Bills ML mlp"],
        status: "supported",
        check: { via: "catalog-parlay" },
      },
      {
        market: "Shared team name",
        examples: ["Giants +6.5"],
        status: "asks",
        note: "asks NFL or MLB",
        check: { via: "catalog-asks" },
      },
      {
        market: "City name only",
        examples: ["Detroit -6.5"],
        status: "asks",
        note: "asks which Detroit team",
        check: { via: "catalog-asks" },
      },
    ],
  },
  {
    // Graded from the NFL box score (grading.ts resolvePlayerProp /
    // resolveTouchdownProp); every PlayerPropMarket has a grading path.
    title: "NFL player props",
    rows: [
      {
        market: "Rushing yards",
        examples: ["Jahmyr Gibbs over 65.5 rush yds"],
        status: "supported",
        check: { via: "nfl-prop", market: "RUSH_YDS" },
      },
      {
        market: "Receiving yards",
        examples: ["Amon-Ra St. Brown over 80.5 receiving yards"],
        status: "supported",
        check: { via: "nfl-prop", market: "REC_YDS" },
      },
      {
        market: "Receptions",
        examples: ["Amon-Ra St. Brown over 6.5 receptions"],
        status: "supported",
        check: { via: "nfl-prop", market: "RECEPTIONS" },
      },
      {
        market: "Passing yards",
        examples: ["Jared Goff over 250.5 passing yards"],
        status: "supported",
        check: { via: "nfl-prop", market: "PASS_YDS" },
      },
      {
        market: "Passing TDs",
        examples: ["Jared Goff over 1.5 passing TDs"],
        status: "supported",
        check: { via: "nfl-prop", market: "PASS_TDS" },
      },
      {
        market: "Pass attempts",
        examples: ["Jared Goff over 33.5 pass attempts"],
        status: "supported",
        check: { via: "nfl-prop", market: "PASS_ATTEMPTS" },
      },
      {
        market: "Completions",
        examples: ["Jared Goff over 22.5 completions"],
        status: "supported",
        check: { via: "nfl-prop", market: "PASS_COMPLETIONS" },
      },
      {
        market: "Interceptions thrown",
        examples: ["Jared Goff over 0.5 interceptions"],
        status: "supported",
        check: { via: "nfl-prop", market: "PASS_INTERCEPTIONS" },
      },
      {
        market: "Rushing attempts",
        examples: ["Jahmyr Gibbs over 15.5 rushing attempts", "Jahmyr Gibbs over 15.5 carries"],
        status: "supported",
        check: { via: "nfl-prop", market: "RUSH_ATTEMPTS" },
      },
      {
        market: "Rush + rec yards",
        examples: ["Jahmyr Gibbs over 95.5 rush + rec yards"],
        status: "supported",
        check: { via: "nfl-prop", market: "RUSH_REC_YDS" },
      },
      {
        market: "Pass + rush yards",
        examples: ["Josh Allen over 280.5 pass + rush yards"],
        status: "supported",
        check: { via: "nfl-prop", market: "PASS_RUSH_YDS" },
      },
      {
        market: "Anytime TD",
        examples: ["Jahmyr Gibbs ATD", "Jahmyr Gibbs anytime TD"],
        status: "supported",
        check: { via: "nfl-prop", market: "TD", anytimeTd: true },
      },
    ],
  },
  {
    // Graded from the MLB Stats API box score (mlb-prop-grading.ts).
    title: "MLB player props",
    rows: [
      {
        market: "Strikeouts",
        examples: ["Tarik Skubal over 7.5 strikeouts"],
        status: "supported",
        check: { via: "mlb-prop", market: "STRIKEOUTS" },
      },
      {
        market: "Outs recorded",
        examples: ["Tarik Skubal over 17.5 outs recorded"],
        status: "supported",
        check: { via: "mlb-prop", market: "OUTS_RECORDED" },
      },
      {
        market: "Total bases",
        examples: ["Aaron Judge over 1.5 total bases"],
        status: "supported",
        check: { via: "mlb-prop", market: "TOTAL_BASES" },
      },
      {
        market: "Hits",
        examples: ["Aaron Judge over 1.5 hits"],
        status: "supported",
        check: { via: "mlb-prop", market: "HITS" },
      },
      {
        market: "Walks",
        examples: ["Juan Soto over 0.5 walks"],
        status: "supported",
        check: { via: "mlb-prop", market: "WALKS" },
      },
      {
        market: "Runs",
        examples: ["Aaron Judge over 0.5 runs"],
        status: "supported",
        check: { via: "mlb-prop", market: "RUNS" },
      },
      {
        market: "RBIs",
        examples: ["Aaron Judge over 0.5 RBIs"],
        status: "supported",
        check: { via: "mlb-prop", market: "RBIS" },
      },
      {
        market: "Home runs",
        examples: ["Aaron Judge over 0.5 home runs"],
        status: "supported",
        check: { via: "mlb-prop", market: "HOME_RUNS" },
      },
    ],
  },
  {
    // Graded from ESPN's NHL summary (nhl-prop-grading.ts).
    title: "NHL player props",
    rows: [
      {
        market: "Anytime goal",
        examples: ["Connor McDavid anytime goal"],
        status: "supported",
        check: { via: "nhl-prop", market: "ANYTIME_GOAL" },
      },
      {
        market: "First goal",
        examples: ["Connor McDavid first goal"],
        status: "supported",
        check: { via: "nhl-prop", market: "FIRST_GOAL" },
      },
      {
        market: "Shots on goal",
        examples: ["Connor McDavid over 3.5 shots on goal"],
        status: "supported",
        check: { via: "nhl-prop", market: "SHOTS_ON_GOAL" },
      },
      {
        market: "Points",
        examples: ["Connor McDavid over 1.5 points"],
        status: "supported",
        check: { via: "nhl-prop", market: "POINTS" },
      },
      {
        market: "Assists",
        examples: ["Connor McDavid over 0.5 assists"],
        status: "supported",
        check: { via: "nhl-prop", market: "ASSISTS" },
      },
      {
        market: "Goalie saves",
        examples: ["Igor Shesterkin over 27.5 saves"],
        status: "supported",
        check: { via: "nhl-prop", market: "SAVES" },
      },
    ],
  },
  {
    // Imported and matched to a game (the roster finds the player's team, and tells an NBA
    // points / assists line from an NHL one). Not graded yet, so not "supported": these sit pending.
    title: "NBA player props",
    rows: [
      {
        market: "Points",
        examples: ["Jalen Brunson over 24.5 points", "Jalen Brunson 25+ points", "Jalen Brunson o24.5 pts"],
        status: "coming-soon",
        note: "imports now; grading is next",
        check: { via: "nba-prop", market: "POINTS" },
      },
      {
        market: "Rebounds",
        examples: ["Nikola Jokic over 12.5 rebounds", "Nikola Jokic o12.5 reb"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "REBOUNDS" },
      },
      {
        market: "Assists",
        examples: ["Nikola Jokic over 9.5 assists", "Nikola Jokic o9.5 ast"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "ASSISTS" },
      },
      {
        market: "Threes made",
        examples: ["Stephen Curry over 4.5 threes", "Stephen Curry o4.5 3pm", "Stephen Curry 5+ 3s"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "THREES_MADE" },
      },
      {
        market: "Steals",
        examples: ["Alex Caruso over 1.5 steals", "Alex Caruso o1.5 stl"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "STEALS" },
      },
      {
        market: "Blocks",
        examples: ["Victor Wembanyama over 3.5 blocks", "Victor Wembanyama o3.5 blk"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "BLOCKS" },
      },
      {
        market: "Points + rebounds + assists",
        examples: ["Jayson Tatum PRA o38.5", "Jayson Tatum over 38.5 pts+reb+ast"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "POINTS_REBOUNDS_ASSISTS" },
      },
      {
        market: "Points + rebounds",
        examples: ["Joel Embiid P+R over 40.5", "Joel Embiid over 40.5 points and rebounds"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "POINTS_REBOUNDS" },
      },
      {
        market: "Points + assists",
        examples: ["Tyrese Haliburton P+A o30.5", "Tyrese Haliburton over 30.5 pts+ast"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "POINTS_ASSISTS" },
      },
      {
        market: "Rebounds + assists",
        examples: ["Domantas Sabonis R+A o19.5", "Domantas Sabonis over 19.5 reb+ast"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "REBOUNDS_ASSISTS" },
      },
      {
        market: "Double-double",
        examples: ["Nikola Jokic double-double", "Nikola Jokic DD"],
        status: "coming-soon",
        check: { via: "nba-prop", market: "DOUBLE_DOUBLE" },
      },
    ],
  },
  {
    title: "Not yet",
    rows: [
      {
        // parseNbaProp recognizes these as NBA props with no market, so they are never read as a
        // moneyline or total and never graded as the nearest supported market.
        market: "Triple-double / first basket / quarter props",
        examples: ["Nikola Jokic triple-double", "Nikola Jokic first basket", "Nikola Jokic 1st quarter over 7.5 points"],
        status: "not-yet",
        check: { via: "nba-ungraded" },
      },
      {
        // parseTouchdownProp recognizes these, resolveTouchdownProp declines to grade them.
        market: "First TD / 2+ TDs",
        examples: ["Jahmyr Gibbs first TD", "Jahmyr Gibbs 2+ TDs"],
        status: "not-yet",
        check: { via: "nfl-td-ungraded" },
      },
      {
        market: "Other NFL stats",
        examples: [
          "Amon-Ra St. Brown over 24.5 longest reception",
          "Aidan Hutchinson over 0.5 sacks",
          "Jack Campbell over 7.5 tackles",
        ],
        status: "not-yet",
        check: { via: "nfl-unsupported-stat" },
      },
    ],
  },
];

// The shorthand the parsers read, shown as a chip row above the groups.
export const FORMAT_SHORTCUTS: string[] = [
  "ML",
  "o / u",
  "ATD",
  "Gm 1 · Gm 2",
  "Last name only",
  "NFL · MLB · NHL prefix",
];

// The four quick examples in the "Common formats" card beside the editor.
export const COMMON_FORMATS: { market: string; example: string }[] = [
  { market: "Moneyline", example: "Yankees ML" },
  { market: "Spread", example: "Chiefs -3.5" },
  { market: "Total", example: "Dodgers u 8.5" },
  { market: "Player prop", example: "Jahmyr Gibbs over 65.5 rush yds" },
];

export const FORMAT_FOOTER_TIP = "Add a league in front (NFL Giants +6.5) to skip the 'which Giants?' question.";
