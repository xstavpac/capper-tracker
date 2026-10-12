// Proof for what the server tells the Parlay slip, and what it accepts from it.
//
// 1. getSlipPickStatesAction: "started" comes from the game's real kickoff -
//    the board game the pick is on - not from the pick row's stored time. A
//    pick imported with no matched game stores its IMPORT time, which is
//    always in the past; it must stay on the slip until its game kicks off.
// 2. generatePoolSwapAction (Auto Hedge / Contrarian): the request names
//    picks by id, every pick is read from the database, and a request that is
//    oversized, malformed, or names a pick that isn't this user's own pending
//    pick is refused. Nothing a client says about a pick is used.
//
// The real actions and the real slip lookup (server/data/parlay-slip-picks.ts)
// run. Replaced: the signed-in user, prisma's pick rows, the Live board, and
// the record lookups. The clock is fixed.
// Run: npx tsx src/server/actions/parlay-slip-request-acceptance-test.ts
// Exits non-zero if any assertion fails.

import type { ExpanderPick } from "@/components/live/game-picks-expander";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const RealDate = Date;
const NOW_ISO = "2026-10-12T16:00:00.000Z"; // noon Eastern
const NOW = new RealDate(NOW_ISO).getTime();
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

const IMPORTED_AT = "2026-10-12T14:00:00.000Z"; // two hours ago
const KICKOFF_TONIGHT = "2026-10-12T23:05:00.000Z";
const KICKOFF_EARLIER = "2026-10-12T15:00:00.000Z"; // an hour ago
const TOMORROW = "2026-10-13T23:05:00.000Z";

type Row = Record<string, unknown> & { id: string; userId: string; status: string; gameTime: Date; sport: { name: string } };
function row(id: string, over: Record<string, unknown> = {}): Row {
  return {
    id, userId: "user-1", capperId: "capper-" + id,
    capper: { id: "capper-" + id, name: "Capper " + id, colorTag: null, isFavorite: false },
    sport: { name: "MLB" }, homeTeam: "New York Yankees", awayTeam: "Boston Red Sox",
    betType: "MONEYLINE", betDetail: "Yankees ML", odds: -120, line: null, period: "FULL_GAME", units: 1,
    datePosted: new RealDate("2026-10-12T13:00:00.000Z"), gameTime: new RealDate(KICKOFF_TONIGHT), status: "PENDING",
    pickedSide: null, mlFavoredSide: null,
    ...over,
  } as Row;
}

const ROWS: Row[] = [
  // On tonight's game, but stored with the time it was imported.
  row("unmatched", { gameTime: new RealDate(IMPORTED_AT) }),
  // On tonight's game, stored with the kickoff.
  row("matched"),
  // A second capper's total on tonight's game - an Auto Hedge alternate.
  row("over", { betType: "TOTAL", betDetail: "Over 8.5", line: 8.5, odds: -110 }),
  // On a game that kicked off an hour ago.
  row("live", { homeTeam: "New York Mets", awayTeam: "Atlanta Braves", betDetail: "Mets ML", gameTime: new RealDate(KICKOFF_EARLIER) }),
  // On no board game: one stored with a time still ahead, one with a time already past.
  row("offboard-ahead", { homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals", betDetail: "Cubs ML", gameTime: new RealDate(TOMORROW) }),
  row("offboard-past", { homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals", betDetail: "Cubs ML", gameTime: new RealDate(IMPORTED_AT) }),
  row("graded", { status: "WIN", sport: { name: "NFL" }, homeTeam: "Dallas Cowboys", awayTeam: "New York Giants", betDetail: "Cowboys ML" }),
  // Someone else's pick.
  row("theirs", { userId: "user-2" }),
];

type Game = { id: string; homeTeam: string; awayTeam: string; commenceTime: string };
const TONIGHT: Game = { id: "evt-tonight", homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", commenceTime: KICKOFF_TONIGHT };
const EARLIER: Game = { id: "evt-earlier", homeTeam: "New York Mets", awayTeam: "Atlanta Braves", commenceTime: KICKOFF_EARLIER };
const BOARD: [Game, string[]][] = [
  [TONIGHT, ["unmatched", "matched", "over"]],
  [EARLIER, ["live"]],
];

let rowReads = 0;
const boardLoads: string[] = [];
let recordReads = 0;
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../auth", { requireUser: async () => ({ id: "user-1" }) });
stub("../../lib/prisma", {
  prisma: {
    pick: {
      findMany: async ({ where }: { where: { userId: string; id: { in: string[] } } }) => {
        rowReads++;
        return ROWS.filter((r) => r.userId === where.userId && where.id.in.includes(r.id));
      },
    },
  },
});
stub("../data/odds", {
  LIVE_SPORTS: [
    { key: "americanfootball_nfl", label: "NFL" },
    { key: "baseball_mlb", label: "MLB" },
  ],
});
stub("../data/picks", {
  categoryRecordKey: (capperId: string, category: string) => capperId + "|" + category,
  getCapperLeagueRecords: async () => {
    recordReads++;
    return { records: {}, streaks: {}, last20: {} };
  },
  // The "over" capper qualifies (60%) in the OVER market - the one Auto Hedge alternate on tonight's game.
  getCapperCategoryRecords: async () => {
    recordReads++;
    return { "capper-over|OVER": { key: "OVER", label: "", wins: 6, losses: 4, pushes: 0, winPct: 60, count: 10 } };
  },
});

async function main() {
  // The board shows each pick under its game exactly as the app does (toExpanderPick).
  const { toExpanderPick } = await import("../data/expander-pick");
  stub("../data/live-board-picks", {
    getLiveBoardData: async (_userId: string, _key: string, label: string) => {
      boardLoads.push(label);
      const games = label === "MLB" ? BOARD : [];
      return {
        odds: games.map(([g]) => g),
        scores: [],
        expanderPicksByGame: games.map(([g, ids]) =>
          ids.map((id) => toExpanderPick(ROWS.find((r) => r.id === id) as never, g, "baseball_mlb", "MLB"))
        ),
      };
    },
  });
  const { getSlipPickStatesAction } = await import("./parlay-slip");
  const { generatePoolSwapAction } = await import("./parlay-pool-generator");
  const { reconcileSlip } = await import("../../lib/parlay/slip-reconcile");

  // ---------------------------------------------------------------------
  // 1. "Started" is decided from the real kickoff
  // ---------------------------------------------------------------------
  const states = (await getSlipPickStatesAction(ROWS.map((r) => r.id))) as Record<string, { status: string; started: boolean | null; kickoff?: string | null }>;
  const s = (id: string) => states[id];
  const show = (id: string) => JSON.stringify(s(id));

  check("no matched game at import (stored time = import time): NOT started before the real kickoff", s("unmatched")?.started === false, show("unmatched"));
  check("...and its kickoff is the game's, not the import time", s("unmatched")?.kickoff === KICKOFF_TONIGHT, show("unmatched"));
  check("stored with the kickoff: not started", s("matched")?.started === false && s("matched")?.kickoff === KICKOFF_TONIGHT, show("matched"));
  check("on a game that has kicked off: started", s("live")?.started === true, show("live"));
  check("on no board game, stored time still ahead: not started, that time is the kickoff", s("offboard-ahead")?.started === false && s("offboard-ahead")?.kickoff === TOMORROW, show("offboard-ahead"));
  check("on no board game, stored time already past: the server does not guess", s("offboard-past")?.started === null && s("offboard-past")?.kickoff === null, show("offboard-past"));
  check("a graded pick reports its result", s("graded")?.status === "WIN", show("graded"));
  check("someone else's pick reads as missing", s("theirs") === undefined, show("theirs"));
  check("only the pending picks' leagues are loaded (MLB, not NFL)", boardLoads.join() === "MLB", `loads=[${boardLoads.join()}]`);

  // What the slip does with that answer. Each leg carries the kickoff it was added with.
  const leg = (id: string, gameTime: string) => {
    const r = ROWS.find((x) => x.id === id)!;
    return { ...toExpanderPick(r as never, { ...TONIGHT, commenceTime: gameTime }, "baseball_mlb", "MLB"), gameTime } as ExpanderPick;
  };
  const slip = [leg("unmatched", KICKOFF_TONIGHT), leg("matched", KICKOFF_TONIGHT), leg("live", KICKOFF_EARLIER), leg("offboard-past", TOMORROW)];
  const { kept, pruned } = reconcileSlip(slip, states as never, NOW);
  const keptIds = kept.map((p) => p.pickId).join();
  check("slip: the pick with no matched game is NOT pruned before its real kickoff", kept.some((p) => p.pickId === "unmatched"), `kept=[${keptIds}] pruned=[${pruned.map((p) => p.pickId + ":" + p.result).join()}]`);
  check("slip: its leg still carries the real kickoff, not the import time", kept.find((p) => p.pickId === "unmatched")?.gameTime === KICKOFF_TONIGHT, String(kept.find((p) => p.pickId === "unmatched")?.gameTime));
  check("slip: the pick whose game has kicked off is pruned as Started", pruned.find((p) => p.pickId === "live")?.result === "Started");
  check("slip: with no board game, the leg's own kickoff decides and is kept", kept.find((p) => p.pickId === "offboard-past")?.gameTime === TOMORROW, `kept=[${keptIds}]`);

  // ---------------------------------------------------------------------
  // 2. The pool action reads every pick itself
  // ---------------------------------------------------------------------
  type Outcome = { error?: string; parlayA?: { legs: { gameId: string; top: { pick: ExpanderPick } }[] }; swap?: { legs: { swap: { pick: ExpanderPick } | null }[] } };
  const reads = () => rowReads + boardLoads.length + recordReads;
  // The action's declared argument type is what an honest client sends; these are not all honest.
  const call = async (pickIds: unknown, legCount = 2, mode = "AUTO_HEDGE"): Promise<Outcome & { threw?: string }> => {
    try {
      return (await generatePoolSwapAction(pickIds as string[], legCount, mode as "AUTO_HEDGE")) as Outcome;
    } catch (e) {
      return { threw: String(e) };
    }
  };
  const rejected = (o: Outcome & { threw?: string }) => typeof o.error === "string" && o.error.length > 0 && !o.parlayA;
  const describe = (o: Outcome & { threw?: string }) =>
    o.threw ? "threw " + o.threw.slice(0, 80) : o.error ? "error: " + o.error : "built " + (o.parlayA?.legs.length ?? "?") + " leg(s)";

  const ok = await call(["unmatched"], 1);
  const okLeg = ok.parlayA?.legs[0]?.top.pick;
  check("a request of the user's own pending pick ids is built", !ok.error && ok.parlayA?.legs.length === 1, describe(ok));
  check("...from the database row, on its board game with the real kickoff", okLeg?.capperName === "Capper unmatched" && okLeg?.odds === -120 && okLeg?.gameTime === KICKOFF_TONIGHT && ok.parlayA?.legs[0]?.gameId === "evt-tonight", JSON.stringify(okLeg && { capperName: okLeg.capperName, odds: okLeg.odds, gameTime: okLeg.gameTime }));
  check("...and Auto Hedge finds the alternate on that game, though the pick's stored time is the import time", ok.swap?.legs[0]?.swap?.pick.pickId === "over", String(ok.swap?.legs[0]?.swap?.pick.pickId));

  let before = reads();
  const forged = { ...leg("unmatched", TOMORROW), capperName: "Forged Capper", odds: 9999, homeTeam: "Nobody", status: "PENDING" };
  const tampered = await call([forged], 1);
  check("tampered: client-built pick objects are rejected, not built from", rejected(tampered), describe(tampered) + (tampered.parlayA ? ` capper=${tampered.parlayA.legs[0]?.top.pick.capperName} odds=${tampered.parlayA.legs[0]?.top.pick.odds}` : ""));
  check("tampered: ...before anything is read", reads() === before, `reads=${reads() - before}`);

  before = boardLoads.length + recordReads;
  const notMine = await call(["unmatched", "theirs"]);
  check("tampered: a request naming someone else's pick is rejected whole", rejected(notMine), describe(notMine));
  const madeUp = await call(["unmatched", "no-such-pick"]);
  check("tampered: a request naming a pick that doesn't exist is rejected whole", rejected(madeUp), describe(madeUp));
  const gradedPick = await call(["unmatched", "graded"]);
  check("a request naming a graded pick is rejected, not built without it", rejected(gradedPick), describe(gradedPick));
  check("...none of those load a board or a record", boardLoads.length + recordReads === before, `loads=${boardLoads.length + recordReads - before}`);

  before = reads();
  const oversized = await call(Array.from({ length: 101 }, (_, i) => "pick" + i), 2);
  check("oversized: 101 picks in one request is rejected", rejected(oversized), describe(oversized));
  check("oversized: ...before anything is read", reads() === before, `reads=${reads() - before}`);
  const notAList = await call("unmatched");
  const longId = await call(["x".repeat(500)]);
  const badMode = await call(["unmatched"], 1, "DROP TABLE");
  check("malformed: not a list, an over-long id, an unknown mode are each rejected", rejected(notAList) && rejected(longId) && rejected(badMode), [notAList, longId, badMode].map(describe).join(" | "));

  const repeated = await call(["unmatched", "unmatched", "over"], 2);
  check("a repeated id is counted once", !repeated.error && repeated.parlayA?.legs.map((l) => l.top.pick.pickId).sort().join() === "over,unmatched", describe(repeated));

  const offBoard = await call(["offboard-ahead"], 1);
  const offLeg = offBoard.parlayA?.legs[0];
  check("a pick on no board game is still built, from its own row, with no alternate", !offBoard.error && offLeg?.top.pick.homeTeam === "Chicago Cubs" && offLeg?.top.pick.gameTime === TOMORROW && offBoard.swap?.legs[0]?.swap === null, describe(offBoard));

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
