// NBA player-prop pricing (nba-prop-odds.ts): the pure matcher and the buy/reuse flow.
//
// Real data, two live captures saved verbatim:
//   - __fixtures__/odds-api-event-nba-player-props-2026-11-11.json: Boston Celtics @ Toronto Raptors, all ten NBA
//     prop markets, 8 books (x-requests-last: 9).
//   - __fixtures__/odds-api-historical-nba-player-points-2026-10-30.json: Los Angeles Lakers @ Golden State Warriors,
//     player_points from the historical endpoint at 2026-10-30T17:25:36Z, five minutes before seven real NBA props
//     on that game were imported (and stored at -110).
// The roster rows below are HAND-BUILT (name + team), not a capture.
//
// No database and no network: findNbaPropPrice runs over in-memory deps (store, fetch, clock, credit level). NEVER
// let fetchEvent reach the network here - a real call would spend real credits. Run with:
//   npx tsx src/server/data/nba-prop-odds-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findNbaPropPrice,
  firstBookAtLine,
  propLinesFromBookmakers,
  resolveBookPlayerName,
  reuseBucket,
  NBA_PROP_ODDS_CALLER,
  NBA_PROP_ODDS_MARKET_KEYS,
  REUSE_WINDOW_MS,
  type NbaPropOddsDeps,
  type PropLineRow,
} from "@/server/data/nba-prop-odds";
import type { OddsGame } from "@/server/data/odds";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import type { CreditUsageLevel } from "@/server/data/odds-api-usage";

const env = process.env as Record<string, string | undefined>;
env.NBA_PROP_ODDS_TIMEOUT_MS = "60";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const FIX = join(__dirname, "__fixtures__");
const live = JSON.parse(readFileSync(join(FIX, "odds-api-event-nba-player-props-2026-11-11.json"), "utf8"));
const hist = JSON.parse(readFileSync(join(FIX, "odds-api-historical-nba-player-points-2026-10-30.json"), "utf8")).data;

const P = (playerName: string, team: string, id: string): RosterPlayer => {
  const parts = playerName.split(" ");
  return { playerName, firstName: parts[0], lastName: parts.slice(1).join(" "), team, position: "G", externalPlayerId: id };
};
const LAL = "Los Angeles Lakers";
const GSW = "Golden State Warriors";
const ROSTER: RosterPlayer[] = [
  P("Luka Dončić", LAL, "1"),
  P("Austin Reaves", LAL, "2"),
  P("Stephen Curry", GSW, "3"),
  P("Yaxel Lendeborg", GSW, "4"),
  P("Georges Niang", LAL, "5"),
  P("Draymond Green", GSW, "6"),
  P("Ziaire Williams", GSW, "7"),
  P("Gabe Williams", LAL, "8"), // a second Williams in this game, so a bare "Williams" is ambiguous
  P("Jalen Green", "Houston Rockets", "9"), // not in this game
];

async function main() {
  // =====================================================================
  // 1. Normalizing a real response
  // =====================================================================
  const livePoints = propLinesFromBookmakers(live.bookmakers, "player_points");
  // fanduel/williamhill_us/draftkings/betrivers/betmgm/betonlineag 20 each, fanatics 2, Bovada's 120-outcome ladder.
  expect("live: player_points rows from all 8 books", livePoints.length, 242);
  expect("live: bookOrder is the feed position (fanduel first in this response)", [livePoints[0].bookKey, livePoints[0].bookOrder], ["fanduel", 0]);
  const allLive = Object.values(NBA_PROP_ODDS_MARKET_KEYS).reduce((n, k) => n + propLinesFromBookmakers(live.bookmakers, k!).length, 0);
  expect("live: every outcome of the 9 returned markets is a usable Over/Under row", allLive, 1178);
  expect("other markets are not mixed in", propLinesFromBookmakers(live.bookmakers, "player_points").every((r) => r.side === "Over" || r.side === "Under"), true);
  expect("ten PropMarkets mapped; DOUBLE_DOUBLE and DEFENSIVE_REBOUNDS are not", [Object.keys(NBA_PROP_ODDS_MARKET_KEYS).length, "DOUBLE_DOUBLE" in NBA_PROP_ODDS_MARKET_KEYS, "DEFENSIVE_REBOUNDS" in NBA_PROP_ODDS_MARKET_KEYS], [10, false, false]);
  expect("usage rows are tagged with the nba-prop-odds caller", NBA_PROP_ODDS_CALLER, "nba-prop-odds");

  // =====================================================================
  // 2. Player resolution (roster first, then the book's spelling)
  // =====================================================================
  const histPoints = propLinesFromBookmakers(hist.bookmakers, "player_points");
  const bookNames = [...new Set(histPoints.map((r) => r.playerName))];
  const inGame = ROSTER.filter((p) => p.team === LAL || p.team === GSW);
  expect("full name -> the book's spelling", resolveBookPlayerName("Luka Doncic", bookNames, inGame), { status: "one", name: "Luka Doncic" });
  expect("accented typed name folds to the book's plain spelling", resolveBookPlayerName("Luka Dončić", bookNames, inGame), { status: "one", name: "Luka Doncic" });
  expect("surname alone, unique in this game", resolveBookPlayerName("Reaves", bookNames, inGame), { status: "one", name: "Austin Reaves" });
  expect("surname shared by two players in this game is never guessed", resolveBookPlayerName("Williams", bookNames, inGame), { status: "many" });
  expect("a player not in this game is not matched to anyone", resolveBookPlayerName("Jalen Green", bookNames, inGame), { status: "none" });
  expect("acronym nickname stays unpriced", resolveBookPlayerName("SGA", bookNames, inGame), { status: "none" });
  // Jalen vs Jaylin Williams (both OKC): the book lists only Jaylin. A near spelling is never taken when it is the
  // exact name of another player in the game.
  const okc = [P("Jalen Williams", "Oklahoma City Thunder", "j1"), P("Jaylin Williams", "Oklahoma City Thunder", "j2")];
  expect("Jalen is never priced off Jaylin's line", resolveBookPlayerName("Jalen Williams", ["Jaylin Williams", "Chet Holmgren"], okc), { status: "none" });
  expect("a real spelling variant still matches ('Nic' / 'Nick')", resolveBookPlayerName("Nick Claxton", ["Nic Claxton"], [P("Nick Claxton", "Brooklyn Nets", "c1")]), { status: "one", name: "Nic Claxton" });
  expect("roster unavailable: a full name exactly in the book still matches", resolveBookPlayerName("Stephen Curry", bookNames, []), { status: "one", name: "Stephen Curry" });
  expect("roster unavailable: a bare surname does not", resolveBookPlayerName("Curry", bookNames, []), { status: "none" });

  // =====================================================================
  // 3. Exact line, first book in feed order - against the real 10/30 lines
  // =====================================================================
  const at = (side: "Over" | "Under", point: number) => histPoints.filter((r) => r.side === side && r.point === point);
  const priceOf = (name: string, side: "Over" | "Under", point: number) => {
    const r = firstBookAtLine(at(side, point), name);
    return r ? [r.bookKey, r.price] : null;
  };
  expect("Luka Doncic over 34.5 -> DraftKings, first in this feed", priceOf("Luka Doncic", "Over", 34.5), ["draftkings", -119]);
  expect("Georges Niang over 7.5 -> DraftKings", priceOf("Georges Niang", "Over", 7.5), ["draftkings", -121]);
  expect("Yaxel Lendeborg over 18.5 -> only Bovada's ladder has 18.5", priceOf("Yaxel Lendeborg", "Over", 18.5), ["bovada", -135]);
  expect("Austin Reaves over 19.5 -> Bovada's ladder price, not the 23.5 main line's", priceOf("Austin Reaves", "Over", 19.5), ["bovada", -280]);
  expect("Stephen Curry over 19.5 -> no book hangs 19.5 (main 24.5/25.5): unpriced, not the nearest line", priceOf("Stephen Curry", "Over", 19.5), null);
  expect("Luka Doncic over 24.5 -> unpriced", priceOf("Luka Doncic", "Over", 24.5), null);
  const lukaUnder = firstBookAtLine(at("Under", 34.5), "Luka Doncic");
  expect("the Under side is read off the Under outcome", lukaUnder && [lukaUnder.bookKey, lukaUnder.price !== -119], ["draftkings", true]);

  // =====================================================================
  // 4. Buy / reuse flow over in-memory deps
  // =====================================================================
  const HOUR = 3600_000;
  let nowMs = Date.parse("2026-10-30T17:30:00Z");
  const game = { homeTeam: GSW, awayTeam: LAL, commenceTime: hist.commence_time as string };
  const oddsGame: OddsGame = { id: hist.id, sportKey: "basketball_nba", homeTeam: GSW, awayTeam: LAL, commenceTime: hist.commence_time, bookmakers: [] };
  const getOdds = async (sportKey: string) => (sportKey === "basketball_nba" ? [oddsGame] : []);

  type Fetch = { id: string; eventId: string; marketKey: string; bucket: number; createdAt: number; fetchedAt: Date | null; lines: PropLineRow[] };
  let fetches: Fetch[] = [];
  let calls: string[] = [];
  let usage: { marketsRequested: string[]; httpStatus: number | null }[] = [];
  let level: CreditUsageLevel = "ok";
  let apiKey: string | undefined = "test-key-never-sent-anywhere";
  let respond: (url: string) => Promise<Response> = async () => new Response(JSON.stringify(hist), { status: 200 });
  let seq = 0;
  const deps: NbaPropOddsDeps = {
    now: () => nowMs,
    apiKey: () => apiKey,
    creditLevel: async () => level,
    fetchEvent: async (url) => {
      calls.push(url);
      return respond(url);
    },
    logUsage: async (input) => {
      usage.push({ marketsRequested: input.marketsRequested, httpStatus: input.httpStatus });
    },
    getRoster: async () => ROSTER,
    store: {
      findReusable: async (eventId, marketKey, since) => {
        const hit = fetches
          .filter((f) => f.eventId === eventId && f.marketKey === marketKey && f.createdAt >= since.getTime() && f.fetchedAt)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        return hit ? { id: hit.id, fetchedAt: hit.fetchedAt! } : null;
      },
      claim: async (row) => {
        if (fetches.some((f) => f.eventId === row.eventId && f.marketKey === row.marketKey && f.bucket === row.bucket)) return "taken";
        const f: Fetch = { id: "f" + ++seq, eventId: row.eventId, marketKey: row.marketKey, bucket: row.bucket, createdAt: nowMs, fetchedAt: null, lines: [] };
        fetches.push(f);
        return { id: f.id };
      },
      findClaim: async (eventId, marketKey, bucket) => {
        const f = fetches.find((x) => x.eventId === eventId && x.marketKey === marketKey && x.bucket === bucket);
        return f ? { id: f.id, fetchedAt: f.fetchedAt } : null;
      },
      saveLines: async (fetchId, lines, fetchedAt) => {
        const f = fetches.find((x) => x.id === fetchId)!;
        f.lines = lines;
        f.fetchedAt = fetchedAt;
      },
      release: async (fetchId) => {
        fetches = fetches.filter((f) => f.id !== fetchId);
      },
      playerNames: async (fetchId) => [...new Set(fetches.find((f) => f.id === fetchId)!.lines.map((l) => l.playerName))],
      exactLine: async (fetchId, side, point) =>
        fetches
          .find((f) => f.id === fetchId)!
          .lines.filter((l) => l.side === side && l.point === point)
          .sort((a, b) => a.bookOrder - b.bookOrder)
          .map(({ bookOrder, bookKey, playerName, price }) => ({ bookOrder, bookKey, playerName, price })),
    },
  };
  const reset = () => {
    fetches = [];
    calls = [];
    usage = [];
    level = "ok";
    apiKey = "test-key-never-sent-anywhere";
    respond = async () => new Response(JSON.stringify(hist), { status: 200 });
    nowMs = Date.parse("2026-10-30T17:30:00Z");
  };
  const q = (playerName: string, side: "Over" | "Under", point: number, propMarket = "POINTS") => ({ playerName, propMarket, side, point });
  const price = (r: Awaited<ReturnType<typeof findNbaPropPrice>>) => (r.price === null ? { reason: r.reason } : { price: r.price, book: r.book, capturedAt: r.capturedAt.toISOString() });

  // 4a. One buy serves every pick on that event + market, including concurrent ones.
  reset();
  const [luka, niang, curry, reaves] = await Promise.all([
    findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps),
    findNbaPropPrice(game, q("Georges Niang", "Over", 7.5), getOdds, deps),
    findNbaPropPrice(game, q("Stephen Curry", "Over", 19.5), getOdds, deps),
    findNbaPropPrice(game, q("Reaves", "Over", 19.5), getOdds, deps),
  ]);
  expect("Luka over 34.5 priced, stamped with the fetch time", price(luka), { price: -119, book: "draftkings", capturedAt: "2026-10-30T17:30:00.000Z" });
  expect("Niang over 7.5 priced", price(niang), { price: -121, book: "draftkings", capturedAt: "2026-10-30T17:30:00.000Z" });
  expect("Curry over 19.5 -> no_exact_line", price(curry), { reason: "no_exact_line" });
  expect("'Reaves' resolves through the roster", price(reaves), { price: -280, book: "bovada", capturedAt: "2026-10-30T17:30:00.000Z" });
  expect("four concurrent picks, one request", calls.length, 1);
  expect("the request asks for the one market, us region, this event", [calls[0].includes("/sports/basketball_nba/events/" + hist.id + "/odds?"), calls[0].includes("&markets=player_points&"), calls[0].includes("regions=us")], [true, true, true]);
  expect("one usage row for the call", usage, [{ marketsRequested: ["player_points"], httpStatus: 200 }]);

  // 4b. Unknown player / ambiguous surname -> no_market; unmapped market -> no fetch, caller's reason.
  expect("a player not listed -> no_market", price(await findNbaPropPrice(game, q("Nobody Realname", "Over", 10.5), getOdds, deps)), { reason: "no_market" });
  expect("ambiguous surname -> no_market", price(await findNbaPropPrice(game, q("Williams", "Over", 10.5), getOdds, deps)), { reason: "no_market" });
  expect("double-double has no market key -> nothing fetched", [price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 0.5, "DOUBLE_DOUBLE"), getOdds, deps)), calls.length], [{ reason: null }, 1]);

  // 4c. Reuse window: 1h59 later reuses, 2h01 later buys again.
  nowMs += 2 * HOUR - 60_000;
  await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps);
  expect("1h59m later: reused, no new request", calls.length, 1);
  nowMs += 2 * 60_000;
  const later = await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps);
  expect("2h01m later: a new request, priced from it", [calls.length, later.price !== null && later.capturedAt.toISOString()], [2, new Date(nowMs).toISOString()]);
  expect("reuse window is 2 h and buckets follow it", [REUSE_WINDOW_MS, reuseBucket(REUSE_WINDOW_MS * 5 + 1)], [7_200_000, 5]);

  // 4d. A second market on the same game is its own (1-credit) request.
  reset();
  respond = async () => new Response(JSON.stringify(live), { status: 200 });
  const liveGame = { homeTeam: "Toronto Raptors", awayTeam: "Boston Celtics", commenceTime: live.commence_time as string };
  const liveOdds: OddsGame = { id: live.id, sportKey: "basketball_nba", homeTeam: "Toronto Raptors", awayTeam: "Boston Celtics", commenceTime: live.commence_time, bookmakers: [] };
  const liveLoader = async () => [liveOdds];
  nowMs = Date.parse("2026-11-11T17:00:00Z");
  const tatumAst = await findNbaPropPrice(liveGame, q("Jayson Tatum", "Over", 6.5, "ASSISTS"), liveLoader, deps);
  const tatumPts = await findNbaPropPrice(liveGame, q("Jayson Tatum", "Over", 6.5, "POINTS"), liveLoader, deps);
  expect("live: Tatum over 6.5 assists priced from the first book with 6.5 (FanDuel)", tatumAst.price !== null && tatumAst.book, "fanduel");
  expect("live: two markets, two requests", calls.map((u) => u.match(/markets=([a-z_]+)/)![1]), ["player_assists", "player_points"]);
  expect("live: 6.5 is not a points line for Tatum -> no_exact_line", price(tatumPts), { reason: "no_exact_line" });

  // 4e. Never buys for a started game, without a key, or past the 95% gate.
  reset();
  nowMs = Date.parse(hist.commence_time) + 60_000;
  expect("started game, nothing fetched before tip -> caller's reason (game_started), no request", [price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps)), calls.length], [{ reason: null }, 0]);
  reset();
  apiKey = undefined;
  expect("no API key -> no request", [price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps)), calls.length], [{ reason: "no_market" }, 0]);
  reset();
  level = "stop_lower_priority";
  expect(">=95% credit usage -> no request", [price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps)), calls.length], [{ reason: "no_market" }, 0]);

  // 4f. A pregame fetch still prices a pick imported just after tip.
  reset();
  nowMs = Date.parse(hist.commence_time) - 30 * 60_000;
  await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps);
  nowMs = Date.parse(hist.commence_time) + 60_000;
  const afterTip = await findNbaPropPrice(game, q("Georges Niang", "Over", 7.5), getOdds, deps);
  expect("pregame fetch reused after tip, no new request", [afterTip.price, calls.length], [-121, 1]);

  // 4g. Failures: nothing bought -> claim released, next pick retries.
  reset();
  respond = async () => {
    throw new Error("network down");
  };
  expect("fetch throws -> no_market, claim row released", [price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps)), fetches.length, usage.length], [{ reason: "no_market" }, 0, 0]);
  respond = async () => new Response("quota", { status: 429 });
  expect("non-2xx -> usage logged, claim released", [price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps)), fetches.length, usage], [{ reason: "no_market" }, 0, [{ marketsRequested: ["player_points"], httpStatus: 429 }]]);
  respond = async () => new Response(JSON.stringify(hist), { status: 200 });
  expect("the next pick retries and is priced", [(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps)).price, calls.length], [-119, 3]);

  // 4h. An empty answer is remembered for the window (free, no re-buy).
  reset();
  respond = async () => new Response(JSON.stringify({ ...hist, bookmakers: [] }), { status: 200 });
  expect("market not posted yet -> no_market", price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps)), { reason: "no_market" });
  await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps);
  expect("empty answer reused inside the window", calls.length, 1);

  // 4i. Another request holds this window's claim.
  reset();
  fetches.push({ id: "theirs", eventId: hist.id, marketKey: "player_points", bucket: reuseBucket(nowMs), createdAt: nowMs - 3 * HOUR, fetchedAt: null, lines: [] });
  expect("claim held elsewhere, still in flight -> no request, no_market", [price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps)), calls.length], [{ reason: "no_market" }, 0]);

  // 4j. Timeout: the pick is unpriced, the request finishes in the background and prices the next pick.
  reset();
  let release!: () => void;
  respond = () => new Promise<Response>((resolve) => (release = () => resolve(new Response(JSON.stringify(hist), { status: 200 }))));
  expect("slow request -> no_market after the timeout", price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps)), { reason: "no_market" });
  release();
  await new Promise((r) => setTimeout(r, 20));
  const next = await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), getOdds, deps);
  expect("its result prices the next pick, no second request", [next.price, calls.length], [-119, 1]);

  // 4k. Odds game not in the listing.
  reset();
  expect("game not in the odds listing -> no_market, no request", [price(await findNbaPropPrice(game, q("Luka Doncic", "Over", 34.5), async () => [], deps)), calls.length], [{ reason: "no_market" }, 0]);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
