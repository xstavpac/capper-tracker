// Proof for slip-send-legs.ts: the Parlay slip's picks handed to "Send to
// FanDuel". Pure: no DB, no network. Section 1 is the mapper itself. Section 2
// sends what it produced through the same buildFanDuelLink a built parlay
// goes through, with the Odds API faked (FanDuel ids as in
// fanduel-link-acceptance-test.ts) - the server's own read of each pick by id
// is stood in for by looking the pick up in the slip, field for field as
// server/data/fanduel-link.ts's loadLegs fills a leg.
// Run with:
//   npx tsx src/lib/parlay/slip-send-legs-acceptance-test.ts
import { slipSendLegs } from "@/lib/parlay/slip-send-legs";
import { buildFanDuelLink, type FanDuelDeps, type FanDuelLegInput, type FanDuelMarket } from "@/lib/parlay/fanduel-link";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const NOW = new Date("2026-10-12T20:00:00Z");
const KICKOFF = "2026-10-13T00:15:00Z";

function slipPick(over: Partial<ExpanderPick>): ExpanderPick {
  return {
    pickId: "p1",
    capperId: "c1",
    capperName: "Capper",
    capperColorTag: null,
    capperIsFavorite: false,
    category: null,
    leagueName: "NFL",
    gameId: "g-buf-lar",
    gameLabel: "Bills @ Rams",
    betDetail: "Bills ML",
    odds: 150,
    units: 1,
    status: "PENDING",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    rawBetDetail: "Bills ML",
    line: null,
    homeTeam: "Los Angeles Rams",
    awayTeam: "Buffalo Bills",
    gameTime: KICKOFF,
    ...over,
  } as ExpanderPick;
}

const billsMl = slipPick({ pickId: "bills-ml", betDetail: "Bills ML", odds: 150 });
// FanDuel has Bills +3.5 only: +4 goes at the nearest line.
const billsPlus4 = slipPick({ pickId: "bills-plus-4", betDetail: "Bills +4", betType: "SPREAD", rawBetDetail: "Bills +4", line: 4, odds: -110 });
// NRFI has no FanDuel market here: not sent, with why.
const nrfi = slipPick({ pickId: "nrfi", betDetail: "NRFI", betType: "NRFI", rawBetDetail: "NRFI", odds: -120 });
// A total FanDuel has no line within reach of.
const farTotal = slipPick({ pickId: "over-60", betDetail: "Over 60.5", betType: "TOTAL", rawBetDetail: "Over 60.5", line: 60.5, odds: -110 });

// ---------------------------------------------------------------------
// 1. The mapper
// ---------------------------------------------------------------------
check("empty slip: no legs", slipSendLegs([]), []);
check("a leg: its pick id, the bet text shown, and its game", slipSendLegs([billsMl]), [
  { pickId: "bills-ml", betDetail: "Bills ML", gameId: "g-buf-lar", gameLabel: "Bills @ Rams" },
]);
check(
  "every slip pick goes, in slip order - including ones FanDuel won't take (the server says why, not the mapper)",
  slipSendLegs([billsPlus4, nrfi, billsMl, farTotal]).map((l) => l.pickId),
  ["bills-plus-4", "nrfi", "bills-ml", "over-60"]
);
check(
  "nothing but the shown fields is sent along (no odds, line or teams leave the slip)",
  Object.keys(slipSendLegs([billsPlus4])[0]).sort(),
  ["betDetail", "gameId", "gameLabel", "pickId"]
);

// ---------------------------------------------------------------------
// 2. Through the same FanDuel matching a built parlay uses
// ---------------------------------------------------------------------
const link = (marketId: string, selectionId: string) =>
  `https://sportsbook.fanduel.com/addToBetslip?marketId=${marketId}&selectionId=${selectionId}`;
const MARKETS: FanDuelMarket[] = [
  {
    key: "h2h",
    sid: null,
    outcomes: [
      { name: "Buffalo Bills", price: 154, sid: "50203", link: link("42.612291277", "50203") },
      { name: "Los Angeles Rams", price: -184, sid: "10782388", link: link("42.612291277", "10782388") },
    ],
  },
  {
    key: "spreads",
    sid: null,
    outcomes: [
      { name: "Buffalo Bills", price: -115, point: 3.5, sid: "50203", link: link("42.612291278", "50203") },
      { name: "Los Angeles Rams", price: -105, point: -3.5, sid: "10782388", link: link("42.612291278", "10782388") },
    ],
  },
  {
    key: "totals",
    sid: null,
    outcomes: [
      { name: "Over", price: -110, point: 54.5, sid: "7017916", link: link("42.612291280", "7017916") },
      { name: "Under", price: -108, point: 54.5, sid: "7017917", link: link("42.612291280", "7017917") },
    ],
  },
];
const deps: FanDuelDeps = {
  now: NOW,
  getEvents: async (sportKey) =>
    sportKey === "americanfootball_nfl"
      ? [{ id: "evt-buf-lar", sportKey, homeTeam: "Los Angeles Rams", awayTeam: "Buffalo Bills", commenceTime: KICKOFF }]
      : [],
  getEventMarkets: async (_s, _e, keys) => MARKETS.filter((m) => keys.includes(m.key)),
};

// The server's read of a pick named by id, as loadLegs builds it.
function asServerLeg(p: ExpanderPick): FanDuelLegInput {
  return {
    pickId: p.pickId,
    sportKey: p.leagueName === "NFL" ? "americanfootball_nfl" : null,
    leagueName: p.leagueName,
    betType: p.betType,
    period: p.period,
    betDetail: p.rawBetDetail,
    line: p.line,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    gameTime: p.gameTime,
    odds: p.odds,
    onBoard: true,
  };
}

async function send(slip: ExpanderPick[]) {
  const byId = new Map(slip.map((p) => [p.pickId, p]));
  const sent = slipSendLegs(slip);
  return buildFanDuelLink(sent.map((l) => asServerLeg(byId.get(l.pickId)!)), deps);
}

(async () => {
  const normal = await send([billsMl]);
  check("normal leg: matched at FanDuel's price, in the link", [normal.legs.map((l) => [l.pickId, l.status, l.fanDuelOdds]), Array.from(new URL(normal.url!).searchParams.values())], [
    [["bills-ml", "matched", 154]],
    ["42.612291277", "50203"],
  ]);

  const nearest = await send([billsPlus4]);
  check(
    "nearest-line leg: +4 goes at FanDuel's +3.5, marked as the harder line",
    [nearest.legs[0].status, nearest.legs[0].fanDuelOdds, nearest.legs[0].sentLine, Array.from(new URL(nearest.url!).searchParams.values())],
    ["adjusted", -115, { pick: 4, fanDuel: 3.5, side: null, worse: true }, ["42.612291278", "50203"]]
  );

  const mixed = await send([billsPlus4, nrfi, billsMl, farTotal]);
  check(
    "unmappable legs are listed as not sent with why; the rest still go, in slip order",
    mixed.legs.map((l) => [l.pickId, l.status]),
    [
      ["bills-plus-4", "adjusted"],
      ["nrfi", "unsupported"],
      ["bills-ml", "matched"],
      ["over-60", "not_found"],
    ]
  );
  check("the link holds only the sent legs", Array.from(new URL(mixed.url!).searchParams.values()), ["42.612291278", "50203", "42.612291277", "50203"]);
  check("each not-sent leg carries a reason", mixed.legs.filter((l) => l.status !== "matched" && l.status !== "adjusted").every((l) => !!l.reason), true);

  const nothing = await send([nrfi]);
  check("only unmappable legs: no link", [nothing.url, nothing.legs.map((l) => l.status)], [null, ["unsupported"]]);

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
})();
