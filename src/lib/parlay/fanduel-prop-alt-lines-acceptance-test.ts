// Proof for player-prop alternate lines in Send to FanDuel: a prop whose exact line is missing from the main
// market is looked up on the "<key>_alternate" market before the nearest-line "adjusted" fallback. The alternate
// market is fetched only when the main one misses. Pure: no DB, no network; getEvents / getEventMarkets are fakes
// that count calls. Run with:
//   npx tsx src/lib/parlay/fanduel-prop-alt-lines-acceptance-test.ts
import { buildFanDuelLink, fanDuelLegTarget, type FanDuelDeps, type FanDuelEvent, type FanDuelLegInput, type FanDuelMarket } from "@/lib/parlay/fanduel-link";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NOW = new Date("2026-11-15T18:00:00Z");
const GAME_TIME = "2026-11-16T01:00:00Z";
const EVENT: FanDuelEvent = { id: "evt-nba", sportKey: "basketball_nba", homeTeam: "Los Angeles Lakers", awayTeam: "Portland Trail Blazers", commenceTime: GAME_TIME };
const link = (m: string, s: string) => `https://sportsbook.fanduel.com/addToBetslip?marketId=${m}&selectionId=${s}`;
const ladder = (key: string, lines: number[], base: number): FanDuelMarket => ({
  key,
  sid: null,
  outcomes: lines.flatMap((p, i) => [
    { name: "Over", description: "Deandre Ayton", price: -110, point: p, sid: String(base + 2 * i), link: link(String(base), String(base + 2 * i)) },
    { name: "Under", description: "Deandre Ayton", price: -110, point: p, sid: String(base + 2 * i + 1), link: link(String(base), String(base + 2 * i + 1)) },
  ]),
});

const propLeg = (pickId: string, over: Partial<FanDuelLegInput> = {}): FanDuelLegInput => ({
  pickId,
  sportKey: "basketball_nba",
  leagueName: "NBA",
  betType: "PLAYER_PROP",
  period: "FULL_GAME",
  betDetail: "Deandre Ayton Over 11.5 Rebounds",
  line: null,
  homeTeam: EVENT.homeTeam,
  awayTeam: EVENT.awayTeam,
  gameTime: GAME_TIME,
  odds: -110,
  oddsSource: "STATED",
  onBoard: true,
  ...over,
});

async function run(legs: FanDuelLegInput[], boards: Record<string, FanDuelMarket>) {
  const asked: string[][] = [];
  const deps: FanDuelDeps = {
    now: NOW,
    getEvents: async () => [EVENT],
    getEventMarkets: async (_s, _id, keys) => {
      asked.push(keys);
      return Object.entries(boards).filter(([k]) => keys.includes(k)).map(([, m]) => m);
    },
  };
  const built = await buildFanDuelLink(legs, deps);
  return { built, asked };
}

async function main() {
  console.log("---- targets ----");
  const t = (l: FanDuelLegInput) => { const r = fanDuelLegTarget(l); return r.ok ? r.target.altMarketKey ?? null : "unsupported"; };
  check("NBA rebounds -> player_rebounds_alternate", t(propLeg("a")), "player_rebounds_alternate");
  check("NBA PRA combo", t(propLeg("a", { betDetail: "Deandre Ayton Over 30.5 Points + Rebounds + Assists" })), "player_points_rebounds_assists_alternate");
  check("NFL passing yards", t(propLeg("a", { sportKey: "americanfootball_nfl", leagueName: "NFL", betDetail: "Josh Allen Over 244.5 Passing Yards" })), "player_pass_yds_alternate");
  check("NHL shots on goal", t(propLeg("a", { sportKey: "icehockey_nhl", leagueName: "NHL", betDetail: "Auston Matthews Over 3.5 Shots on Goal" })), "player_shots_on_goal_alternate");
  check("NCAAF props keep the main market only", t(propLeg("a", { sportKey: "americanfootball_ncaaf", leagueName: "NCAAF", betDetail: "Josh Allen Over 244.5 Passing Yards" })), null);
  check("anytime TD (yes/no) has no alternate", t(propLeg("a", { sportKey: "americanfootball_nfl", leagueName: "NFL", betDetail: "Josh Allen Anytime TD" })), null);
  const game = fanDuelLegTarget(propLeg("g", { betType: "SPREAD", betDetail: "Lakers -6.5", line: -6.5, pickedSide: "HOME" }));
  check("a game-line target is unchanged", game.ok ? [game.target.marketKey, game.target.altMarketKey] : game, ["spreads", "alternate_spreads"]);

  console.log("---- send ----");
  const main12 = ladder("player_rebounds", [10.5, 12.5], 1000);
  const alt = ladder("player_rebounds_alternate", [9.5, 10.5, 11.5, 12.5, 13.5], 2000);

  const a = await run([propLeg("p")], { player_rebounds: main12, player_rebounds_alternate: alt });
  check("11.5 missing on main, present on alt -> matched at 11.5 (not adjusted)", [a.built.legs[0].status, a.built.legs[0].sentLine], ["matched", null]);
  check("  the alt selection is the one sent", Array.from(new URL(a.built.url!).searchParams.values()), ["2000", "2004"]);
  check("  main asked first, alt asked second", a.asked, [["player_rebounds"], ["player_rebounds_alternate"]]);

  const onMain = ladder("player_rebounds", [10.5, 11.5, 12.5], 1000);
  const b = await run([propLeg("p")], { player_rebounds: onMain, player_rebounds_alternate: alt });
  check("11.5 on main -> matched, alt never fetched", [b.built.legs[0].status, b.asked], ["matched", [["player_rebounds"]]]);

  const noAlt = ladder("player_rebounds_alternate", [9.5, 13.5], 2000);
  const c = await run([propLeg("p")], { player_rebounds: main12, player_rebounds_alternate: noAlt });
  const cl = c.built.legs[0];
  check("missing on both -> existing nearest-line adjusted (tie goes to the easier line)", [cl.status, cl.sentLine?.fanDuel, cl.sentLine?.pick], ["adjusted", 10.5, 11.5]);

  const d = await run([propLeg("p", { sportKey: "americanfootball_ncaaf", leagueName: "NCAAF", betDetail: "Deandre Ayton Over 11.5 Rebounds" })], {});
  check("an unsupported-prop leg never reaches the feed's alt market", d.asked.some((k) => k.some((x) => x.endsWith("_alternate"))), false);

  if (failures) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}
main();
