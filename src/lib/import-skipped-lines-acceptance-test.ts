// Proof for the import skipped-line log. Run with:
//   npx tsx src/lib/import-skipped-lines-acceptance-test.ts
//
// Pure: prisma.importSkippedLine.createMany is swapped for a spy (same
// convention as feature-flags-acceptance-test.ts), so no database is touched.
// The resolution-time stages (GAME_UNMATCHED, TOTAL_NO_LINE, INVALID_ODDS,
// DOUBLEHEADER_FINAL, DUPLICATE_SKIPPED) are exercised through the shared
// recorder with the exact entry shapes bulk-picks.ts builds; the action itself
// needs live odds feeds and is not run here.
import { parseCatalog } from "@/lib/parse-catalog";
import { computeMarketHint, looksPickLikeHeader } from "@/lib/market-hint";
import { prisma } from "@/lib/prisma";
import { recordImportSkippedLines, parseSkippedLineEntries, toSkippedLineRows } from "@/server/data/import-skipped-lines";
import { resolveReportRange } from "@/server/data/import-skipped-lines-report";
import type { ImportSkipStage } from "@prisma/client";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

type Row = { userId: string; capperName: string; rawText: string; guessedSport: string | null; stage: ImportSkipStage; reason: string | null; marketHint: string | null };
const target = prisma.importSkippedLine as unknown as { createMany: unknown };
const original = target.createMany;
let calls: Row[][] = [];
function spy(impl?: () => Promise<unknown>) {
  calls = [];
  target.createMany = async (args: { data: Row[] }) => {
    calls.push(args.data);
    if (impl) return impl();
    return { count: args.data.length };
  };
}

const PASTE = `KRASH
Ivan Demidov 2+ shots on goal
Darren Raddysh 2+ shots on goal
Cole Caufield 3+ shots on goal
RBS
William Nylander anytime goal scorer
Mika Zibanejad anytime goal scorer
Leon Draisaitl anytime goal scorer`;

async function main() {
  // ---- parseCatalog: the reported paste ----
  // The prop-safety fix (this PR) routes every one of these lines to
  // `unresolved` instead of eating it as a capper header, so nothing is
  // silently dropped any more; the parse-time log maps them to PROP_UNSUPPORTED.
  const out = parseCatalog(PASTE, []);
  const proplines = PASTE.split("\n").filter((l) => l !== "KRASH" && l !== "RBS");
  expect("paste yields 0 droppedAsHeaders", out.droppedAsHeaders.length, 0);
  expect("paste yields 0 droppedInline", out.droppedInline.length, 0);
  expect("all 6 prop lines are unresolved, with their exact text", out.unresolved, proplines);
  expect("first three attributed to KRASH, last three to RBS", out.unresolvedCapperNames, ["KRASH", "KRASH", "KRASH", "RBS", "RBS", "RBS"]);
  expect("KRASH, RBS never appear as unresolved lines", out.unresolved.some((l) => l === "KRASH" || l === "RBS"), false);
  expect("no picks or parlays produced", [out.picks.length, out.parlays.length], [0, 0]);

  // The parse-time log entries for that paste: 6 PROP_UNSUPPORTED rows, none PARSE_SILENT.
  const pasteEntries = parseSkippedLineEntries({
    silent: [...out.droppedAsHeaders, ...out.droppedInline].map((d) => ({ text: d.text, capperName: d.capperName, reason: "n/a" })),
    unresolved: out.unresolved.map((text, i) => ({ text, capperName: out.unresolvedCapperNames[i] })),
    recoveryRan: true,
  });
  expect("KRASH/RBS paste logs 6 PROP_UNSUPPORTED rows", pasteEntries.filter((e) => e.stage === "PROP_UNSUPPORTED").length, 6);
  expect("KRASH/RBS paste logs 0 PARSE_SILENT rows", pasteEntries.filter((e) => e.stage === "PARSE_SILENT").length, 0);
  expect("KRASH/RBS paste logs nothing else", pasteEntries.length, 6);
  expect("PROP_UNSUPPORTED rows carry the NHL reason and their capper", pasteEntries.map((e) => [e.capperName, e.reason]), [
    ["KRASH", "NHL player props aren't supported yet"],
    ["KRASH", "NHL player props aren't supported yet"],
    ["KRASH", "NHL player props aren't supported yet"],
    ["RBS", "NHL player props aren't supported yet"],
    ["RBS", "NHL player props aren't supported yet"],
    ["RBS", "NHL player props aren't supported yet"],
  ]);
  // Every family of "isn't supported yet" reason maps to the same stage; a plain miss does not.
  const reasonCases: [string, string][] = [
    ["Chris Sale over 5.5 K", "MLB player props aren't supported yet"],
    ["NBA LeBron James over 25.5 points", "NBA player props aren't supported yet"],
    ["WNBA A'ja Wilson over 9.5 rebounds", "WNBA player props aren't supported yet"],
    ["Patrick Mahomes over 22.5 passing completions", "This NFL prop market isn't supported yet"],
    ["Lakers over 45.5 rebounds", "Team stat totals aren't supported yet"],
    ["Yankees vs Red Sox over 20.5 hits", "Game stat totals aren't supported yet"],
    ["Jalen Brunson over 40.5 PRA", "Player prop not supported yet"],
  ];
  for (const [text, reason] of reasonCases) {
    const [entry] = parseSkippedLineEntries({ silent: [], unresolved: [{ text, capperName: "Cap" }], recoveryRan: true });
    expect(`"${text}" -> PROP_UNSUPPORTED / "${reason}"`, [entry.stage, entry.reason], ["PROP_UNSUPPORTED", reason]);
  }
  expect(
    "a plain unresolved miss stays RECOVERY_UNRESOLVED",
    parseSkippedLineEntries({ silent: [], unresolved: [{ text: "Foo Bar over 3.5", capperName: "Cap" }], recoveryRan: true })[0].stage,
    "RECOVERY_UNRESOLVED"
  );

  // A prop line no longer becomes the active header: the next real pick keeps its real capper.
  const mixed = parseCatalog(`KRASH\nIvan Demidov 2+ shots on goal\nYankees ML`, []);
  expect("pick after a prop line is attributed to KRASH, not to the prop line", mixed.picks.map((p) => [p.capperName, p.description]), [["KRASH", "Yankees ML"]]);
  expect("plain capper header is not dropped", parseCatalog("Bambino Bets\nYankees ML", []).droppedAsHeaders, []);
  expect("header with a digit (\"Sharp Guru 2\") is a (tolerated) false positive", parseCatalog("Sharp Guru 2\nYankees ML", []).droppedAsHeaders.length, 1);
  const inline = parseCatalog(`Sharp Sam Some Guy 2+ wins`, ["Sharp Sam"]);
  expect("line after a saved capper's name that resolves to nothing is droppedInline", inline.droppedInline, [{ text: "Sharp Sam Some Guy 2+ wins", capperName: "Sharp Sam" }]);

  // ---- marketHint ----
  expect("hint: shots on goal", computeMarketHint("Ivan Demidov 2+ shots on goal"), "shots on goal");
  expect("hint: anytime scorer", computeMarketHint("William Nylander anytime goal scorer"), "anytime scorer");
  expect("hint: strikeouts", computeMarketHint("Cole over 6.5 strikeouts"), "strikeouts");
  expect("hint: total bases", computeMarketHint("Judge over 1.5 total bases"), "total bases");
  expect("hint: f5", computeMarketHint("Yankees F5 ML"), "f5");
  expect("hint: nrfi", computeMarketHint("Bambino NRFI"), "nrfi");
  expect("hint: none", computeMarketHint("Bambino Bets"), null);
  expect("looksPickLikeHeader: plain name", looksPickLikeHeader("RBS"), false);

  // ---- parse-time stages ----
  spy();
  const parseEntries = parseSkippedLineEntries({
    silent: [{ text: "Ivan Demidov 2+ shots on goal", capperName: "KRASH", reason: "Read as a capper header but looks like a pick" }],
    unresolved: [{ text: "Foo Bar over 3.5", capperName: "RBS" }],
    recoveryRan: true,
  });
  await recordImportSkippedLines("user-1", parseEntries);
  expect("parse-time write is one batched createMany", calls.length, 1);
  expect("PARSE_SILENT row", calls[0][0], {
    userId: "user-1", capperName: "KRASH", rawText: "Ivan Demidov 2+ shots on goal", guessedSport: null,
    stage: "PARSE_SILENT", reason: "Read as a capper header but looks like a pick", marketHint: "shots on goal",
  });
  expect("recovery leftover is RECOVERY_UNRESOLVED", [calls[0][1].stage, calls[0][1].marketHint], ["RECOVERY_UNRESOLVED", "over/under"]);
  expect("recovery failure downgrades to PARSE_UNRESOLVED", parseSkippedLineEntries({ silent: [], unresolved: [{ text: "Foo Bar over 3.5", capperName: "A" }], recoveryRan: false })[0].stage, "PARSE_UNRESOLVED");

  // ---- resolution-time stages: one batch, each stage's row ----
  spy();
  const stages: ImportSkipStage[] = ["GAME_UNMATCHED", "TOTAL_NO_LINE", "INVALID_ODDS", "DOUBLEHEADER_FINAL", "DUPLICATE_SKIPPED"];
  await recordImportSkippedLines("user-2", stages.map((stage) => ({ stage, capperName: "Cap", rawText: "Yankees F5 ML", guessedSport: "MLB", reason: "why " + stage })));
  expect("resolution-time write is one batched createMany", calls.length, 1);
  expect("each resolution stage writes its row", calls[0].map((r) => r.stage), stages);
  expect("resolution row carries capper, sport, reason, hint, userId", calls[0][2], {
    userId: "user-2", capperName: "Cap", rawText: "Yankees F5 ML", guessedSport: "MLB", stage: "INVALID_ODDS", reason: "why INVALID_ODDS", marketHint: "f5",
  });
  expect("PROP_UNSUPPORTED is a writable stage", toSkippedLineRows("u", [{ stage: "PROP_UNSUPPORTED", capperName: "C", rawText: "A over 2.5 sog" }])[0].stage, "PROP_UNSUPPORTED");

  // ---- logging failure never breaks the import ----
  spy(async () => {
    throw new Error("db down");
  });
  const origError = console.error;
  console.error = () => {};
  let threw = false;
  try {
    await recordImportSkippedLines("user-3", [{ stage: "GAME_UNMATCHED", capperName: "C", rawText: "x" }]);
  } catch {
    threw = true;
  }
  console.error = origError;
  expect("a createMany failure is swallowed", threw, false);
  spy();
  await recordImportSkippedLines("user-3", []);
  await recordImportSkippedLines("user-3", [{ stage: "GAME_UNMATCHED", capperName: "C", rawText: "   " }]);
  expect("empty / blank entries write nothing", calls.length, 0);

  // ---- report date range ----
  const now = new Date("2026-09-29T12:00:00.000Z");
  const def = resolveReportRange(undefined, undefined, now);
  expect("default range is last 30 days", Math.round((def.to.getTime() - def.from.getTime()) / 86400000), 30);
  const custom = resolveReportRange("2026-09-01", "2026-09-10", now);
  expect("explicit range: from start of day, to inclusive end of day", [custom.from.toISOString(), custom.to.toISOString()], ["2026-09-01T00:00:00.000Z", "2026-09-11T00:00:00.000Z"]);
  expect("garbage dates fall back to default", resolveReportRange("nope", "2026-13-99", now).fromInput, def.fromInput);

  target.createMany = original;
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
}
main().then(() => process.exit(failures > 0 ? 1 : 0));
