// generateParlayAction refuses a malformed or oversized request BEFORE reading
// anything: no slip rows, no boards, no record bundle. Only the data modules
// are replaced, with counting stand-ins. Pure - no DB. Run with:
//   npx tsx src/server/actions/parlay-generate-request-acceptance-test.ts
let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
let reads = 0;
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../auth", { requireUser: async () => ({ id: "user-1" }) });
stub("../data/parlay-slip-picks", {
  getOwnedSlipPickRows: async () => (reads++, []),
  loadSlipBoards: async () => (reads++, []),
  picksOnBoards: () => new Map(),
  offBoardSlipPick: () => null,
});
stub("../data/picks", { getCapperRecordBundle: async () => (reads++, { leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords: {} }) });

(async () => {
  const { generateParlayAction } = await import("./parlay-generate");
  const settings = { legCount: 3, maxLegsPerGame: 1, include: "ALL", gameLinesPct: null, fillFrom: "BEST_AVAILABLE" };
  const ok = { leagues: ["NFL"], slipPickIds: [], targets: [], settings };
  const bad: [string, unknown, string][] = [
    ["not an object", null, "isn't valid"],
    ["an unknown league", { ...ok, leagues: ["XFL"] }, "isn't valid"],
    ["a pick id that isn't a string", { ...ok, slipPickIds: [7] }, "isn't valid"],
    ["an over-long pick id", { ...ok, slipPickIds: ["x".repeat(65)] }, "isn't valid"],
    ["101 slip picks", { ...ok, slipPickIds: Array.from({ length: 101 }, (_, i) => "p" + i) }, "100 at most"],
    ["a target in an unknown league", { ...ok, targets: [{ gameId: "g1", leagueName: "XFL" }] }, "isn't valid"],
    ["26 legs", { ...ok, settings: { ...settings, legCount: 26 } }, "25 legs max"],
    ["no leg count", { ...ok, settings: { ...settings, legCount: "3" } }, "isn't valid"],
  ];
  for (const [label, req, says] of bad) {
    const r = (await generateParlayAction(req as never)) as { error?: string };
    check(`refused: ${label}`, typeof r.error === "string" && r.error.includes(says), JSON.stringify(r));
  }
  check("a refused request reads nothing", reads === 0, `reads=${reads}`);
  const fine = await generateParlayAction(ok as never);
  check("a valid empty request is answered (and reads)", !("error" in fine) && reads > 0, `reads=${reads}`);
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
