// Send to FanDuel's per-instance 60 s cache (server/data/fanduel-link.ts): a good answer is reused, but an empty
// one (no events listed, or a 200 with no FanDuel markets) and a failed one are NOT kept, so a re-check inside the
// window asks the Odds API again. A thin 200 is logged with the keys it did and didn't carry. Upstream is a
// stubbed fetch; no DB (a failing usage-log write is caught by the code under test). Run with:
//   npx tsx src/server/data/fanduel-link-cache-acceptance-test.ts
export {};
process.env.ODDS_API_KEY = "test-key";
// Never write the usage-log rows this exercises to a real database.
delete process.env.DATABASE_URL;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const market = (key: string) => ({ key, outcomes: [] });
const oneEvent = [{ id: "e1", home_team: "A", away_team: "B", commence_time: "2026-11-10T00:00:00Z" }];

let respond: (url: string) => Response = () => json([]);
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  return respond(url);
}) as typeof fetch;

const warns: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warns.push(args.map(String).join(" "));
};
console.error = () => {};

async function main() {
  const { oddsApiDeps } = await import("@/server/data/fanduel-link");
  const now = new Date("2026-11-09T12:00:00Z");
  const marketCalls = () => calls.filter((u) => u.includes("/odds?")).length;
  const eventCalls = () => calls.filter((u) => u.includes("/events?")).length;
  const mk = (sport: string) => (deps: ReturnType<typeof oddsApiDeps>) => deps.getEventMarkets(sport, "e1", ["h2h"]);

  // ---- event listing ----
  respond = () => json([]);
  await oddsApiDeps(now).getEvents("basketball_nba");
  await oddsApiDeps(now).getEvents("basketball_nba");
  check("empty events listing is not kept: second tap asks again", eventCalls(), 2);
  respond = () => json(oneEvent);
  calls.length = 0;
  await oddsApiDeps(now).getEvents("icehockey_nhl");
  await oddsApiDeps(now).getEvents("icehockey_nhl");
  check("a non-empty events listing is reused inside the window", eventCalls(), 1);

  // ---- event markets ----
  calls.length = 0;
  respond = () => json({ bookmakers: [{ key: "draftkings", markets: [market("h2h")] }] });
  check("no fanduel bookmaker -> empty answer", await mk("basketball_nba")(oddsApiDeps(now)), []);
  await mk("basketball_nba")(oddsApiDeps(now));
  check("a 200 with no FanDuel markets is not kept: re-check asks again", marketCalls(), 2);
  const thin = warns.find((w) => w.includes("thin 200")) ?? "";
  check("...and is logged as a thin 200 with the bookmakers that did come back", thin.includes("draftkings") && thin.includes('"noFanDuelMarkets":true'), true);
  check("...without the API key in the log", thin.includes("test-key"), false);

  calls.length = 0;
  respond = () => json({}, 429);
  check("a 429 answers null", await mk("basketball_nba")(oddsApiDeps(now)), null);
  await mk("basketball_nba")(oddsApiDeps(now));
  check("a 429 is not kept (unchanged)", marketCalls(), 2);

  calls.length = 0;
  respond = () => json({ bookmakers: [{ key: "fanduel", markets: [market("h2h")] }] });
  await mk("basketball_nba")(oddsApiDeps(now));
  await mk("basketball_nba")(oddsApiDeps(now));
  check("a good answer is still reused inside the window", marketCalls(), 1);

  warns.length = 0;
  calls.length = 0;
  respond = () => json({ bookmakers: [{ key: "fanduel", markets: [market("h2h")] }] });
  await oddsApiDeps(now).getEventMarkets("americanfootball_nfl", "e1", ["h2h", "alternate_spreads"]);
  const partial = warns.find((w) => w.includes("thin 200")) ?? "";
  check("a partial 200 (a requested market missing) is logged with what was missing", partial.includes('"missingMarketKeys":["alternate_spreads"]'), true);
  await oddsApiDeps(now).getEventMarkets("americanfootball_nfl", "e1", ["h2h", "alternate_spreads"]);
  check("...but a non-empty partial answer is still kept (only empty ones are dropped)", marketCalls(), 1);

  console.warn = origWarn;
  if (failures > 0) {
    console.log(failures + " check(s) failed");
    process.exit(1);
  }
  console.log("all checks passed");
  process.exit(0);
}
main();
