// TD_COUNT: NFL touchdown-count props ("2+ TDs", "3+ TDs", "Over/Under x TDs") - parsing, grading, and the
// guarantee that a count pick is never recorded with anytime-TD. Saved real ESPN box scores
// (src/server/data/__fixtures__), no network, roster injected, no DB. Ground truth (rushing TD + receiving TD):
//   401872660 HOU @ BUF   Josh Allen (BUF) 2+0 = 2 | David Montgomery (HOU) 2+1 = 3 | DJ Moore (BUF) 0+1 = 1
//   401872954 NYJ @ DET   Jahmyr Gibbs (DET) 2+1 = 3 | Garrett Wilson (NYJ) 0+1 = 1
//                         Tyrod Taylor (NYJ): rostered, on a team in the game, no row anywhere (did not play)
//   401872952 KC @ MIA    Kenneth Walker III (KC) 1+1 = 2 (one of each)
//
// Run with: npx tsx src/server/data/nfl-td-count-prop-grading-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import { resolvePlayerProp, type NflPropDeps } from "@/server/data/grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { parsePlayerProp, parseTouchdownProp, isAnytimeTdPick } from "@/lib/bet-line";
import { propMarketKey, propMarketOf, PROP_MARKET_KEYS } from "@/lib/prop-market-key";
import { buildPlatformRatesRecompute } from "@/server/data/platform-category-rates";
import { pickCategory } from "@/server/data/stats";
import { PropMarket } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

const load = (file: string): any => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", file), "utf8"));

const HOU_BUF = { id: "401872660", file: "nfl-boxscore-401872660-hou-buf.json", home: "Buffalo Bills", away: "Houston Texans" };
const NYJ_DET = { id: "401872954", file: "nfl-boxscore-401872954-nyj-det.json", home: "Detroit Lions", away: "New York Jets" };
const KC_MIA = { id: "401872952", file: "nfl-boxscore-401872952-kc-mia.json", home: "Miami Dolphins", away: "Kansas City Chiefs" };

function rp(externalPlayerId: string, playerName: string, team: string, position: string): RosterPlayer {
  const [firstName, ...rest] = playerName.split(" ");
  return { externalPlayerId, playerName, firstName, lastName: rest.join(" "), team, position };
}
const ROSTER: RosterPlayer[] = [rp("9000002", "Tyrod Taylor", "New York Jets", "QB")];

type Stored = "TD_COUNT" | "TD" | null;
async function run(game: typeof HOU_BUF, betDetail: string, stored: Stored = "TD_COUNT", data?: any) {
  const deps: NflPropDeps = { fetchSummary: async () => data ?? load(game.file), getRoster: async () => ROSTER };
  return resolvePlayerProp({ betDetail, propMarket: stored, playerName: null, homeTeam: game.home, awayTeam: game.away }, game.id, "NFL", deps);
}

async function main() {
  // ---- parsing: the threshold is captured and the pick is TD_COUNT, not TD ----
  check("2+ TDs -> TD_COUNT", parsePlayerProp("Bijan Robinson 2+ touchdowns"), { playerName: "Bijan Robinson", propMarket: "TD_COUNT" });
  check("3+ TDs -> OVER 2.5", parseTouchdownProp("Gibbs 3+ TDs")?.count, { line: 2.5, direction: "OVER" });
  check("2 or more TDs -> OVER 1.5", parseTouchdownProp("Kelce 2 or more TDs")?.count, { line: 1.5, direction: "OVER" });
  check("Over 1.5 TDs -> OVER 1.5", parseTouchdownProp("Kelce Over 1.5 TDs")?.count, { line: 1.5, direction: "OVER" });
  check("o1.5 TDs shorthand", parseTouchdownProp("Kelce o1.5 TDs")?.count, { line: 1.5, direction: "OVER" });
  check("Under 0.5 TDs -> UNDER 0.5", parseTouchdownProp("Kelce under 0.5 TDs")?.count, { line: 0.5, direction: "UNDER" });
  check("count pick's player name carries no line words", parseTouchdownProp("Kelce Over 1.5 TDs")?.playerName, "Kelce");
  check("rushing + receiving count reads both", parseTouchdownProp("Kelce over 1.5 rushing + receiving TDs")?.propType, "ANY");
  check("rushing-only count stays RUSHING", parseTouchdownProp("Kelce over 0.5 rushing TDs")?.propType, "RUSHING");
  check("anytime TD is still TD (no count)", parsePlayerProp("Puka Nacua Anytime TD"), { playerName: "Puka Nacua", propMarket: "TD" });
  check("anytime TD parse unchanged: no count key", parseTouchdownProp("Puka Nacua Anytime TD"), { playerName: "Puka Nacua", propType: "ANY", unsupported: undefined });
  check("first TD is still declined", !!parseTouchdownProp("Gibbs first TD")?.unsupported, true);
  check("0+ TDs is declined, not read as anytime", !!parseTouchdownProp("Gibbs 0+ TDs")?.unsupported, true);
  check("passing TDs are not a TD count", parsePlayerProp("Watson 2+ passing TDs")?.propMarket, "PASS_TDS");
  check("a count pick is never priced as anytime TD", ["Gibbs 2+ TDs", "Kelce Over 1.5 TDs"].map(isAnytimeTdPick), [false, false]);

  // ---- N+ edges (OVER N - 0.5, never a push) ----
  check("2+ with exactly 2 (Walker III 1 rush + 1 rec) -> WIN", await run(KC_MIA, "Kenneth Walker III 2+ TDs"), { outcome: "WIN" });
  check("2+ with 1 (Garrett Wilson) -> LOSS", await run(NYJ_DET, "Garrett Wilson 2+ TDs"), { outcome: "LOSS" });
  check("2+ with 3 (Gibbs) -> WIN", await run(NYJ_DET, "Jahmyr Gibbs 2+ touchdowns"), { outcome: "WIN" });
  check("3+ with exactly 3 (Gibbs) -> WIN", await run(NYJ_DET, "Jahmyr Gibbs 3+ TDs"), { outcome: "WIN" });
  check("3+ with 2 (Josh Allen) -> LOSS", await run(HOU_BUF, "Josh Allen 3+ TDs"), { outcome: "LOSS" });
  check("4+ with 3 (Montgomery) -> LOSS", await run(HOU_BUF, "David Montgomery 4+ TDs"), { outcome: "LOSS" });

  // ---- Over / Under x ----
  check("Over 1.5 with 2 -> WIN", await run(HOU_BUF, "Josh Allen Over 1.5 TDs"), { outcome: "WIN" });
  check("Over 2.5 with 2 -> LOSS", await run(HOU_BUF, "Josh Allen Over 2.5 TDs"), { outcome: "LOSS" });
  check("Under 2.5 with 2 -> WIN", await run(HOU_BUF, "Josh Allen Under 2.5 TDs"), { outcome: "WIN" });
  check("Under 1.5 with 2 -> LOSS", await run(HOU_BUF, "Josh Allen Under 1.5 TDs"), { outcome: "LOSS" });
  check("Under 0.5 with 1 (DJ Moore) -> LOSS", await run(HOU_BUF, "DJ Moore Under 0.5 TDs"), { outcome: "LOSS" });
  check("Over 0.5 with 1 (DJ Moore) -> WIN", await run(HOU_BUF, "DJ Moore Over 0.5 TDs"), { outcome: "WIN" });
  check("whole-number line equal to the count -> PUSH (Over 2, Allen has 2)", await run(HOU_BUF, "Josh Allen Over 2 TDs"), { outcome: "PUSH" });
  check("whole-number line equal to the count -> PUSH (Under 2)", await run(HOU_BUF, "Josh Allen Under 2 TDs"), { outcome: "PUSH" });

  // ---- rushing / receiving scoping reuses the same sum split ----
  check("Montgomery rushing TDs over 1.5 (2 rush) -> WIN", await run(HOU_BUF, "David Montgomery over 1.5 rushing TDs"), { outcome: "WIN" });
  check("Montgomery rushing TDs over 2.5 (3 total, 2 rush) -> LOSS: scoped to rushing", await run(HOU_BUF, "David Montgomery over 2.5 rushing TDs"), { outcome: "LOSS" });
  check("Allen receiving TDs over 0.5 (0 rec) -> LOSS", await run(HOU_BUF, "Josh Allen over 0.5 receiving TDs"), { outcome: "LOSS" });

  // ---- did-not-play: same verified-roster rule as every other NFL prop ----
  check("rostered player on a team in the game, final + complete box, no row -> PUSH", await run(NYJ_DET, "Tyrod Taylor 2+ TDs"), { outcome: "PUSH" });
  {
    const data = load(NYJ_DET.file);
    data.header.competitions[0].status.type.completed = false;
    const r: any = await run(NYJ_DET, "Jahmyr Gibbs 2+ TDs", "TD_COUNT", data);
    check("game not final -> PENDING with the existing reason", [r.outcome, r.reason], [null, "the box score isn't final yet for this game"]);
  }

  // ---- legacy rows (no propMarket) re-derive TD_COUNT from the text ----
  check("propMarket null + count text -> graded as a count", await run(NYJ_DET, "Jahmyr Gibbs 2+ TDs", null), { outcome: "WIN" });

  // ---- stored market and text must agree: a count pick and an anytime pick never grade as each other ----
  {
    const r: any = await run(NYJ_DET, "Jahmyr Gibbs 2+ TDs", "TD");
    check("stored TD + count text (the pre-TD_COUNT pending row) -> manual, never graded as anytime", [r.outcome, /anytime-TD bet but its text is a touchdown-count bet/.test(r.reason)], [null, true]);
  }
  {
    const r: any = await run(NYJ_DET, "Jahmyr Gibbs anytime TD", "TD_COUNT");
    check("stored TD_COUNT + anytime text -> manual, never graded as anytime", [r.outcome, /couldn't find a touchdown-count line/.test(r.reason)], [null, true]);
  }
  check("anytime TD still grades: Garrett Wilson (1 TD) stored TD -> WIN", await run(NYJ_DET, "Garrett Wilson anytime TD", "TD"), { outcome: "WIN" });
  check("anytime TD still grades: LOSS for a player with 0", await run(HOU_BUF, "Nico Collins rushing TD", "TD"), { outcome: "LOSS" });

  // ---- non-NFL sport: still NFL-only ----
  {
    const r: any = await resolvePlayerProp(
      { betDetail: "Gibbs 2+ TDs", propMarket: "TD_COUNT", playerName: null, homeTeam: NYJ_DET.home, awayTeam: NYJ_DET.away },
      NYJ_DET.id,
      "NHL"
    );
    check("TD_COUNT is never graded by another sport's grader as a TD count", r.outcome, null);
  }

  // ---- never pools with TD: records are keyed per market ----
  check("football keys: TD and TD_COUNT are separate keys", [PROP_MARKET_KEYS.includes("FOOTBALL:TD"), PROP_MARKET_KEYS.includes("FOOTBALL:TD_COUNT")], [true, true]);
  check("TD_COUNT pick -> FOOTBALL:TD_COUNT", propMarketKey({ betType: "PLAYER_PROP", sportName: "NFL", propMarket: "TD_COUNT" }), "FOOTBALL:TD_COUNT");
  check("TD pick -> FOOTBALL:TD", propMarketKey({ betType: "PLAYER_PROP", sportName: "NFL", propMarket: "TD" }), "FOOTBALL:TD");
  check("NCAAF TD_COUNT shares the football key, TD_COUNT never maps to TD", PROP_MARKET_KEYS.filter((k) => propMarketOf(k) === "TD_COUNT"), ["FOOTBALL:TD_COUNT"]);
  check("every PropMarket value still has a key somewhere (TD_COUNT included)", Object.values(PropMarket).filter((m) => !PROP_MARKET_KEYS.some((k) => propMarketOf(k) === m)), []);
  {
    // The platform-rates recompute joins a pick to its record key by EXACT (sport, propMarket) equality.
    const q = buildPlatformRatesRecompute();
    const sqlText = q.sql;
    const flat = JSON.stringify(q.values);
    check("platform rates: joins on exact propMarket equality", /m\.market = p\."propMarket"::text/.test(sqlText), true);
    check("platform rates: NFL TD and NFL TD_COUNT map to different keys", [flat.includes('"NFL","TD","FOOTBALL:TD"'), flat.includes('"NFL","TD_COUNT","FOOTBALL:TD_COUNT"')], [true, true]);
  }
  // The capper "Record by category" tile (PICK_CATEGORY_VERSION 5): a TD count and an anytime TD are different
  // categories, never one catch-all - the same split the per-market record keys above already make.
  check("category tile: TD_COUNT and TD are separate categories", [
    pickCategory({ betType: "PLAYER_PROP", sportName: "NFL", propMarket: "TD_COUNT", betDetail: "x" } as any),
    pickCategory({ betType: "PLAYER_PROP", sportName: "NFL", propMarket: "TD", betDetail: "x" } as any),
  ], ["TD_COUNT_PROP", "ANYTIME_TD_PROP"]);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
