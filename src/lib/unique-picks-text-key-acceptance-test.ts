// uniquePickKey's text fallback (unique-picks.ts textSide / teamSide, rules R0-R5): picks with no stored side.
// Both directions: wording variants of ONE bet must share a key; different bets must not. Cases are the real prod
// variants from the 2026-11-17 scoping pass. Also pins that keys built from structured fields did not move, which
// is what lets the follow-up backfill touch only TEXT-keyed rows (scripts/backfill-unique-key.ts --text-only).
// Pure (no database). Run with:
//   npx tsx src/lib/unique-picks-text-key-acceptance-test.ts
import { uniquePickKey, type UniquePickInput } from "@/lib/unique-picks";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const T = new Date("2026-08-15T23:10:00.000Z");
type Game = { homeTeam: string; awayTeam: string };
const pick = (g: Game, betType: string, betDetail: string, o: Partial<UniquePickInput> = {}): UniquePickInput => ({
  id: betDetail,
  status: "WIN",
  gameTime: T,
  gameNumber: null,
  period: "FULL_GAME",
  pickedSide: null,
  category: null,
  line: null,
  propMarket: null,
  playerName: null,
  ...g,
  betType,
  betDetail,
  ...o,
});
const key = uniquePickKey;
const same = (label: string, a: UniquePickInput, b: UniquePickInput) => check(`MERGE: ${label}`, key(a) === key(b), `\n    ${key(a)}\n    ${key(b)}`);
const differ = (label: string, a: UniquePickInput, b: UniquePickInput) => check(`APART: ${label}`, key(a) !== key(b), key(a));
const isText = (label: string, p: UniquePickInput, subject?: string) => {
  const k = key(p);
  const tail = k.split("||TEXT:")[1]?.split("||")[0];
  check(`TEXT: ${label}`, tail !== undefined && (subject === undefined || tail === subject), k);
};
const side = (label: string, p: UniquePickInput, s: "HOME" | "AWAY") => check(`SIDE ${s}: ${label}`, key(p).includes("||" + p.betType + "||" + s), key(p));

// ---- must merge ----
const MIA = { homeTeam: "Cincinnati Reds", awayTeam: "Miami Marlins" };
same('"Marlins ML" / "Miami Marlins Moneyline"', pick(MIA, "MONEYLINE", "Marlins ML"), pick(MIA, "MONEYLINE", "Miami Marlins Moneyline"));
same("...and both join the structured AWAY moneyline", pick(MIA, "MONEYLINE", "Marlins ML"), pick(MIA, "MONEYLINE", "Marlins -125", { pickedSide: "AWAY" }));

const LV = { homeTeam: "Las Vegas Raiders", awayTeam: "Arizona Cardinals" };
same('"Raiders Moneyline" / "Las Vegas Raiders Moneyline"', pick(LV, "MONEYLINE", "Raiders Moneyline"), pick(LV, "MONEYLINE", "Las Vegas Raiders Moneyline"));
side("Raiders Moneyline", pick(LV, "MONEYLINE", "Raiders Moneyline"), "HOME");

const LAD = { homeTeam: "Los Angeles Dodgers", awayTeam: "Kansas City Royals" };
same('"Dodgers -1.5" / "Los Angeles Dodgers -1.5"', pick(LAD, "SPREAD", "Dodgers -1.5", { line: -1.5 }), pick(LAD, "SPREAD", "Los Angeles Dodgers -1.5", { line: -1.5 }));
same("...and both join the structured HOME -1.5 spread", pick(LAD, "SPREAD", "Dodgers -1.5", { line: -1.5 }), pick(LAD, "SPREAD", "LAD -1.5", { line: -1.5, pickedSide: "HOME" }));
differ("a different line is a different bet", pick(LAD, "SPREAD", "Dodgers -1.5", { line: -1.5 }), pick(LAD, "SPREAD", "Dodgers -2.5", { line: -2.5 }));

const PIT = { homeTeam: "Pittsburgh Pirates", awayTeam: "Boston Red Sox" };
same('"Pirates" / "Pirates Moneyline"', pick(PIT, "MONEYLINE", "Pirates"), pick(PIT, "MONEYLINE", "Pirates Moneyline"));
same('"Pirates Money Line" (R5: two words)', pick(PIT, "MONEYLINE", "Pirates"), pick(PIT, "MONEYLINE", "Pirates Money Line"));
same('"Red Sox ML -110" (nickname at the end, odds stripped)', pick(PIT, "MONEYLINE", "Red Sox ML -110"), pick(PIT, "MONEYLINE", "Boston Red Sox Moneyline"));

const USC = { homeTeam: "USC Trojans", awayTeam: "San José State Spartans" };
same(
  '"USC Team Total over 49.5" joins the structured USC HOME OVER 49.5 group (R2: stored pickedSide)',
  pick(USC, "TEAM_TOTAL", "USC Team Total over 49.5", { line: 49.5, pickedSide: "HOME" }),
  pick(USC, "TEAM_TOTAL", "USC Trojans TT o49.5", { line: 49.5, pickedSide: "HOME" })
);
check("...keyed HOME OVER 49.5", key(pick(USC, "TEAM_TOTAL", "USC Team Total over 49.5", { line: 49.5, pickedSide: "HOME" })).endsWith("||TEAM_TOTAL||HOME||OVER||49.5"));
const TOL = { homeTeam: "Toledo Rockets", awayTeam: "Massachusetts Minutemen" };
check('R2: "UMass TT over 9.5 1H" with pickedSide AWAY -> AWAY (was TEXT:umass h)', key(pick(TOL, "TEAM_TOTAL", "UMass TT over 9.5 1H", { period: "FIRST_HALF", line: 9.5, pickedSide: "AWAY" })).endsWith("||TEAM_TOTAL||AWAY||OVER||9.5"));
const SF = { homeTeam: "San Francisco 49ers", awayTeam: "Washington Commanders" };
check('R1: "49ers team total over 29.5" with no stored side -> HOME (was TEXT:ers)', key(pick(SF, "TEAM_TOTAL", "49ers team total over 29.5", { line: 29.5 })).endsWith("||TEAM_TOTAL||HOME||OVER||29.5"));

const MIL = { homeTeam: "Milwaukee Brewers", awayTeam: "Minnesota Twins" };
const F5 = { period: "FIRST_HALF" };
const f5Variants = ["Brewers first five Moneyline", "Brewers 1st Five Innings Moneyline", "Brewers First 5 Innings Moneyline", "Brewers 1st 5 Moneyline", "Brewers F5 ML", "Brewers First Five"];
for (const v of f5Variants.slice(1)) same(`F5 stored FIRST_HALF: "${f5Variants[0]}" / "${v}"`, pick(MIL, "MONEYLINE", f5Variants[0], F5), pick(MIL, "MONEYLINE", v, F5));
side("Brewers first five Moneyline", pick(MIL, "MONEYLINE", "Brewers first five Moneyline", F5), "HOME");
const NYM = { homeTeam: "Cleveland Guardians", awayTeam: "New York Mets" };
check('R1: "Mets F5 ML" no longer collapses to "mets f"', !key(pick(NYM, "MONEYLINE", "Mets F5 ML", F5)).includes("TEXT:mets f"), key(pick(NYM, "MONEYLINE", "Mets F5 ML", F5)));
side('"Mets F5 ML" stored FIRST_HALF', pick(NYM, "MONEYLINE", "Mets F5 ML", F5), "AWAY");
same('"Brewers first 5 -0.5" / "Brewers 1st 5 -0.5" (spread F5)', pick(MIL, "SPREAD", "Brewers first 5 -0.5", { ...F5, line: -0.5 }), pick(MIL, "SPREAD", "Brewers 1st 5 -0.5", { ...F5, line: -0.5 }));

// R0
const HAW = { homeTeam: "Hawai'i Rainbow Warriors", awayTeam: "North Dakota State Bison" };
side('R0: "Hawaii +7" vs team "Hawai\'i ..." (apostrophe dropped on both sides)', pick(HAW, "SPREAD", "Hawaii +7", { line: 7 }), "HOME");
const FAMU = { homeTeam: "Alabama State Hornets", awayTeam: "Florida A&M Rattlers" };
same('R0: "Florida A&M ML" / "Florida A and M ML"', pick(FAMU, "MONEYLINE", "Florida A&M ML"), pick(FAMU, "MONEYLINE", "Florida A and M ML"));
side('R0: "Florida A&M ML"', pick(FAMU, "MONEYLINE", "Florida A&M ML"), "AWAY");
const TXST = { homeTeam: "Texas State Bobcats", awayTeam: "Colorado State Rams" };
side('R3: school at the start ("Texas State -3")', pick(TXST, "SPREAD", "Texas State -3", { line: -3 }), "HOME");

// ---- must stay apart / stay TEXT ----
const ATL = { homeTeam: "Atlanta Falcons", awayTeam: "New Orleans Saints" };
isText('R4 conflict: "Falcons 1st Quarter Moneyline" stored FULL_GAME', pick(ATL, "MONEYLINE", "Falcons 1st Quarter Moneyline"), "falcons 1st quarter");
differ('...not merged with "Falcons Moneyline"', pick(ATL, "MONEYLINE", "Falcons 1st Quarter Moneyline"), pick(ATL, "MONEYLINE", "Falcons Moneyline"));
const NYJ = { homeTeam: "New York Jets", awayTeam: "Miami Dolphins" };
isText('R4 conflict: "Jets 1st Quarter -0.5" stored FULL_GAME', pick(NYJ, "SPREAD", "Jets 1st Quarter -0.5", { line: -0.5 }), "jets 1st quarter");
differ('...not merged with "Jets -0.5"', pick(NYJ, "SPREAD", "Jets 1st Quarter -0.5", { line: -0.5 }), pick(NYJ, "SPREAD", "Jets -0.5", { line: -0.5 }));
const PHI = { homeTeam: "Philadelphia Phillies", awayTeam: "Atlanta Braves" };
isText('R4: "Braves Phillies Nolan First Inning" (FIRST_INNING is never a stored period)', pick(PHI, "MONEYLINE", "Braves Phillies Nolan First Inning"));
side("R4 agree: 3rd period stored THIRD_PERIOD is stripped (here: one team left)", pick({ homeTeam: "Pittsburgh Penguins", awayTeam: "Philadelphia Flyers" }, "MONEYLINE", "Flyers 3rd period moneyline", { period: "THIRD_PERIOD" }), "AWAY");
isText("R4 agree but both teams named stays TEXT", pick({ homeTeam: "Pittsburgh Penguins", awayTeam: "Philadelphia Flyers" }, "MONEYLINE", "Penguins/Flyers 3rd period moneyline", { period: "THIRD_PERIOD" }), "penguins flyers");

const NYM2 = { homeTeam: "New York Mets", awayTeam: "Philadelphia Phillies" };
isText('"Mets minus one" (a run line written in words, stored as ML)', pick(NYM2, "MONEYLINE", "Mets minus one"), "mets minus one");
differ('...not merged with "Mets ML"', pick(NYM2, "MONEYLINE", "Mets minus one"), pick(NYM2, "MONEYLINE", "Mets ML"));

isText('both teams named: "Reds vs. Marlins"', pick(MIA, "MONEYLINE", "Reds vs. Marlins"));
isText('both teams named: "Dodgers Braves"', pick({ homeTeam: "Los Angeles Dodgers", awayTeam: "Atlanta Braves" }, "MONEYLINE", "Dodgers Braves"));
isText('both teams named: "Orioles Yankees 9"', pick({ homeTeam: "Baltimore Orioles", awayTeam: "New York Yankees" }, "MONEYLINE", "Orioles Yankees 9"));

const TIGERS = { homeTeam: "LSU Tigers", awayTeam: "Clemson Tigers" };
isText('same mascot both sides: "Tigers ML"', pick(TIGERS, "MONEYLINE", "Tigers ML"), "tigers");
side('...the school still resolves: "Clemson ML"', pick(TIGERS, "MONEYLINE", "Clemson ML"), "AWAY");
const NY = { homeTeam: "New York Yankees", awayTeam: "New York Mets" };
isText('shared city both sides: "New York ML"', pick(NY, "MONEYLINE", "New York ML"), "new york");

isText('"Pirates 20 Line" (bare "line" is not a market word)', pick(PIT, "MONEYLINE", "Pirates 20 Line"), "pirates line");
differ('..."Pirates 20 Line" not merged with "Pirates Moneyline"', pick(PIT, "MONEYLINE", "Pirates 20 Line"), pick(PIT, "MONEYLINE", "Pirates Moneyline"));
isText("no shared-word matching: a word inside a team name is not a team", pick(MIA, "MONEYLINE", "Cincinnati Marlins"));

// ---- keys from structured fields are unchanged (stored prod values, 2026-11-17) ----
const PROD: [string, UniquePickInput, string][] = [
  ["ML pickedSide AWAY", pick({ homeTeam: "Los Angeles Dodgers", awayTeam: "Kansas City Royals" }, "MONEYLINE", "Royals Moneyline", { gameTime: new Date(1786414200000), pickedSide: "AWAY", category: "DOG_ML" }), "Los Angeles Dodgers|Kansas City Royals|1786414200000|||FULL_GAME||MONEYLINE||AWAY"],
  ["SPREAD pickedSide", pick({ homeTeam: "Tennessee Titans", awayTeam: "Jacksonville Jaguars" }, "SPREAD", "Jacksonville Jaguars -10.5", { gameTime: new Date(1794765600000), pickedSide: "AWAY", category: "SPREAD_MINUS", line: -10.5 }), "Tennessee Titans|Jacksonville Jaguars|1794765600000|||FULL_GAME||SPREAD||AWAY||-10.5"],
  ["TOTAL", pick({ homeTeam: "Dallas Stars", awayTeam: "New Jersey Devils" }, "TOTAL", "Stars over 5.5", { gameTime: new Date(1793145600000), category: "OVER", line: 5.5 }), "Dallas Stars|New Jersey Devils|1793145600000|||FULL_GAME||TOTAL||OVER||5.5"],
  ["TEAM_TOTAL resolved by text, pickedSide agrees", pick({ homeTeam: "Washington Nationals", awayTeam: "Atlanta Braves" }, "TEAM_TOTAL", "Nationals Team Total Under 4.5", { gameTime: new Date(1788368700000), pickedSide: "HOME", category: "TEAM_TOTAL", line: 4.5 }), "Washington Nationals|Atlanta Braves|1788368700000|||FULL_GAME||TEAM_TOTAL||HOME||UNDER||4.5"],
  ["PLAYER_PROP line from text", pick({ homeTeam: "New York Giants", awayTeam: "Washington Commanders" }, "PLAYER_PROP", "Jayden Daniels over 36.5 rushing yards", { gameTime: new Date(1794532500000), category: "RUSH_YDS_PROP", propMarket: "RUSH_YDS", playerName: "Jayden Daniels" }), "New York Giants|Washington Commanders|1794532500000|||FULL_GAME||PLAYER_PROP||jayden daniels||RUSH_YDS||OVER||36.5"],
  ["NRFI", pick({ homeTeam: "New York Yankees", awayTeam: "Colorado Rockies" }, "NRFI", "Rockies vs Yankees YRFI", { gameTime: new Date(1788995100000), category: "YRFI" }), "New York Yankees|Colorado Rockies|1788995100000|||FULL_GAME||NRFI||YRFI"],
];
for (const [label, p, stored] of PROD) check(`unchanged structured key: ${label}`, key(p) === stored, `\n    stored:   ${stored}\n    computed: ${key(p)}`);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
