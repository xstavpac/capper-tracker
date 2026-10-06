// Proof that the "Supported pick formats" list on the Catalog Import page
// matches what the parsers actually do - run with:
//   npx tsx src/lib/supported-pick-formats-acceptance-test.ts
//
// Every example in supported-pick-formats.ts goes through the real parser its
// row names: game lines through parseCatalog, player props through the prop
// parsers directly (surname/roster matching happens server-side, so the list
// uses full names). "Asks you" rows must parse AND come back ambiguous;
// "Not yet" rows must not produce a gradable pick. No network, no database.
import { parseCatalog, parsePickText, resolveAmbiguousPick } from "./parse-catalog";
import { extractLine } from "./bet-line";
import { parsePlayerProp, parseTouchdownProp, isAnytimeTdPick } from "./bet-line";
import { parseMlbPlayerProp } from "./mlb-prop";
import { parseNhlPlayerProp } from "./nhl-prop";
import { detectUnsupportedNflStat } from "./unsupported-prop-vocab";
import {
  SUPPORTED_PICK_FORMATS,
  COMMON_FORMATS,
  FORMAT_FOOTER_TIP,
  type FormatRow,
} from "./supported-pick-formats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function catalogLine(example: string) {
  return parseCatalog("Vegas John\n" + example);
}

function checkExample(row: FormatRow, example: string) {
  const label = `${row.market}: "${example}"`;
  const c = row.check;
  switch (c.via) {
    case "catalog": {
      const { picks, unresolved } = catalogLine(example);
      const p = picks[0];
      check(`${label} parses to one pick`, [picks.length, unresolved.length], [1, 0]);
      if (!p) return;
      check(`${label} bet type`, p.betType, c.betType);
      check(`${label} needs no "which team?" prompt`, Boolean(p.ambiguous), false);
      if (c.sport) check(`${label} league`, p.sportName, c.sport);
      else check(`${label} resolves a league`, p.sportName.length > 0, true);
      if (c.gameNumber) check(`${label} game number`, p.gameNumber, c.gameNumber);
      if (c.explicitOdds !== undefined) {
        check(`${label} reads the capper's odds`, [p.hasExplicitOdds, p.odds], [true, c.explicitOdds]);
      }
      return;
    }
    case "catalog-parlay": {
      const { picks, parlays, unresolved } = catalogLine(example);
      check(`${label} parses to one 2-leg parlay`, [picks.length, parlays.length, unresolved.length], [0, 1, 0]);
      return;
    }
    case "catalog-asks": {
      const { picks } = catalogLine(example);
      const p = picks[0];
      check(`${label} parses to one pick`, picks.length, 1);
      check(`${label} is ambiguous (the import asks)`, (p?.ambiguous?.length ?? 0) > 1, true);
      return;
    }
    case "nfl-prop": {
      check(`${label} NFL market`, parsePlayerProp(example)?.propMarket ?? null, c.market);
      check(`${label} is not an unsupported NFL stat`, detectUnsupportedNflStat(example), null);
      if (c.anytimeTd) {
        check(`${label} is the graded anytime-TD market`, isAnytimeTdPick(example), true);
        check(`${label} not declined by grading`, parseTouchdownProp(example)?.unsupported ?? null, null);
      }
      return;
    }
    case "mlb-prop":
      check(`${label} MLB market`, parseMlbPlayerProp(example)?.propMarket ?? null, c.market);
      return;
    case "nhl-prop":
      check(`${label} NHL market`, parseNhlPlayerProp(example)?.propMarket ?? null, c.market);
      return;
    case "nfl-td-ungraded":
      // Recognized as a TD prop, but flagged so resolveTouchdownProp declines it.
      check(`${label} is flagged ungradeable`, Boolean(parseTouchdownProp(example)?.unsupported), true);
      check(`${label} is not the anytime-TD market`, isAnytimeTdPick(example), false);
      return;
    case "nfl-unsupported-stat":
      check(`${label} is flagged as an unsupported NFL stat`, detectUnsupportedNflStat(example) !== null, true);
      check(`${label} produces no pick`, catalogLine(example).picks.length, 0);
      return;
  }
}

// A capper's own price is read with or without parentheses. The rule under
// test: a trailing signed whole number of 100+ is the price; in a spread the
// first signed number is the line and the second the price; a line alone is
// never a price; units are never a price.
function checkOddsForms() {
  // [text, bet type, odds (null = none in the text), line, units]
  const cases: [string, string, number | null, number | null, number][] = [
    ["Yankees ML -132", "MONEYLINE", -132, null, 1],
    ["Yankees ML +145", "MONEYLINE", 145, null, 1],
    ["Yankees ML (-132)", "MONEYLINE", -132, null, 1],
    ["Giants +6.5 -110", "SPREAD", -110, 6.5, 1],
    ["Giants +6.5 (-110)", "SPREAD", -110, 6.5, 1],
    ["Giants +6.5", "SPREAD", null, 6.5, 1],
    ["Over 8.5 -115", "TOTAL", -115, 8.5, 1],
    ["Detroit -6.5", "SPREAD", null, -6.5, 1],
    ["Yankees ML -132 2u", "MONEYLINE", -132, null, 2],
    ["Yankees ML -132 1.5 units", "MONEYLINE", -132, null, 1.5],
    // Below 100 is not an American price, and a lone signed number is the bet itself.
    ["Yankees ML -50", "MONEYLINE", null, null, 1],
    ["Yankees -132", "SPREAD", null, -132, 1],
  ];
  for (const [text, betType, odds, line, units] of cases) {
    const parsed = parsePickText(text);
    check(
      `odds form "${text}" -> bet type / odds / line / units`,
      [parsed.betType, parsed.odds, extractLine(parsed.betType, parsed.cleanDescription), parsed.units],
      [betType, odds, line, units]
    );
  }
  // A price read from the text is dropped from the stored bet text, like a parenthesised one.
  check('"Giants +6.5 -110" keeps only the line in its description', parsePickText("Giants +6.5 -110").cleanDescription, "Giants +6.5");

  // End to end through parseCatalog, where the team resolves on its own.
  const endToEnd: [string, string, number, boolean, number][] = [
    ["Yankees ML -132", "MONEYLINE", -132, true, 1],
    ["Yankees ML +145", "MONEYLINE", 145, true, 1],
    ["Yankees ML (-132)", "MONEYLINE", -132, true, 1],
    ["Yankees ML -132 2u", "MONEYLINE", -132, true, 2],
    ["NFL Giants +6.5 -110", "SPREAD", -110, true, 1],
    ["NFL Giants +6.5 (-110)", "SPREAD", -110, true, 1],
    ["NFL Giants +6.5", "SPREAD", -110, false, 1],
    ["Dodgers over 8.5 -115", "TOTAL", -115, true, 1],
  ];
  for (const [text, betType, odds, explicit, units] of endToEnd) {
    const p = catalogLine(text).picks[0];
    check(
      `catalog "${text}" -> bet type / odds / explicit / units`,
      [p?.betType, p?.odds, p?.hasExplicitOdds, p?.units],
      [betType, odds, explicit, units]
    );
  }

  // "Giants +6.5 -110" asks which Giants first; the price is read once it's answered.
  const giants = catalogLine("Giants +6.5 -110").picks[0];
  check('"Giants +6.5 -110" still asks which Giants, on the 6.5 line', [(giants?.ambiguous?.length ?? 0) > 1, giants?.ambiguousLine], [true, 6.5]);
  const nfl = giants?.ambiguous?.find((o) => o.sport === "NFL");
  if (giants && nfl) {
    const resolved = resolveAmbiguousPick(giants, nfl);
    check(
      '"Giants +6.5 -110" answered NFL -> spread +6.5 at -110',
      [resolved.betType, resolved.odds, resolved.hasExplicitOdds, extractLine(resolved.betType, resolved.description)],
      ["SPREAD", -110, true, 6.5]
    );
  } else {
    check('"Giants +6.5 -110" offers an NFL option', Boolean(nfl), true);
  }

  // "Detroit -6.5" stays a spread with no price, before and after it's answered.
  const detroit = catalogLine("Detroit -6.5").picks[0];
  check('"Detroit -6.5" -> spread, no price', [detroit?.betType, detroit?.hasExplicitOdds, detroit?.ambiguousLine], ["SPREAD", false, -6.5]);
}

function main() {
  const supportedExamples = new Set<string>();
  for (const group of SUPPORTED_PICK_FORMATS) {
    for (const row of group.rows) {
      check(`${group.title} / ${row.market} has an example`, row.examples.length > 0, true);
      // "supported" may only sit on a check that proves a real pick; "asks" /
      // "not-yet" only on the checks that prove those outcomes.
      const expectedStatus =
        row.check.via === "catalog-asks"
          ? "asks"
          : row.check.via === "nfl-td-ungraded" || row.check.via === "nfl-unsupported-stat"
            ? "not-yet"
            : "supported";
      check(`${group.title} / ${row.market} status matches its check`, row.status, expectedStatus);
      for (const example of row.examples) {
        checkExample(row, example);
        if (row.status === "supported") supportedExamples.add(example);
      }
    }
  }

  // The "Common formats" card may only show examples the full list proves.
  for (const f of COMMON_FORMATS) {
    check(`common format "${f.example}" is a supported example`, supportedExamples.has(f.example), true);
  }

  // The footer tip's own example: a league prefix answers the question up front.
  const tipExample = /\(([^)]+)\)/.exec(FORMAT_FOOTER_TIP)?.[1] ?? "";
  const tipPick = catalogLine(tipExample).picks[0];
  check(`footer tip "${tipExample}" resolves without asking`, [tipPick?.sportName, Boolean(tipPick?.ambiguous)], ["NFL", false]);

  checkOddsForms();

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();
