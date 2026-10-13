// Proof for the same-game rules (same-game-rules.ts) and the player-prop
// descriptor they read (describeProp in relationship-classifier.ts). Pure - no
// DB. Every pair is checked in BOTH orders. Run with:
//   npx tsx src/lib/parlay/same-game-rules-acceptance-test.ts
import { classifyPair, describePick, describeProp, samePropPlayer, type ParlayCandidate, type PropDescription } from "@/lib/parlay/relationship-classifier";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const TIME = new Date("2026-09-23T23:05:00.000Z");
const MLB = { homeTeam: "Chicago Cubs", awayTeam: "Tampa Bay Rays", gameTime: TIME, sportName: "MLB", gameId: "mlb-1" };
const NFL = { homeTeam: "Chicago Bears", awayTeam: "Green Bay Packers", gameTime: TIME, sportName: "NFL", gameId: "nfl-1" };
const NHL = { homeTeam: "Edmonton Oilers", awayTeam: "New York Rangers", gameTime: TIME, sportName: "NHL", gameId: "nhl-1" };

type Game = typeof MLB;
function c(game: Game, betType: string, betDetail: string, line: number | null = null, period = "FULL_GAME"): ParlayCandidate {
  return { pick: { betType, period, betDetail, line }, game };
}
const prop = (game: Game, betDetail: string) => c(game, "PLAYER_PROP", betDetail);

// The rule a pair is blocked by (null = allowed), in both orders.
function both(a: ParlayCandidate, b: ParlayCandidate): [string | null, string | null] {
  return [sameGameConflict(a, b)?.rule ?? null, sameGameConflict(b, a)?.rule ?? null];
}
const blocked = (label: string, a: ParlayCandidate, b: ParlayCandidate, rule: string) => check(`BLOCKED ${rule}: ${label} (both orders)`, both(a, b), [rule, rule]);
const allowed = (label: string, a: ParlayCandidate, b: ParlayCandidate) => check(`ALLOWED: ${label} (both orders)`, both(a, b), [null, null]);

// ---------------------------------------------------------------------------
// describeProp
// ---------------------------------------------------------------------------
const ok = (d: PropDescription) => (d.status === "OK" ? { market: d.market, direction: d.direction, line: d.line, offensive: d.offensive } : d.status);
check("prop: passing yards Over", ok(describeProp(prop(NFL, "Caleb Williams over 250 passing yards").pick)), { market: "PASS_YDS", direction: "OVER", line: 250, offensive: true });
check("prop: passing yards Under", ok(describeProp(prop(NFL, "Caleb Williams under 260 passing yards").pick)), { market: "PASS_YDS", direction: "UNDER", line: 260, offensive: true });
check("prop: o/u shorthand", ok(describeProp(prop(NFL, "D'Andre Swift o40.5 rushing yards").pick)), { market: "RUSH_YDS", direction: "OVER", line: 40.5, offensive: true });
check("prop: N+ is Over N-0.5", ok(describeProp(prop(NFL, "DJ Moore 5+ receptions").pick)), { market: "RECEPTIONS", direction: "OVER", line: 4.5, offensive: true });
check("prop: anytime TD is an offensive Over with no line", ok(describeProp(prop(NFL, "DJ Moore anytime TD").pick)), { market: "TD", direction: "OVER", line: null, offensive: true });
check("prop: NHL anytime goal is an offensive Over", ok(describeProp(prop(NHL, "Connor McDavid anytime goal").pick)), { market: "ANYTIME_GOAL", direction: "OVER", line: null, offensive: true });
check("prop: NHL first goal is an offensive Over", ok(describeProp(prop(NHL, "Connor McDavid first goal").pick)), { market: "FIRST_GOAL", direction: "OVER", line: null, offensive: true });
check("prop: goalie saves is not offensive", ok(describeProp(prop(NHL, "Igor Shesterkin over 27.5 saves").pick)), { market: "SAVES", direction: "OVER", line: 27.5, offensive: false });
check("prop: pitcher strikeouts is not offensive", ok(describeProp(prop(MLB, "Shane McClanahan over 6.5 strikeouts").pick)), { market: "STRIKEOUTS", direction: "OVER", line: 6.5, offensive: false });
check("prop: pitcher outs is not offensive", ok(describeProp(prop(MLB, "Shane McClanahan under 17.5 outs recorded").pick)), { market: "OUTS_RECORDED", direction: "UNDER", line: 17.5, offensive: false });
check("prop: hitter total bases is offensive", ok(describeProp(prop(MLB, "Seiya Suzuki over 1.5 total bases").pick)), { market: "TOTAL_BASES", direction: "OVER", line: 1.5, offensive: true });
check("prop: unreadable text is UNDERIVABLE", describeProp(prop(NFL, "Caleb Williams to have a big day").pick).status, "UNDERIVABLE");
check("prop: a line market with no Over/Under is UNDERIVABLE", describeProp(prop(NFL, "Caleb Williams passing yards").pick).status, "UNDERIVABLE");
check("prop: a non-prop is UNDERIVABLE", describeProp(c(MLB, "MONEYLINE", "Cubs ML").pick).status, "UNDERIVABLE");
{
  const full = describeProp(prop(NFL, "Caleb Williams over 250 passing yards").pick);
  const last = describeProp(prop(NFL, "Williams under 260 passing yards").pick);
  const other = describeProp(prop(NFL, "Jordan Love over 250 passing yards").pick);
  if (full.status === "OK" && last.status === "OK" && other.status === "OK") {
    check("prop: last name only is the same player, both orders", [samePropPlayer(full, last), samePropPlayer(last, full)], [true, true]);
    check("prop: a different player is not, both orders", [samePropPlayer(full, other), samePropPlayer(other, full)], [false, false]);
  } else check("prop: name fixtures parse", false, true);
}
// PLAYER_PROP is still INACTIVE to the classifier itself.
check("classifier: describePick still INACTIVE for a prop", describePick(prop(NFL, "Caleb Williams over 250 passing yards").pick, NFL).status, "INACTIVE");
check("classifier: classifyPair still INACTIVE for a prop pair", classifyPair(prop(NFL, "Caleb Williams over 250 passing yards"), c(NFL, "MONEYLINE", "Bears ML")).outcome, "INACTIVE");

// ---------------------------------------------------------------------------
// R-A: one side bet per game
// ---------------------------------------------------------------------------
const cubsMl = c(MLB, "MONEYLINE", "Cubs ML");
const raysMl = c(MLB, "MONEYLINE", "Rays ML");
blocked("Cubs ML + Rays ML", cubsMl, raysMl, "R-A");
blocked("Rays +1.5 + Cubs ML", c(MLB, "SPREAD", "Rays +1.5", 1.5), cubsMl, "R-A");
blocked("Cubs +1.5 + Rays ML", c(MLB, "SPREAD", "Cubs +1.5", 1.5), raysMl, "R-A");
blocked("Cubs ML + Cubs -1.5", cubsMl, c(MLB, "SPREAD", "Cubs -1.5", -1.5), "R-A");
blocked("Cubs ML twice (two cappers)", cubsMl, c(MLB, "MONEYLINE", "Cubs ML"), "R-A");
blocked("puck line + moneyline", c(NHL, "SPREAD", "Oilers -1.5", -1.5), c(NHL, "MONEYLINE", "Rangers ML"), "R-A");

// ---------------------------------------------------------------------------
// R-B: one game total per game
// ---------------------------------------------------------------------------
const over85 = c(MLB, "TOTAL", "Over 8.5", 8.5);
const under85 = c(MLB, "TOTAL", "Under 8.5", 8.5);
blocked("Over 8.5 + Under 8.5", over85, under85, "R-B");
blocked("Over 8.5 + Over 9.5", over85, c(MLB, "TOTAL", "Over 9.5", 9.5), "R-B");
blocked("Over 8.5 twice", over85, c(MLB, "TOTAL", "Over 8.5", 8.5), "R-B");

// ---------------------------------------------------------------------------
// R-C: A and B hold across periods
// ---------------------------------------------------------------------------
blocked("Cubs F5 ML + Rays ML", c(MLB, "MONEYLINE", "Cubs F5 ML", null, "FIRST_HALF"), raysMl, "R-A");
blocked("Cubs F5 ML + Cubs ML", c(MLB, "MONEYLINE", "Cubs F5 ML", null, "FIRST_HALF"), cubsMl, "R-A");
blocked("F5 Over + full-game Under", c(MLB, "TOTAL", "F5 Over 4.5", 4.5, "FIRST_HALF"), under85, "R-B");
blocked("F5 Over + full-game Over", c(MLB, "TOTAL", "F5 Over 4.5", 4.5, "FIRST_HALF"), over85, "R-B");

// ---------------------------------------------------------------------------
// R-D: one prop per player per stat, either direction
// ---------------------------------------------------------------------------
const cwOver = prop(NFL, "Caleb Williams over 250 passing yards");
blocked("Caleb Williams over 250 + under 260 pass yds", cwOver, prop(NFL, "Caleb Williams under 260 passing yards"), "R-D");
blocked("same player + stat, same direction (over 250 + over 260)", cwOver, prop(NFL, "Caleb Williams over 260 passing yards"), "R-D");
blocked("same player written two ways", cwOver, prop(NFL, "Williams u260 passing yards"), "R-D");
// A last name alone matches only while the teams don't say otherwise.
blocked("loose name, same team named on both", prop(NFL, "Bears Williams over 250 passing yards"), prop(NFL, "Bears Caleb Williams under 260 passing yards"), "R-D");
allowed("same last name, different teams named", prop(NFL, "Bears Caleb Williams over 250 passing yards"), prop(NFL, "Packers Williams over 200 passing yards"));
allowed("same full name, different teams named", prop(NFL, "Bears Caleb Williams over 250 passing yards"), prop(NFL, "Packers Caleb Williams under 260 passing yards"));
blocked("loose name, one team not named", prop(NFL, "Bears Caleb Williams over 250 passing yards"), prop(NFL, "Williams under 260 passing yards"), "R-D");
blocked("loose name, neither team named", prop(NFL, "Caleb Williams over 250 passing yards"), prop(NFL, "Williams under 260 passing yards"), "R-D");
allowed("same player, different stats", cwOver, prop(NFL, "Caleb Williams over 20.5 rushing yards"));
allowed("same stat, different players", cwOver, prop(NFL, "Jordan Love over 240 passing yards"));

// ---------------------------------------------------------------------------
// R-E: one story per game
// ---------------------------------------------------------------------------
const suzukiOver = prop(MLB, "Seiya Suzuki over 1.5 total bases");
const suzukiUnder = prop(MLB, "Seiya Suzuki under 1.5 total bases");
blocked("game Under + hitter Over", under85, suzukiOver, "R-E");
blocked("game Over + hitter Under", over85, suzukiUnder, "R-E");
blocked("F5 Under + hitter Over (a game total in any period)", c(MLB, "TOTAL", "F5 Under 4.5", 4.5, "FIRST_HALF"), suzukiOver, "R-E");
blocked("game Under + anytime TD", c(NFL, "TOTAL", "Under 44.5", 44.5), prop(NFL, "DJ Moore anytime TD"), "R-E");
blocked("game Under + anytime goal", c(NHL, "TOTAL", "Under 6.5", 6.5), prop(NHL, "Connor McDavid anytime goal"), "R-E");
allowed("game Under + hitter Under", under85, suzukiUnder);
allowed("game Over + hitter Over", over85, suzukiOver);
allowed("game Under + pitcher strikeouts Over (not offensive)", under85, prop(MLB, "Shane McClanahan over 6.5 strikeouts"));
allowed("game Over + pitcher strikeouts Over (not offensive)", over85, prop(MLB, "Shane McClanahan over 6.5 strikeouts"));
allowed("game Under + goalie saves Over (not offensive)", c(NHL, "TOTAL", "Under 6.5", 6.5), prop(NHL, "Igor Shesterkin over 27.5 saves"));
allowed("team total Under + hitter Over (R-E is game totals only)", c(MLB, "TEAM_TOTAL", "Cubs team total under 4.5", 4.5), suzukiOver);

// ---------------------------------------------------------------------------
// Team totals and NRFI are not game totals
// ---------------------------------------------------------------------------
const cubsTtOver = c(MLB, "TEAM_TOTAL", "Cubs team total over 4.5", 4.5);
allowed("game Over + team total Over (R5)", over85, cubsTtOver);
blocked("game Under + team total Over (R6)", under85, cubsTtOver, "OPPOSING");
blocked("Cubs TT Over 4.5 + Cubs TT Under 4.5 (R3)", cubsTtOver, c(MLB, "TEAM_TOTAL", "Cubs team total under 4.5", 4.5), "OPPOSING");
blocked("Cubs TT Over 4.5 twice", cubsTtOver, c(MLB, "TEAM_TOTAL", "Cubs team total over 4.5", 4.5), "DUPLICATE");
allowed("Cubs TT Over + Rays TT Over (different teams)", cubsTtOver, c(MLB, "TEAM_TOTAL", "Rays team total over 3.5", 3.5));
blocked("NRFI + YRFI", c(MLB, "NRFI", "NRFI"), c(MLB, "NRFI", "YRFI"), "OPPOSING");
blocked("NRFI + game Over (R6)", c(MLB, "NRFI", "NRFI"), over85, "OPPOSING");
allowed("NRFI + game Under (R5)", c(MLB, "NRFI", "NRFI"), under85);

// ---------------------------------------------------------------------------
// Unverifiable picks are never paired
// ---------------------------------------------------------------------------
blocked("a side with no readable team", c(MLB, "MONEYLINE", "Home team to win"), over85, "UNVERIFIED");
blocked("a total with no Over/Under", c(MLB, "TOTAL", "8.5", 8.5), cubsMl, "UNVERIFIED");
blocked("an unreadable prop + a side", prop(NFL, "Caleb Williams to have a big day"), c(NFL, "MONEYLINE", "Bears ML"), "UNVERIFIED");
blocked("an unreadable prop + a readable prop", prop(NFL, "Caleb Williams to have a big day"), cwOver, "UNVERIFIED");
blocked("a readable prop + a side with no readable team", cwOver, c(NFL, "MONEYLINE", "Home team to win"), "UNVERIFIED");
blocked("a team total whose team didn't resolve + another team total", c(MLB, "TEAM_TOTAL", "Team total over 4.5", 4.5), cubsTtOver, "UNVERIFIED");

// ---------------------------------------------------------------------------
// The examples that must pass
// ---------------------------------------------------------------------------
allowed("Bears ML + Caleb Williams over 250 passing yards", c(NFL, "MONEYLINE", "Bears ML"), cwOver);
allowed("Over 47.5 + a player's over 40 rushing yards", c(NFL, "TOTAL", "Over 47.5", 47.5), prop(NFL, "D'Andre Swift over 40 rushing yards"));
allowed("props on opposite teams (Cubs hitter Over + Rays hitter Over)", suzukiOver, prop(MLB, "Yandy Diaz over 0.5 hits"));
allowed("side + game total", cubsMl, over85);
allowed("side + prop Under", cubsMl, suzukiUnder);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll same-game rule checks passed");
