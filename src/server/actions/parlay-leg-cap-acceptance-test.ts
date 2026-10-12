// Proof that both Parlay Generator server actions hold the 20-leg cap:
// autoGenerateParlayAction (Auto-Generate) and generatePoolSwapAction (Auto
// Hedge / Contrarian over the slip). 20 legs is built in full; 21 is refused
// with "20 legs max" before any data is read - not built as 20, not built as 21.
//
// The real actions run. Only what they load from is replaced: the signed-in
// user, the live board, and the record lookups. The clock is fixed at noon
// Eastern so Auto-Generate's own "today, unstarted" rule always sees the
// fixture slate. The numbers are written out here on purpose, not imported
// from lib/parlay/leg-cap.ts: this file states the rule, the code has to meet it.
// Run: npx tsx src/server/actions/parlay-leg-cap-acceptance-test.ts
// Exits non-zero if any assertion fails.

import type { ExpanderPick } from "@/components/live/game-picks-expander";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const CAP = 20;
const CAP_MESSAGE = "20 legs max";

const RealDate = Date;
const NOW = new RealDate("2026-10-12T16:00:00.000Z").getTime(); // noon Eastern
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW);
    else super(...(args as [number]));
  }
  static now() {
    return NOW;
  }
}
globalThis.Date = FixedDate as DateConstructor;

const GAME_TIME = "2026-10-12T23:05:00.000Z"; // 7:05pm Eastern, same day
const POSTED = "2026-10-12T13:00:00.000Z";
const SLATE_SIZE = 25;

function pick(i: number): ExpanderPick {
  const home = "Home" + i;
  const away = "Away" + i;
  return {
    pickId: "pick" + i, capperId: "capper" + i, capperName: "Capper " + i, capperColorTag: null, capperIsFavorite: false,
    category: null, leagueName: "MLB", gameId: "game" + i, gameLabel: away + " @ " + home, betDetail: home + " ML",
    odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE", period: "FULL_GAME", rawBetDetail: home + " ML", line: null,
    homeTeam: home, awayTeam: away, gameTime: GAME_TIME, teamGroup: "HOME", teamLabel: home, teamColor: null,
    datePosted: POSTED,
  };
}
// One pick in each of 25 games: more than the cap, so a 20-leg request is
// never short for lack of games.
const SLATE = Array.from({ length: SLATE_SIZE }, (_, i) => pick(i + 1));

let boardLoads = 0;
let recordLoads = 0;
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../auth", { requireUser: async () => ({ id: "user-1" }) });
stub("../data/odds", { LIVE_SPORTS: [{ key: "baseball_mlb", label: "MLB" }] });
stub("../data/live-board-picks", {
  getLiveBoardData: async () => {
    boardLoads++;
    return {
      odds: SLATE.map((p) => ({ id: p.gameId, commenceTime: p.gameTime, homeTeam: p.homeTeam, awayTeam: p.awayTeam })),
      scores: [],
      expanderPicksByGame: SLATE.map((p) => [p]),
    };
  },
});
stub("../data/picks", {
  getCapperLeagueRecords: async () => {
    recordLoads++;
    return { records: {}, streaks: {}, last20: {} };
  },
  getCapperCategoryRecords: async () => {
    recordLoads++;
    return {};
  },
});

async function main() {
  const { autoGenerateParlayAction } = await import("./parlay-generator");
  const { generatePoolSwapAction } = await import("./parlay-pool-generator");
  const loads = () => boardLoads + recordLoads;
  const describe = (r: object) => JSON.stringify(r).slice(0, 120);

  // ---------------------------------------------------------------------
  // Auto-Generate
  // ---------------------------------------------------------------------
  const auto20 = await autoGenerateParlayAction(["MLB"], CAP);
  check(
    "Auto-Generate: 20 legs requested, 20 legs built",
    !("error" in auto20) && auto20.parlayA.requested === CAP && auto20.parlayA.legs.length === CAP,
    "error" in auto20 ? describe(auto20) : `requested=${auto20.parlayA.requested} legs=${auto20.parlayA.legs.length}`
  );
  check(
    "Auto-Generate: the Hedge and Contrarian built with it are 20 legs too",
    !("error" in auto20) && auto20.hedge.legs.length === CAP && auto20.contrarian.legs.length === CAP,
    "error" in auto20 ? "" : `hedge=${auto20.hedge.legs.length} contrarian=${auto20.contrarian.legs.length}`
  );

  let before = loads();
  const auto21 = await autoGenerateParlayAction(["MLB"], CAP + 1);
  check(
    'Auto-Generate: 21 legs is rejected with "20 legs max"',
    "error" in auto21 && auto21.error === CAP_MESSAGE,
    "error" in auto21 ? auto21.error : `built a parlay: requested=${auto21.parlayA.requested} legs=${auto21.parlayA.legs.length}`
  );
  check("Auto-Generate: a rejected request builds nothing and reads nothing", !("parlayA" in auto21) && loads() === before, `loads=${loads() - before}`);

  // ---------------------------------------------------------------------
  // Auto Hedge / Contrarian over the slip
  // ---------------------------------------------------------------------
  const labels = { AUTO_HEDGE: "Auto Hedge", CONTRARIAN: "Contrarian" } as const;
  for (const mode of ["AUTO_HEDGE", "CONTRARIAN"] as const) {
    const swap20 = await generatePoolSwapAction(SLATE.slice(0, CAP), CAP, mode);
    check(
      `${labels[mode]}: 20 legs requested, 20 legs built`,
      !("error" in swap20) && swap20.requested === CAP && swap20.parlayA.legs.length === CAP && swap20.swap.legs.length === CAP && swap20.shortfall === 0,
      "error" in swap20 ? describe(swap20) : `requested=${swap20.requested} primary=${swap20.parlayA.legs.length} swap=${swap20.swap.legs.length}`
    );

    before = loads();
    const swap21 = await generatePoolSwapAction(SLATE.slice(0, CAP + 1), CAP + 1, mode);
    check(
      `${labels[mode]}: 21 legs is rejected with "20 legs max"`,
      "error" in swap21 && swap21.error === CAP_MESSAGE,
      "error" in swap21 ? swap21.error : `built a parlay: requested=${swap21.requested} primary=${swap21.parlayA.legs.length}`
    );
    check(`${labels[mode]}: a rejected request builds nothing and reads nothing`, !("parlayA" in swap21) && loads() === before, `loads=${loads() - before}`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
