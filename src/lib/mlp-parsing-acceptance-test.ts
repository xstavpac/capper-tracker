// Proof for parseCatalog's MLP (moneyline parlay) detection - run with:
//   npx tsx src/lib/mlp-parsing-acceptance-test.ts
//
// MLP is two independently-resolvable picks coupled into one heads-up bet,
// marked by a trailing "mlp" keyword: "Lions +12.5 + Lions/Bills o47 mlp".
// The critical property under test is that the split on " + " (whitespace
// BOTH sides) never confuses the leg separator with a spread number's own
// sign ("+12.5", space before only) - and that a line NOT in this exact
// shape (no "mlp", or "mlp" merely appearing as a stray word) is left alone
// for normal single-pick parsing, never guessed at as a parlay.
import { parseCatalog } from "./parse-catalog";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function main() {
  // ---- Core shape: spread leg + total leg, sport inferred from nicknames ----
  {
    const { picks, parlays, unresolved } = parseCatalog("Bettor Bob\nLions +12.5 + Lions/Bills o47 mlp");
    check("no plain picks produced", picks.length, 0);
    check("nothing left unresolved", unresolved.length, 0);
    check("exactly one parlay produced", parlays.length, 1);
    if (parlays.length === 1) {
      const p = parlays[0];
      check("capper attributed correctly", p.capperName, "Bettor Bob");
      check("sport inferred once for the whole line", p.sportName, "NFL");
      check("leg A is a SPREAD", p.legs[0].betType, "SPREAD");
      check("leg A keeps its own raw text (real line resolved later, not here)", p.legs[0].raw, "Lions +12.5");
      check("leg B is a TOTAL (over)", p.legs[1].betType, "TOTAL");
      check("leg B totalSide is over", p.legs[1].totalSide, "over");
      check("default units with no explicit unit annotation", p.units, 1);
    }
  }

  // ---- The spread's own "+" is never mistaken for the leg separator ----
  // ("Lions +12.5" has a space BEFORE its + but not after - only " + " with
  // whitespace on both sides is a real leg separator).
  {
    const { parlays } = parseCatalog("Bettor Bob\nLions +12.5 + Lions/Bills o47 mlp");
    check("split into exactly 2 legs, not 3+", parlays[0]?.legs.length, 2);
  }

  // ---- Trailing units after the keyword apply to the whole parlay ----
  {
    const { parlays } = parseCatalog("Bettor Bob\nLions +12.5 + Lions/Bills o47 mlp 2u");
    check("explicit trailing units override per-leg defaults", parlays[0]?.units, 2);
  }
  {
    const { parlays } = parseCatalog("Bettor Bob\nLions +12.5 + Lions/Bills o47 mlp (3 units)");
    check("parenthesized spelled-out trailing units also recognized", parlays[0]?.units, 3);
  }

  // ---- Moneyline vs moneyline (the original motivating example) ----
  {
    const { parlays } = parseCatalog("Bettor Bob\nChiefs ML + Bills ML mlp");
    check("two-moneyline MLP recognized", parlays.length, 1);
    if (parlays.length === 1) {
      check("leg A moneyline", parlays[0].legs[0].betType, "MONEYLINE");
      check("leg B moneyline", parlays[0].legs[1].betType, "MONEYLINE");
    }
  }

  // ---- Not MLP-shaped: no trailing keyword at all - normal single pick ----
  {
    const { picks, parlays } = parseCatalog("Bettor Bob\nLions +12.5");
    check("plain spread pick, not a parlay", parlays.length, 0);
    check("parses as one normal pick", picks.length, 1);
  }

  // ---- Not MLP-shaped: "mlp" present but no " + " leg separator ----
  {
    const { parlays, unresolved } = parseCatalog("Bettor Bob\nLions +12.5 mlp");
    check("no leg separator -> not treated as a parlay", parlays.length, 0);
    // Falls through to whatever the normal single-pick path does with the
    // stray trailing word - not asserting which bucket, just that it was
    // never mis-split into 2 legs.
    check("nothing incorrectly split into 2 legs", parlays.length === 0, true);
    void unresolved;
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();
