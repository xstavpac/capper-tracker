// Proof for the capper-header rule in catalog import. Run with:
//   npx tsx src/lib/capper-header-rule-acceptance-test.ts
//
// The bug (2026-10-20): "Brad Thomas" on its own line, picks below, imported
// every pick as "Unknown". The bare-name line was checked against the NFL
// roster first, fuzzy-matched "Brian Thomas Jr.", and was parked as an
// unresolved player line instead of heading the block.
//
// The rule (parse-catalog.ts hasBetContent): a line with no bet content - no
// line or number, no over/under, no market word, no units - is a capper
// header, whatever it names. The roster is only consulted for a line that has
// bet content. A pick with no header above it carries no capper ("") and the
// import holds it back (bulk-import-summary.ts splitByCapper).
//
// Pure: no network, no database.
import { parseCatalog } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { splitByCapper } from "@/lib/bulk-import-summary";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const ROSTER: RosterPlayer[] = [
  { playerName: "Josh Allen", firstName: "Josh", lastName: "Allen", team: "Buffalo Bills", position: "QB", externalPlayerId: "1" },
  { playerName: "Brian Thomas Jr.", firstName: "Brian", lastName: "Thomas Jr.", team: "Jacksonville Jaguars", position: "WR", externalPlayerId: "2" },
  { playerName: "James Cook", firstName: "James", lastName: "Cook", team: "Buffalo Bills", position: "RB", externalPlayerId: "3" },
  { playerName: "Mike Evans", firstName: "Mike", lastName: "Evans", team: "Tampa Bay Buccaneers", position: "WR", externalPlayerId: "4" },
];
const ROSTER_NAMES = ROSTER.map((p) => p.playerName);

type Summary = { picks: [string, string][]; unresolved: [string, string][] };
function run(paste: string, saved: string[] = [], roster: string[] | undefined = ROSTER_NAMES): Summary {
  const out = parseCatalog(paste, saved, roster);
  return {
    picks: out.picks.map((p) => [p.capperName, p.raw]),
    unresolved: out.unresolved.map((u, i) => [out.unresolvedCapperNames[i], u]),
  };
}

// ---- 1. A bare name is a header, even one the roster fuzzy-matches ----
expect('"Brad Thomas" / "Memphis -6.5" -> capper Brad Thomas, 1 pick', run("Brad Thomas\nMemphis -6.5"), {
  picks: [["Brad Thomas", "Memphis -6.5"]],
  unresolved: [],
});
expect('same with no roster loaded', run("Brad Thomas\nMemphis -6.5", [], undefined), {
  picks: [["Brad Thomas", "Memphis -6.5"]],
  unresolved: [],
});

// ---- 2. A capper named exactly like an active player ----
expect('"Josh Allen" alone, picks below -> capper Josh Allen', run("Josh Allen\nMemphis -6.5\nChiefs ML"), {
  picks: [
    ["Josh Allen", "Memphis -6.5"],
    ["Josh Allen", "Chiefs ML"],
  ],
  unresolved: [],
});
expect(
  "same when Josh Allen is also a saved capper",
  run("Sharp Sam\nYankees ML\n\nJosh Allen\nChiefs ML", ["Josh Allen", "Sharp Sam"]).picks,
  [
    ["Sharp Sam", "Yankees ML"],
    ["Josh Allen", "Chiefs ML"],
  ]
);

// ---- 3. Player props with bet content still parse as props ----
{
  const paste = "Sharp Sam\nJosh Allen over 1.5 passing TDs\nBrad Thomas anytime TD\nChiefs ML";
  const out = run(paste);
  expect("prop lines stay under the active capper and never become headers", out, {
    picks: [["Sharp Sam", "Chiefs ML"]],
    unresolved: [
      ["Sharp Sam", "Josh Allen over 1.5 passing TDs"],
      ["Sharp Sam", "Brad Thomas anytime TD"],
    ],
  });
  const parsed = parseCatalog(paste, [], ROSTER_NAMES);
  const recovered = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [], ROSTER, parsed.picks);
  expect(
    '"Josh Allen over 1.5 passing TDs" is read as Josh Allen\'s passing-TD prop by the roster pass',
    recovered.recovered.filter((p) => p.raw.startsWith("Josh Allen")).map((p) => [p.capperName, p.sportName, p.betType]),
    [["Sharp Sam", "NFL", "PLAYER_PROP"]]
  );
}

// ---- 4. A bare team name is a header; a moneyline is written with ML ----
expect('bare "Chiefs" heads the block below it', run("Sharp Sam\nYankees ML\nChiefs\nBills -3").picks, [
  ["Sharp Sam", "Yankees ML"],
  ["Chiefs", "Bills -3"],
]);
expect('bare "Memphis" heads the block below it', run("Memphis\nTulane -3").picks, [["Memphis", "Tulane -3"]]);
expect('"Chiefs ML" is a moneyline pick', run("Sharp Sam\nChiefs ML").picks, [["Sharp Sam", "Chiefs ML"]]);

// ---- 5. The "*" marker still forces a header, bet content or not ----
expect('"*Over Achievers" heads a block despite the market word', run("*Over Achievers\nChiefs ML").picks, [["Over Achievers", "Chiefs ML"]]);

// ---- 6. Narrow join: a bare name above a market-only line is one prop ----
expect('"James Cook" / "Touchdown" are read as one prop line', run("Sharp Sam\nJames Cook\nTouchdown").unresolved, [
  ["Sharp Sam", "James Cook Touchdown"],
]);
expect('"James Cook" / "Anytime TD" are read as one prop line', run("Sharp Sam\nJames Cook\nAnytime TD").unresolved, [
  ["Sharp Sam", "James Cook Anytime TD"],
]);
expect(
  'a next line with a number is a full pick: "James Cook" is its header',
  run("Sharp Sam\nJames Cook\nOver 45.5 Rushing Yards").unresolved,
  [["James Cook", "Over 45.5 Rushing Yards"]]
);
expect('a next line with a team is a full pick: "James Cook" is its header', run("Sharp Sam\nJames Cook\nBills ML").picks, [["James Cook", "Bills ML"]]);

// ---- 7. Picks with no header are held back, never "Unknown" ----
{
  const paste = "Memphis -6.5\nmike evans over 56.5 rec yards";
  const out = parseCatalog(paste, [], ROSTER_NAMES);
  expect("a headerless pick carries no capper", out.picks.map((p) => p.capperName), [""]);
  expect("a headerless unresolved line carries no capper", out.unresolvedCapperNames, [""]);
  const recovered = recoverUnresolvedLines(out.unresolved, out.unresolvedCapperNames, [], ROSTER, out.picks);
  expect("a pick the roster pass recovers stays without a capper", recovered.recovered.map((p) => p.capperName), [""]);
  const { withCapper, noCapper } = splitByCapper([...out.picks, ...recovered.recovered]);
  expect("the import holds every headerless pick back", [withCapper.length, noCapper], [0, ["Memphis -6.5", "mike evans over 56.5 rec yards"]]);
  expect("nothing anywhere is attributed to Unknown", JSON.stringify([out, recovered]).includes('"Unknown"'), false);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exit(1);
