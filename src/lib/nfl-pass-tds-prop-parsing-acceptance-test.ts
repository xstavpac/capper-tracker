// NFL passing-touchdowns prop (PropMarket PASS_TDS): parsing, anytime-TD non-collision, display label.
// Pure - no network, no database. Run with: npx tsx src/lib/nfl-pass-tds-prop-parsing-acceptance-test.ts
import { parsePlayerProp, parseTouchdownProp, parsePlayerPropLine, isAnytimeTdPick, normalizeNPlusPlayerProp } from "@/lib/bet-line";
import { parsePickText, parseCatalog, detectUnsupportedPropLine } from "@/lib/parse-catalog";
import { buildPickDisplayLabel } from "@/lib/pick-display-label";
import { betTypeFilterCategory } from "@/lib/bet-type-filter";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

// Each form: [text, expected player, expected direction, expected line]. "N+" is normalized the way the
// importer does (parsePickText rewrites it to "Over N-0.5") before the line is read.
const FORMS: [string, string, "OVER" | "UNDER", number][] = [
  ["Deshaun Watson over 0.5 passing touchdowns", "Deshaun Watson", "OVER", 0.5],
  ["Deshaun watson over 0.5 passing touchdowns", "Deshaun watson", "OVER", 0.5],
  ["DESHAUN WATSON OVER 0.5 PASSING TOUCHDOWNS", "DESHAUN WATSON", "OVER", 0.5],
  ["Watson o0.5 pass TD", "Watson", "OVER", 0.5],
  ["Watson over 1.5 passing TDs", "Watson", "OVER", 1.5],
  ["Watson u1.5 pass tds", "Watson", "UNDER", 1.5],
  ["Watson under 1.5 pass touchdowns", "Watson", "UNDER", 1.5],
  ["Watson 1+ passing TD", "Watson", "OVER", 0.5],
  ["Watson 2+ pass TDs", "Watson", "OVER", 1.5],
  ["Watson 3+ passing touchdowns", "Watson", "OVER", 2.5],
  ["Watson over 2 passing TDs", "Watson", "OVER", 2],
];
for (const [text, player, direction, line] of FORMS) {
  const normalized = normalizeNPlusPlayerProp(text);
  const prop = parsePlayerProp(normalized);
  check(`market+player: "${text}"`, prop, { playerName: player, propMarket: "PASS_TDS" });
  check(`line: "${text}"`, parsePlayerPropLine(normalized), { direction, line });
  // parsePickText is the importer's own path: stored description must carry the normalized over/under.
  const parsed = parsePickText(text);
  check(`stored description keeps PASS_TDS + line: "${text}"`, [parsePlayerProp(parsed.cleanDescription)?.propMarket, parsePlayerPropLine(parsed.cleanDescription)?.line], ["PASS_TDS", line]);
}

// ---- anytime / scorer TD: a different market, must not become PASS_TDS ----
for (const text of ["Watson anytime TD", "Deshaun Watson to score a TD", "Puka Nacua Anytime Touchdown", "Watson ATD", "Watson rushing TD", "Watson 2+ TDs"]) {
  check(`non-collision: "${text}" is not PASS_TDS`, parsePlayerProp(normalizeNPlusPlayerProp(text))?.propMarket, "TD");
}
check("anytime TD still priced as anytime TD", isAnytimeTdPick("Watson anytime TD"), true);
check("passing TD is never an anytime-TD pick (raw)", isAnytimeTdPick("Watson 1+ passing TD"), false);
check("passing TD is never an anytime-TD pick (spelled out)", isAnytimeTdPick("Watson over 0.5 passing touchdowns"), false);
check("parseTouchdownProp declines passing-TD text", parseTouchdownProp("Watson over 0.5 passing touchdowns"), null);
check("Over/Under TD (non-passing) stays unsupported", !!parseTouchdownProp("Kelce Over 1.5 TDs")?.unsupported, true);
// Passing YARDS and TDs stay distinct.
check("passing yards unaffected", parsePlayerProp("Josh Allen Over 275.5 Passing Yards")?.propMarket, "PASS_YDS");
check("passing + rushing yards unaffected", parsePlayerProp("Josh Allen Over 300.5 Passing and Rushing Yards")?.propMarket, "PASS_RUSH_YDS");
check("not flagged unsupported", detectUnsupportedPropLine("Deshaun watson over 0.5 passing touchdowns"), null);

// ---- catalog import: with a sport prefix it imports straight to PLAYER_PROP; without one it parks for roster recovery ----
{
  const withSport = parseCatalog("Capper\nNFL Deshaun Watson over 0.5 passing touchdowns", ["Capper"]);
  check("sport-prefixed line imports as PLAYER_PROP", [withSport.picks.length, withSport.picks[0]?.betType], [1, "PLAYER_PROP"]);
  const bare = parseCatalog("Capper\nDeshaun watson over 0.5 passing touchdowns", ["Capper"]);
  check("bare line is parked for roster recovery (not dropped)", [bare.picks.length, bare.unresolved], [0, ["Deshaun watson over 0.5 passing touchdowns"]]);
}

// ---- filter + display label ----
check(
  "filter category from betDetail (legacy null propMarket)",
  betTypeFilterCategory({ betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "Deshaun Watson over 0.5 passing touchdowns", propMarket: null }),
  "PASS_TDS"
);
function label(betDetail: string, playerName: string) {
  return buildPickDisplayLabel({
    betType: "PLAYER_PROP",
    matched: true,
    homeTeam: "Cleveland Browns",
    awayTeam: "Carolina Panthers",
    pickedSide: null,
    line: null,
    playerName,
    propMarket: "PASS_TDS",
    sportName: "NFL",
    betDetail,
  });
}
check("label", label("Deshaun Watson over 0.5 passing touchdowns", "Deshaun Watson"), "Deshaun Watson Over 0.5 Passing TDs");
check("label capitalizes a lowercase typed name", label("Deshaun watson over 0.5 passing touchdowns", "Deshaun watson"), "Deshaun Watson Over 0.5 Passing TDs");
check("label (under)", label("Watson u1.5 pass tds", "Watson"), "Watson Under 1.5 Passing TDs");
check("label from N+ form (stored normalized)", label(parsePickText("Deshaun Watson 2+ pass TDs").cleanDescription, "Deshaun Watson"), "Deshaun Watson Over 1.5 Passing TDs");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
