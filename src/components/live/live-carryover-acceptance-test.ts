// A game that crosses midnight ET must stay on the Live board through
// overtime / extra periods until its score says Final - run with:
//   npx tsx src/components/live/live-carryover-acceptance-test.ts
//
// The incident (2026-10-09): San Jose State vs Wyoming kicked off 9:00 PM ET,
// went to overtime after midnight, and was already gone from /live. The board
// never had a score for it - ESPN spells the home team "San José State
// Spartans", The Odds API "San Jose State Spartans", and the client matcher
// compared with === - and a carried-over game with no "live" score was dropped
// at midnight.
//
// Covers, through the same two functions the board calls (the client
// matchScoreToGame, then orderBoardGames):
//   1. per league, regulation -> end of regulation -> OT -> more OT -> a long
//      delay -> Final, all after midnight: visible at every step until Final
//   2. the same walk with the score feed's spelling on the score and the Odds
//      API's on the game, for every cross-source spelling pair we know of
//   3. the unmatched carry-over bound (UNMATCHED_CARRYOVER_VISIBLE_HOURS)
//
// Exits non-zero if any assertion fails.
import {
  orderBoardGames,
  matchScoreToGame,
  teamScore,
  UNMATCHED_CARRYOVER_VISIBLE_HOURS,
} from "./live-scoreboard-ordering";
import { CROSS_SOURCE_TEAM_ALIASES } from "@/lib/team-name-match";
import { easternDateKey } from "@/lib/dates";
import type { ScoreGame } from "@/server/data/odds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// October ET is EDT (UTC-4). Kickoff 9:00 PM ET on the 9th, as in the incident.
const KICKOFF = "2026-10-09T21:00:00-04:00";
const at = (hhmm: string, day = "10") => new Date(`2026-10-${day}T${hhmm}:00-04:00`);

type Step = {
  label: string;
  now: Date;
  status: ScoreGame["status"];
  period?: number | null;
  clock?: string | null;
  inningHalf?: string | null;
  inningOrdinal?: string | null;
  visible: boolean;
};

// Regulation is `periods` long; OT is periods+1, a second extra period periods+2.
function quarterWalk(periods: number, extraLabels: [string, string]): Step[] {
  return [
    { label: "regulation, 11:30 PM (still its own day)", now: at("23:30", "09"), status: "live", period: periods, clock: "9:12", visible: true },
    { label: "regulation, 12:05 AM (now a carry-over)", now: at("00:05"), status: "live", period: periods, clock: "1:48", visible: true },
    { label: "end of regulation, tied, clock 0:00", now: at("00:20"), status: "live", period: periods, clock: "0:00", visible: true },
    { label: extraLabels[0], now: at("00:40"), status: "live", period: periods + 1, clock: "4:12", visible: true },
    { label: extraLabels[1], now: at("01:10"), status: "live", period: periods + 2, clock: "0:00", visible: true },
    { label: "still live 9h after kickoff (long delay)", now: at("06:00"), status: "live", period: periods + 2, clock: "0:00", visible: true },
    { label: "Final", now: at("06:10"), status: "final", period: null, clock: null, visible: false },
  ];
}

const MLB_WALK: Step[] = [
  { label: "bottom 8th, 11:30 PM (still its own day)", now: at("23:30", "09"), status: "live", inningHalf: "Bottom", inningOrdinal: "8th", visible: true },
  { label: "top 9th, 12:05 AM (now a carry-over)", now: at("00:05"), status: "live", inningHalf: "Top", inningOrdinal: "9th", visible: true },
  { label: "end of the 9th, tied", now: at("00:20"), status: "live", inningHalf: "End", inningOrdinal: "9th", visible: true },
  { label: "top 10th (extra innings)", now: at("00:40"), status: "live", inningHalf: "Top", inningOrdinal: "10th", visible: true },
  { label: "bottom 13th", now: at("01:40"), status: "live", inningHalf: "Bottom", inningOrdinal: "13th", visible: true },
  { label: "still live 9h after first pitch (long delay)", now: at("06:00"), status: "live", inningHalf: "Middle", inningOrdinal: "14th", visible: true },
  { label: "Final", now: at("06:10"), status: "final", visible: false },
];

const LEAGUE_WALKS: { sportKey: string; league: string; home: string; away: string; steps: Step[] }[] = [
  { sportKey: "americanfootball_ncaaf", league: "NCAAF", home: "Fresno State Bulldogs", away: "Wyoming Cowboys", steps: quarterWalk(4, ["OT (period 5)", "2OT (period 6)"]) },
  { sportKey: "americanfootball_nfl", league: "NFL", home: "Seattle Seahawks", away: "Arizona Cardinals", steps: quarterWalk(4, ["OT (period 5)", "end of OT (period 6)"]) },
  { sportKey: "basketball_nba", league: "NBA", home: "Golden State Warriors", away: "Denver Nuggets", steps: quarterWalk(4, ["OT (period 5)", "2OT (period 6)"]) },
  { sportKey: "basketball_wnba", league: "WNBA", home: "Las Vegas Aces", away: "Seattle Storm", steps: quarterWalk(4, ["OT (period 5)", "2OT (period 6)"]) },
  { sportKey: "icehockey_nhl", league: "NHL", home: "Vegas Golden Knights", away: "Edmonton Oilers", steps: quarterWalk(3, ["OT (period 4)", "shootout (period 5)"]) },
  { sportKey: "baseball_mlb", league: "MLB", home: "San Diego Padres", away: "San Francisco Giants", steps: MLB_WALK },
];

// One game on the board, one score in the feed, at one moment: is the card visible?
function walk(
  sportKey: string,
  oddsNames: { home: string; away: string },
  feedNames: { home: string; away: string },
  steps: Step[]
): { visible: boolean[]; scoresShown: boolean[] } {
  const game = { id: "odds-1", homeTeam: oddsNames.home, awayTeam: oddsNames.away, commenceTime: KICKOFF };
  const visible: boolean[] = [];
  const scoresShown: boolean[] = [];
  for (const step of steps) {
    const feed: ScoreGame[] = [
      {
        id: "feed-1",
        homeTeam: feedNames.home,
        awayTeam: feedNames.away,
        status: step.status,
        scores: [
          { name: feedNames.home, score: "13" },
          { name: feedNames.away, score: "16" },
        ],
        commenceTime: KICKOFF,
        inningHalf: step.inningHalf ?? null,
        inningOrdinal: step.inningOrdinal ?? null,
        innings: null,
        period: step.period ?? null,
        clock: step.clock ?? null,
      },
    ];
    const score = matchScoreToGame(feed, game, sportKey);
    const board = orderBoardGames([{ game, score }], easternDateKey(step.now), step.now);
    visible.push(board.length === 1);
    scoresShown.push(teamScore(score, game.homeTeam, sportKey) === "13" && teamScore(score, game.awayTeam, sportKey) === "16");
  }
  return { visible, scoresShown };
}

console.log("\n########## 1. per league: regulation -> OT -> Final across midnight ET ##########");

for (const { sportKey, league, home, away, steps } of LEAGUE_WALKS) {
  const names = { home, away };
  const { visible } = walk(sportKey, names, names, steps);
  steps.forEach((step, i) => {
    expect(`${league}: ${step.label} -> ${step.visible ? "on the board" : "off the board"}`, visible[i], step.visible);
  });
}

console.log("\n########## 2. same walk, score feed and odds feed spell the team differently ##########");

// [sportKey, score-feed spelling, Odds API spelling, opponent (same in both feeds)]
const SPELLING_PAIRS: [string, string, string, string][] = [
  // Reconciled by normalizeTeamName's folding (accent, period).
  ["americanfootball_ncaaf", "San José State Spartans", "San Jose State Spartans", "Wyoming Cowboys"],
  ["icehockey_nhl", "Montreal Canadiens", "Montréal Canadiens", "Ottawa Senators"],
  ["icehockey_nhl", "St. Louis Blues", "St Louis Blues", "Dallas Stars"],
  // Reconciled by the league's alias rows - every row, so a new one is covered the day it is added.
  ...Object.entries(CROSS_SOURCE_TEAM_ALIASES).flatMap(([sportKey, rows]) =>
    rows.map(([scoreFeed, oddsApi]): [string, string, string, string] => [
      sportKey,
      scoreFeed,
      oddsApi,
      sportKey === "basketball_nba" ? "Denver Nuggets" : "Wyoming Cowboys",
    ])
  ),
];

for (const [sportKey, scoreFeed, oddsApi, opponent] of SPELLING_PAIRS) {
  const steps = sportKey === "icehockey_nhl" ? quarterWalk(3, ["OT", "shootout"]) : quarterWalk(4, ["OT", "2OT"]);
  const want = steps.map((s) => s.visible);
  const wantScores = steps.map(() => true);

  // The team at home, then the team on the road - the match needs both sides.
  const home = walk(sportKey, { home: oddsApi, away: opponent }, { home: scoreFeed, away: opponent }, steps);
  expect(`"${scoreFeed}" (feed) / "${oddsApi}" (odds), home: visible until Final`, home.visible, want);
  expect(`"${scoreFeed}" / "${oddsApi}", home: both teams' scores resolve at every step`, home.scoresShown, wantScores);

  const away = walk(sportKey, { home: opponent, away: oddsApi }, { home: opponent, away: scoreFeed }, steps);
  expect(`"${scoreFeed}" / "${oddsApi}", away: visible until Final`, away.visible, want);
}

{
  // The incident, exactly: with no sportKey at all the accent fold alone must
  // already carry San José State (it is not an alias row).
  const game = { id: "sjsu", homeTeam: "San Jose State Spartans", awayTeam: "Wyoming Cowboys", commenceTime: "2026-10-10T01:00:00Z" };
  const feed = [
    { id: "401864519", homeTeam: "San José State Spartans", awayTeam: "Wyoming Cowboys", status: "live", scores: null, commenceTime: "2026-10-10T01:00Z", inningHalf: null, inningOrdinal: null, innings: null, period: 5, clock: "0:00" },
  ] as ScoreGame[];
  const now = new Date("2026-10-10T04:40:00Z"); // 12:40 AM ET, in overtime
  const score = matchScoreToGame(feed, game);
  expect("incident: the client matcher finds ESPN's 'San José State' score for the odds game", score?.id, "401864519");
  expect("incident: SJSU-Wyoming is on the board at 12:40 AM ET, in OT", orderBoardGames([{ game, score }], easternDateKey(now), now).length, 1);
}

console.log("\n########## 3. carry-over with no live score: visible until 8h after kickoff ##########");

{
  expect("the bound is 8 hours", UNMATCHED_CARRYOVER_VISIBLE_HOURS, 8);

  const game = { id: "odds-1", homeTeam: "Nowhere State Owls", awayTeam: "Wyoming Cowboys", commenceTime: KICKOFF };
  const visibleAt = (now: Date, score?: Pick<ScoreGame, "status">) =>
    orderBoardGames([{ game, score }], easternDateKey(now), now).length === 1;

  // No score matched at all (a spelling we have no rule for, or the feed is down).
  expect("unmatched: 11:59 PM, still its own day -> on the board", visibleAt(at("23:59", "09")), true);
  expect("unmatched: 12:01 AM, 3h after kickoff -> still on the board (was dropped here before)", visibleAt(at("00:01")), true);
  expect("unmatched: 4:59 AM, 7h59m after kickoff -> on the board", visibleAt(at("04:59")), true);
  expect("unmatched: 5:00 AM, exactly 8h after kickoff -> off the board", visibleAt(at("05:00")), false);
  expect("unmatched: noon the next day -> off the board", visibleAt(at("12:00")), false);

  // A matched score that never left "preview" (delayed start, or postponed and
  // still listed as scheduled) has nothing "live" to hold it either.
  expect("matched but still preview: 12:01 AM -> on the board", visibleAt(at("00:01"), { status: "preview" }), true);
  expect("matched but still preview: 5:00 AM -> off the board", visibleAt(at("05:00"), { status: "preview" }), false);

  // Final always wins, inside the window or not.
  expect("matched and Final at 12:01 AM -> off the board", visibleAt(at("00:01"), { status: "final" }), false);
}

{
  // The aliases are per league: an NCAAF row must not join names under another sport's key.
  const game = { id: "g", homeTeam: "Appalachian State Mountaineers", awayTeam: "Wyoming Cowboys", commenceTime: KICKOFF };
  const feed = [
    { id: "f", homeTeam: "App State Mountaineers", awayTeam: "Wyoming Cowboys", status: "live", scores: null, commenceTime: KICKOFF, inningHalf: null, inningOrdinal: null, innings: null },
  ] as ScoreGame[];
  expect("App State alias applies under the NCAAF key", matchScoreToGame(feed, game, "americanfootball_ncaaf")?.id, "f");
  expect("...not under the NBA key", matchScoreToGame(feed, game, "basketball_nba"), undefined);
  expect("...and not with no key", matchScoreToGame(feed, game), undefined);
}

{
  // Louisiana is three different schools. A Louisiana Tech odds game must not
  // pick up the Ragin' Cajuns' score just because both start with "Louisiana".
  const feed = [
    { id: "ul", homeTeam: "Louisiana Ragin' Cajuns", awayTeam: "Troy Trojans", status: "live", scores: null, commenceTime: KICKOFF, inningHalf: null, inningOrdinal: null, innings: null },
  ] as ScoreGame[];
  const techGame = { homeTeam: "Louisiana Tech Bulldogs", awayTeam: "Troy Trojans", commenceTime: KICKOFF };
  const monroeGame = { homeTeam: "UL Monroe Warhawks", awayTeam: "Troy Trojans", commenceTime: KICKOFF };
  const cajunsGame = { homeTeam: "Louisiana Ragin Cajuns", awayTeam: "Troy Trojans", commenceTime: KICKOFF };
  expect("Louisiana Tech's game does not match Louisiana's score", matchScoreToGame(feed, techGame, "americanfootball_ncaaf"), undefined);
  expect("UL Monroe's game does not match Louisiana's score", matchScoreToGame(feed, monroeGame, "americanfootball_ncaaf"), undefined);
  expect("Louisiana's own game does", matchScoreToGame(feed, cajunsGame, "americanfootball_ncaaf")?.id, "ul");
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
