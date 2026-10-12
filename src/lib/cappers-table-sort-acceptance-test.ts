// The /cappers leaderboard's sort comparator and header-click rule - run with:
//   npx tsx src/lib/cappers-table-sort-acceptance-test.ts
//
// Proven here:
//  - Each of Record / Win % / ROI / Units orders on the numbers behind the row, high to low and
//    low to high - including the cases a formatted-string sort gets wrong ("9%" vs "10%",
//    "+12.5%" vs "−3%", "9-1" vs "10-5").
//  - Record: wins first, then losses as the tie-break (fewer losses ranks higher), reversed as a
//    whole when the direction flips; pushes never enter it.
//  - A capper with nothing to show in the column (no graded picks, pushes only for Win %, a NaN
//    ROI / units) is last in BOTH directions, while Infinity / -Infinity stay ordinary values.
//  - Ties fall to net units, then name, then id, the same way in both directions.
//  - nextSort: the first click on a column is high to low, a second click reverses it, a third
//    is high to low again, and moving to another column starts high to low.
//  - The `dir` URL param: parsed, defaulted, kept out of the URL when it is the default, kept
//    across paging, and reset to page 1 when it changes.
import { compareCappers, nextSort, sortValues, type SortableCapper } from "./cappers-table-sort";
import { cappersHref, parseCappersParams, type CappersSortKey, type SortDir } from "./cappers-page-params";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// A row as the table holds it. winPct is derived the way the page derives it (pushes excluded).
function capper(name: string, wins: number, losses: number, o: { pushes?: number; roi?: number; netUnits?: number; id?: string } = {}): SortableCapper {
  return {
    capperId: o.id ?? "id-" + name,
    name,
    stats: { wins, losses, pushes: o.pushes ?? 0, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, roi: o.roi ?? 0, netUnits: o.netUnits ?? 0 },
  };
}
const order = (rows: SortableCapper[], key: CappersSortKey, dir?: SortDir) => [...rows].sort(compareCappers(key, dir)).map((r) => r.name);
// Every starting order has to end in the same place.
function orderFromAnyStart(rows: SortableCapper[], key: CappersSortKey, dir: SortDir): string[][] {
  const starts = [rows, [...rows].reverse(), [...rows.slice(2), ...rows.slice(0, 2)]];
  return starts.map((s) => order(s, key, dir));
}

function main() {
  // ---- Numeric, not string ----
  {
    const rows = [capper("nine", 9, 91), capper("ten", 10, 90), capper("hundred", 5, 0), capper("two", 2, 98)];
    check("win: high to low is numeric (100, 10, 9, 2 - not '9%' above '10%')", order(rows, "win"), ["hundred", "ten", "nine", "two"]);
    check("win: low to high is the exact reverse", order(rows, "win", "asc"), ["two", "nine", "ten", "hundred"]);
    check("win: high to low is the default direction", order(rows, "win"), order(rows, "win", "desc"));
  }
  {
    const rows = [capper("neg", 1, 1, { roi: -3 }), capper("big", 1, 1, { roi: 12.5 }), capper("small", 1, 1, { roi: 2 }), capper("zero", 1, 1, { roi: 0 }), capper("negbig", 1, 1, { roi: -20 })];
    check("roi: high to low, negatives below zero", order(rows, "roi"), ["big", "small", "zero", "neg", "negbig"]);
    check("roi: low to high", order(rows, "roi", "asc"), ["negbig", "neg", "zero", "small", "big"]);
  }
  {
    const rows = [capper("a", 1, 1, { netUnits: 9.5 }), capper("b", 1, 1, { netUnits: 10.25 }), capper("c", 1, 1, { netUnits: -1.1 }), capper("d", 1, 1, { netUnits: 100 })];
    check("units: high to low", order(rows, "units"), ["d", "b", "a", "c"]);
    check("units: low to high", order(rows, "units", "asc"), ["c", "a", "b", "d"]);
  }

  // ---- Record: wins, then losses ----
  {
    const rows = [capper("9-1", 9, 1), capper("10-5", 10, 5), capper("10-2", 10, 2), capper("10-8", 10, 8), capper("3-0", 3, 0)];
    check("record: wins first ('10-5' above '9-1'), fewer losses breaks a wins tie", order(rows, "record"), ["10-2", "10-5", "10-8", "9-1", "3-0"]);
    check("record: low to high reverses wins AND the losses tie-break", order(rows, "record", "asc"), ["3-0", "9-1", "10-8", "10-5", "10-2"]);
    check("record: sort values are [wins, -losses]", sortValues(capper("x", 10, 5), "record"), [10, -5]);
  }
  {
    // Same wins and losses: pushes do not decide it, the tie-break (net units, then name) does.
    const rows = [capper("many pushes", 5, 5, { pushes: 9, netUnits: 1 }), capper("no pushes", 5, 5, { netUnits: 2 }), capper("also", 5, 5, { netUnits: 2 })];
    check("record: equal W-L ignores pushes and falls to net units, then name", order(rows, "record"), ["also", "no pushes", "many pushes"]);
    check("record: that tie-break is the same low to high", order(rows, "record", "asc"), ["also", "no pushes", "many pushes"]);
  }

  // ---- Missing values sink, in either direction ----
  {
    const none = capper("no picks", 0, 0, { netUnits: 0 });
    const none2 = capper("also no picks", 0, 0);
    const pushOnly = capper("pushes only", 0, 0, { pushes: 3, roi: 0, netUnits: 0 });
    const loser = capper("loser", 0, 4, { roi: -100, netUnits: -4 });
    const winner = capper("winner", 4, 0, { roi: 90, netUnits: 3.6 });
    const rows = [none, pushOnly, loser, none2, winner];

    check("missing: no graded picks has no value in any column", (["record", "win", "roi", "units"] as const).map((k) => sortValues(none, k)), [null, null, null, null]);
    check("missing: pushes only has a record, ROI and units, but no Win %", (["record", "win", "roi", "units"] as const).map((k) => sortValues(pushOnly, k)), [[0, -0], null, [0], [0]]);

    check("win desc: 0% (a real 0-4) stays above the cappers with no Win %", order(rows, "win", "desc"), ["winner", "loser", "also no picks", "no picks", "pushes only"]);
    check("win asc: the missing ones are still last", order(rows, "win", "asc"), ["loser", "winner", "also no picks", "no picks", "pushes only"]);
    check("roi desc: no-pick cappers below a -100% ROI", order(rows, "roi", "desc"), ["winner", "pushes only", "loser", "also no picks", "no picks"]);
    check("roi asc: no-pick cappers still last", order(rows, "roi", "asc"), ["loser", "pushes only", "winner", "also no picks", "no picks"]);
    check("units desc: no-pick cappers below negative units", order(rows, "units", "desc"), ["winner", "pushes only", "loser", "also no picks", "no picks"]);
    check("units asc: no-pick cappers still last", order(rows, "units", "asc"), ["loser", "pushes only", "winner", "also no picks", "no picks"]);
    check("record desc: 0-0 with no picks is last", order(rows, "record", "desc"), ["winner", "pushes only", "loser", "also no picks", "no picks"]);
    check("record asc: 0-0 with no picks is still last", order(rows, "record", "asc"), ["loser", "pushes only", "winner", "also no picks", "no picks"]);

    for (const key of ["record", "win", "roi", "units"] as const) {
      for (const dir of ["desc", "asc"] as const) {
        const runs = orderFromAnyStart(rows, key, dir);
        check(`${key} ${dir}: the same order from any starting order`, runs.every((r) => JSON.stringify(r) === JSON.stringify(runs[0])), true);
      }
    }
  }
  {
    // An odds-0 win makes ROI / units Infinity, -Infinity or NaN. NaN is missing; the infinities are values.
    const rows = [
      capper("nan", 1, 1, { roi: NaN, netUnits: NaN }),
      capper("inf", 1, 1, { roi: Infinity, netUnits: Infinity }),
      capper("ninf", 1, 1, { roi: -Infinity, netUnits: -Infinity }),
      capper("five", 1, 1, { roi: 5, netUnits: 5 }),
      capper("inf2", 1, 1, { roi: Infinity, netUnits: Infinity }),
    ];
    for (const key of ["roi", "units"] as const) {
      check(`${key} desc: Infinity first, -Infinity last of the values, NaN after it`, order(rows, key, "desc"), ["inf", "inf2", "five", "ninf", "nan"]);
      check(`${key} asc: -Infinity first, Infinity last of the values, NaN still after it`, order(rows, key, "asc"), ["ninf", "five", "inf", "inf2", "nan"]);
    }
    check("NaN is missing for ROI and units only", (["record", "win", "roi", "units"] as const).map((k) => sortValues(rows[0], k) === null), [false, false, true, true]);
    // The NaN row keeps a real Win %, so there it is an ordinary row; among the equal ones its
    // NaN units put it last in the tie-break.
    check("win: equal Win %, tie-break puts NaN units last", order(rows, "win"), ["inf", "inf2", "five", "ninf", "nan"]);
  }

  // ---- Tie-break: net units, then name (case-insensitive, then exact), then id ----
  {
    const rows = [
      capper("bob", 5, 5, { netUnits: 1 }),
      capper("Alice", 5, 5, { netUnits: 1 }),
      capper("alice", 5, 5, { netUnits: 1 }),
      capper("carol", 5, 5, { netUnits: 3 }),
      capper("dave", 5, 5, { netUnits: 1, id: "id-2" }),
      capper("dave", 5, 5, { netUnits: 1, id: "id-1" }),
    ];
    const ids = (dir: SortDir) => [...rows].sort(compareCappers("win", dir)).map((r) => r.name + "/" + r.capperId);
    const expected = ["carol/id-carol", "Alice/id-Alice", "alice/id-alice", "bob/id-bob", "dave/id-1", "dave/id-2"];
    check("tie: net units high to low, then name, then id", ids("desc"), expected);
    check("tie: the same order low to high (the tie-break never flips)", ids("asc"), expected);
    check("tie: a row compared with itself is 0", compareCappers("roi")(rows[0], rows[0]), 0);
  }

  // ---- Header clicks ----
  {
    check("click another column: high to low", nextSort({ sort: "roi", dir: "desc" }, "units"), { sort: "units", dir: "desc" });
    check("click another column while low to high: still starts high to low", nextSort({ sort: "roi", dir: "asc" }, "win"), { sort: "win", dir: "desc" });
    check("second click on the active column: reversed", nextSort({ sort: "units", dir: "desc" }, "units"), { sort: "units", dir: "asc" });
    check("third click: high to low again", nextSort({ sort: "units", dir: "asc" }, "units"), { sort: "units", dir: "desc" });
    check("first click on the default column (ROI, already high to low): reversed", nextSort({ sort: "roi", dir: "desc" }, "roi"), { sort: "roi", dir: "asc" });
  }

  // ---- The dir URL param ----
  {
    const leagues = ["MLB"];
    const base = parseCappersParams({}, leagues);
    check("dir defaults to desc", base.dir, "desc");
    check("dir=asc is read", parseCappersParams({ dir: "asc" }, leagues).dir, "asc");
    check("anything else is desc", [parseCappersParams({ dir: "up" }, leagues).dir, parseCappersParams({ dir: ["asc", "desc"] }, leagues).dir], ["desc", "asc"]);
    check("the default direction stays out of the URL", cappersHref(base), "/cappers");
    check("a header click on Units", cappersHref(base, nextSort(base, "units")), "/cappers?sort=units");
    const units = parseCappersParams({ sort: "units", page: "3" }, leagues);
    check("a second click reverses and returns to page 1", cappersHref(units, nextSort(units, "units")), "/cappers?sort=units&dir=asc");
    const asc = parseCappersParams({ sort: "units", dir: "asc" }, leagues);
    check("paging keeps the direction", cappersHref(asc, { page: 2 }), "/cappers?sort=units&dir=asc&page=2");
    check("ROI low to high (ROI is the default sort, so only dir shows)", cappersHref(base, nextSort(base, "roi")), "/cappers?dir=asc");
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main();
