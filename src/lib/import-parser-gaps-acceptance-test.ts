// Proof for four import/label gaps found in production (2026-10) - run with:
//   npx tsx src/lib/import-parser-gaps-acceptance-test.ts
//
//   1. "NIU +7.5" (PARLAY SAFARI, 2026-10-10) logged RECOVERY_UNRESOLVED:
//      "niu" was not a Northern Illinois key.
//   2. "Liberty Flames -3.5 (1H)" was stored FULL_GAME: parsePickText dropped
//      the parenthetical before reading the period.
//   3. "Miami (Ohio) -3" / "Miami of Ohio -3" parsed as Miami Hurricanes +
//      Ohio Bobcats instead of Miami (OH) RedHawks.
//   4. /picks under "All sports" labeled first-half bet types "F5".
import { parseCatalog, parsePickText, resolveAmbiguousPick, NCAAF_CANONICAL_SUFFIX } from "@/lib/parse-catalog";
import { betScope, extractLine } from "@/lib/bet-line";
import { marketTag } from "@/lib/pick-display";
import { firstHalfLabelPrefixForChipSet, visibleBetTypeOptionsForChipSet } from "@/lib/bet-type-filter";
import { MLB_CHIP_SET, NCAAF_CHIP_SET, NFL_CHIP_SET } from "@/server/data/stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function firstPick(line: string, capper = "PARLAY SAFARI") {
  return parseCatalog(`${capper}\n${line}`, []).picks[0];
}
function canonicalTeams(line: string): string[] {
  return (firstPick(line)?.teamNicknames ?? []).map((n) => NCAAF_CANONICAL_SUFFIX[n] ?? n);
}

console.log("\n########## 1: NCAAF abbreviations ##########");
{
  const niu = firstPick("NIU +7.5");
  check("'NIU +7.5' -> NCAAF Northern Illinois spread", {
    sport: niu?.sportName,
    teams: canonicalTeams("NIU +7.5"),
    bet: niu?.betType,
    line: niu ? extractLine(niu.betType, niu.description) : null,
  }, { sport: "NCAAF", teams: ["northern illinois huskies"], bet: "SPREAD", line: 7.5 });

  // The other abbreviations cappers use already resolved before this change;
  // pinned here so they stay that way.
  const already: [string, string][] = [
    ["UNLV", "unlv rebels"], ["UTEP", "utep miners"], ["UTSA", "utsa roadrunners"],
    ["FIU", "florida international panthers"], ["FAU", "florida atlantic owls"],
    ["WKU", "western kentucky hilltoppers"], ["MTSU", "middle tennessee blue raiders"],
    ["UCF", "ucf knights"], ["USF", "south florida bulls"], ["SMU", "smu mustangs"],
    ["TCU", "tcu horned frogs"], ["BYU", "byu cougars"], ["ULM", "ul monroe warhawks"], ["UAB", "uab blazers"],
  ];
  for (const [abbr, canonical] of already) {
    check(`'${abbr} +7.5' -> NCAAF ${canonical}`, { sport: firstPick(`${abbr} +7.5`)?.sportName, teams: canonicalTeams(`${abbr} +7.5`) }, { sport: "NCAAF", teams: [canonical] });
  }
}

console.log("\n########## 2: period in parentheses + first-half shorthands ##########");
{
  const prod = firstPick("Liberty Flames -3.5 (1H)");
  check("'Liberty Flames -3.5 (1H)' -> NCAAF first-half spread -3.5", {
    sport: prod?.sportName,
    teams: canonicalTeams("Liberty Flames -3.5 (1H)"),
    bet: prod?.betType,
    period: prod?.period,
    line: prod ? extractLine(prod.betType, prod.description) : null,
  }, { sport: "NCAAF", teams: ["liberty flames"], bet: "SPREAD", period: "FIRST_HALF", line: -3.5 });
  // The stored text has to keep naming the half: grading re-reads the scope
  // from betDetail and resolveAmbiguousPick re-parses the description.
  check("...and its stored text still reads as first half", betScope(prod?.description ?? ""), "FIRST_HALF");
  check("...and it is labeled 1H, never F5, for NCAAF", marketTag({ betType: "SPREAD", period: prod?.period ?? "", sportName: "NCAAF", betDetail: prod?.description ?? null }), "1H spread");

  for (const token of ["H1", "FH", "1st H", "1 half"]) {
    for (const line of [`Liberty Flames -3.5 (${token})`, `Liberty Flames ${token} -3.5`, `Liberty Flames -3.5 ${token}`]) {
      const pick = firstPick(line);
      check(`'${line}' -> NCAAF first-half spread -3.5`, {
        sport: pick?.sportName,
        period: pick?.period,
        bet: pick?.betType,
        line: pick ? extractLine(pick.betType, pick.description) : null,
        tag: marketTag({ betType: "SPREAD", period: pick?.period ?? "", sportName: pick?.sportName ?? "", betDetail: pick?.description ?? null }),
      }, { sport: "NCAAF", period: "FIRST_HALF", bet: "SPREAD", line: -3.5, tag: "1H spread" });
    }
  }
  // A school matched by its bare name, with the shorthand as the next word.
  check("'Northern Illinois H1 -3.5' keeps its team", { teams: canonicalTeams("Northern Illinois H1 -3.5"), period: firstPick("Northern Illinois H1 -3.5")?.period }, { teams: ["northern illinois huskies"], period: "FIRST_HALF" });
  check("'Northern Illinois FH -3.5' keeps its team", { teams: canonicalTeams("Northern Illinois FH -3.5"), period: firstPick("Northern Illinois FH -3.5")?.period }, { teams: ["northern illinois huskies"], period: "FIRST_HALF" });
  check("'Dolphins -3 (H1)' -> NFL first half, labeled 1H", (() => {
    const p = firstPick("Dolphins -3 (H1)");
    return { sport: p?.sportName, period: p?.period, tag: marketTag({ betType: "SPREAD", period: p?.period ?? "", sportName: p?.sportName ?? "", betDetail: p?.description ?? null }) };
  })(), { sport: "NFL", period: "FIRST_HALF", tag: "1H spread" });

  // Other parenthetical periods are read the same way.
  check("'Liberty Flames -3.5 (2H)' -> second half", firstPick("Liberty Flames -3.5 (2H)")?.period, "SECOND_HALF");
  check("'Yankees ML (F5)' -> MLB first five", { sport: firstPick("Yankees ML (F5)")?.sportName, period: firstPick("Yankees ML (F5)")?.period }, { sport: "MLB", period: "FIRST_HALF" });

  // Units and a price in or after the parenthetical still parse.
  check("'Liberty Flames -3.5 (2u 1H)' -> 2u, first half", (() => {
    const p = parsePickText("Liberty Flames -3.5 (2u 1H)");
    return { units: p.units, period: p.period, text: p.cleanDescription };
  })(), { units: 2, period: "FIRST_HALF", text: "Liberty Flames -3.5 1H" });
  check("'Giants +6.5 (1H) -110' -> -110, first-half spread", (() => {
    const p = parsePickText("Giants +6.5 (1H) -110");
    return { odds: p.odds, period: p.period, bet: p.betType, line: extractLine(p.betType, p.cleanDescription) };
  })(), { odds: -110, period: "FIRST_HALF", bet: "SPREAD", line: 6.5 });
  check("'Yankees -132 (F5)' -> F5 moneyline at -132", (() => {
    const p = parsePickText("Yankees -132 (F5)");
    return { odds: p.odds, period: p.period, bet: p.betType };
  })(), { odds: -132, period: "FIRST_HALF", bet: "MONEYLINE" });

  // Parentheticals that are not a period are dropped exactly as before.
  check("'Lakers -4 (10u POTD)' unchanged", (() => {
    const p = parsePickText("Lakers -4 (10u POTD)");
    return { units: p.units, period: p.period, text: p.cleanDescription };
  })(), { units: 10, period: "FULL_GAME", text: "Lakers -4" });
  check("'Yankees ML (-120)' unchanged", (() => {
    const p = parsePickText("Yankees ML (-120)");
    return { odds: p.odds, period: p.period, text: p.cleanDescription };
  })(), { odds: -120, period: "FULL_GAME", text: "Yankees ML" });
  // A line's own number is never read as "1 half".
  check("'Lakers +1 half point' stays full game", parsePickText("Lakers +1 half point").period, "FULL_GAME");
  check("'Lakers -11 half' stays full game", parsePickText("Lakers -11 half").period, "FULL_GAME");

  // Existing working forms are unchanged: bare "Liberty" is still ambiguous
  // (WNBA / NCAAF) and reads first half -7 once a team is chosen.
  for (const line of ["Liberty 1H -7", "Liberty 1st Half -7"]) {
    const pick = firstPick(line);
    check(`'${line}' text -> first-half spread -7`, (() => {
      const p = parsePickText(line);
      return { period: p.period, bet: p.betType, line: extractLine(p.betType, p.cleanDescription), text: p.cleanDescription };
    })(), { period: "FIRST_HALF", bet: "SPREAD", line: -7, text: line });
    check(`'${line}' is still ambiguous on 'liberty'`, { sport: pick?.sportName, key: pick?.ambiguousKey }, { sport: "", key: "liberty" });
    const ncaaf = pick?.ambiguous?.find((o) => o.sport === "NCAAF");
    const resolved = pick && ncaaf ? resolveAmbiguousPick(pick, ncaaf) : undefined;
    check(`'${line}' resolved to the Flames -> NCAAF first half`, { sport: resolved?.sportName, period: resolved?.period, text: resolved?.description }, { sport: "NCAAF", period: "FIRST_HALF", text: line });
  }
}

console.log("\n########## 3: Miami (OH) ##########");
{
  for (const line of ["Miami (Ohio) -3", "Miami of Ohio -3", "Miami Ohio -5", "Miami RedHawks", "Miami (OH) -3", "Miami (OH) RedHawks -3"]) {
    const pick = firstPick(line);
    check(`'${line}' -> NCAAF Miami (OH) RedHawks only`, { sport: pick?.sportName, teams: canonicalTeams(line), ambiguous: pick?.ambiguousKey }, { sport: "NCAAF", teams: ["miami (oh) redhawks"], ambiguous: undefined });
  }
  check("'Miami (Ohio) -3' is a -3 spread", (() => {
    const p = firstPick("Miami (Ohio) -3");
    return { bet: p?.betType, line: p ? extractLine(p.betType, p.description) : null };
  })(), { bet: "SPREAD", line: -3 });
  // The stored text keeps the "(Ohio)" - without it the pick would read as
  // bare "Miami" to anything that looks at the text again.
  check("'Miami (Ohio) -3' keeps '(Ohio)' in its stored text", firstPick("Miami (Ohio) -3")?.description, "Miami (Ohio) -3");
  check("'Miami (OH) -3 (2u)' keeps '(OH)', drops the units", parsePickText("Miami (OH) -3 (2u)").cleanDescription, "Miami (OH) -3");
  check("'Miami (Ohio) -3 (1H)' -> RedHawks first half", { teams: canonicalTeams("Miami (Ohio) -3 (1H)"), period: firstPick("Miami (Ohio) -3 (1H)")?.period }, { teams: ["miami (oh) redhawks"], period: "FIRST_HALF" });

  // Bare "Miami" never silently becomes the RedHawks: it stays ambiguous,
  // and the RedHawks are not even on its list.
  const bare = firstPick("Miami -3");
  check("bare 'Miami -3' stays ambiguous", { sport: bare?.sportName, key: bare?.ambiguousKey, teams: bare?.teamNicknames }, { sport: "", key: "miami", teams: [] });
  check("bare 'Miami -3' options never include the RedHawks", (bare?.ambiguous ?? []).some((o) => /redhawks|\(oh\)/i.test(o.nickname + o.label)), false);
  // The other Miami teams are unaffected.
  check("'Miami Hurricanes -3' -> NCAAF Hurricanes", { sport: firstPick("Miami Hurricanes -3")?.sportName, teams: canonicalTeams("Miami Hurricanes -3") }, { sport: "NCAAF", teams: ["miami hurricanes"] });
  check("'Miami Dolphins -3' -> NFL", firstPick("Miami Dolphins -3")?.sportName, "NFL");
  check("'Miami vs Ohio State under 50' -> Hurricanes + Buckeyes, not the RedHawks", [...canonicalTeams("Miami vs Ohio State under 50")].sort(), ["miami hurricanes", "ohio state buckeyes"]);
}

console.log("\n########## 4: first-half filter label ##########");
{
  const firstHalfLabels = (chipSet: Parameters<typeof visibleBetTypeOptionsForChipSet>[0]) =>
    visibleBetTypeOptionsForChipSet(chipSet).filter((o) => o.value.startsWith("F5_")).map((o) => o.label);
  check("All sports -> '1H / F5' prefix", firstHalfLabelPrefixForChipSet(null), "1H / F5");
  check("All sports -> first-half options labeled '1H / F5 ...'", firstHalfLabels(null), ["1H / F5 Spread", "1H / F5 Moneyline", "1H / F5 Total"]);
  check("MLB -> 'F5 ...'", firstHalfLabels(MLB_CHIP_SET), ["F5 Spread", "F5 Moneyline", "F5 Total"]);
  check("NFL -> '1H ...'", firstHalfLabels(NFL_CHIP_SET), ["1H Spread", "1H Moneyline", "1H Total"]);
  check("NCAAF -> '1H ...'", firstHalfLabels(NCAAF_CHIP_SET), ["1H Spread", "1H Moneyline", "1H Total"]);
  check("All sports changes no other option's label", visibleBetTypeOptionsForChipSet(null).filter((o) => !o.value.startsWith("F5_")).some((o) => /1H|F5/.test(o.label)), false);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
