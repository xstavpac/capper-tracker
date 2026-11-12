// Proof for the Live page's team logos - run with:
//   npx tsx src/server/data/team-logos-acceptance-test.ts
//
// No test framework in this repo. console.logs PASS/FAIL, exits non-zero on any
// failure. No DB, no network: global fetch is stubbed. Logo URLs below are the
// real ones ESPN's scoreboard returned on 2026-11-12.

import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getNbaLiveScores,
  getWnbaLiveScores,
  getNflLiveScores,
  getNhlLiveScores,
  getNcaabLiveScores,
  getMlbLiveScores,
  matchScoreToGame,
  toClientScores,
  type ScoreGame,
} from "./odds";
import { normalizeEspnLogoUrl, mlbLogoUrl, scoreLogos } from "@/lib/team-logo";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const CDN = "https://a.espncdn.com/i/teamlogos/";

// ---- normalizeEspnLogoUrl ----
check("scoreboard variant is rewritten to the plain /500/ path", normalizeEspnLogoUrl(CDN + "wnba/500/scoreboard/atl.png"), CDN + "wnba/500/atl.png");
check("plain pro logo passes through", normalizeEspnLogoUrl(CDN + "nfl/500/nyg.png"), CDN + "nfl/500/nyg.png");
check("college id logo passes through", normalizeEspnLogoUrl(CDN + "ncaa/500/2244.png"), CDN + "ncaa/500/2244.png");
check("another host is rejected", normalizeEspnLogoUrl("https://evil.example.com/i/teamlogos/nfl/500/nyg.png"), null);
check("http (not https) is rejected", normalizeEspnLogoUrl("http://a.espncdn.com/i/teamlogos/nfl/500/nyg.png"), null);
check("javascript: URL is rejected", normalizeEspnLogoUrl("javascript:alert(1)"), null);
check("non-png is rejected", normalizeEspnLogoUrl(CDN + "nfl/500/nyg.svg"), null);
check("undefined / non-string -> null", [normalizeEspnLogoUrl(undefined), normalizeEspnLogoUrl(5), normalizeEspnLogoUrl("")], [null, null, null]);

// ---- mlbLogoUrl ----
check("MLB Stats id 139 (Rays) -> ESPN tb", mlbLogoUrl(139), CDN + "mlb/500/tb.png");
check("MLB Stats id 145 (White Sox) -> ESPN chw", mlbLogoUrl(145), CDN + "mlb/500/chw.png");
check("MLB Athletics (133) -> ath", mlbLogoUrl(133), CDN + "mlb/500/ath.png");
check("unknown / non-number MLB id -> null", [mlbLogoUrl(999), mlbLogoUrl("139"), mlbLogoUrl(undefined)], [null, null, null]);

// ---- the score feeds carry logos ----
const espnEvent = (id: string, home: [string, string?], away: [string, string?]) => ({
  id,
  date: "2026-11-12T23:00Z",
  status: { type: { name: "STATUS_SCHEDULED", state: "pre", completed: false }, period: 0, displayClock: "0:00" },
  competitions: [
    {
      competitors: [
        { homeAway: "home", team: { displayName: home[0], ...(home[1] ? { logo: home[1] } : {}) }, score: "0" },
        { homeAway: "away", team: { displayName: away[0], ...(away[1] ? { logo: away[1] } : {}) }, score: "0" },
      ],
    },
  ],
});

async function withFetch<T>(payload: unknown, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main() {
  // tsx compiles .tsx with the classic JSX transform (no auto-import), so the component needs a global React.
  (globalThis as unknown as { React: typeof React }).React = React;
  const { TeamMark } = await import("@/components/live/team-mark");
  const nba = await withFetch(
    { events: [espnEvent("n1", ["LA Clippers", CDN + "nba/500/scoreboard/lac.png"], ["Philadelphia 76ers", CDN + "nba/500/scoreboard/phi.png"])] },
    () => getNbaLiveScores()
  );
  check("NBA: both logos, normalized", [nba[0].homeLogoUrl, nba[0].awayLogoUrl], [CDN + "nba/500/lac.png", CDN + "nba/500/phi.png"]);

  const wnba = await withFetch(
    { events: [espnEvent("w1", ["Atlanta Dream", CDN + "wnba/500/scoreboard/atl.png"], ["Golden State Valkyries", CDN + "wnba/500/scoreboard/gs.png"])] },
    () => getWnbaLiveScores()
  );
  check("WNBA: ATL logo uses the /500/ path that exists", [wnba[0].homeLogoUrl, wnba[0].awayLogoUrl], [CDN + "wnba/500/atl.png", CDN + "wnba/500/gs.png"]);

  const nfl = await withFetch({ events: [espnEvent("f1", ["New York Giants", CDN + "nfl/500/scoreboard/nyg.png"], ["Dallas Cowboys"])] }, () => getNflLiveScores());
  check("NFL: a side with no logo is null, the other is set", [nfl[0].homeLogoUrl, nfl[0].awayLogoUrl], [CDN + "nfl/500/nyg.png", null]);

  const nhl = await withFetch({ events: [espnEvent("h1", ["Seattle Kraken", CDN + "nhl/500/scoreboard/sea.png"], ["Boston Bruins", "https://evil.example.com/x.png"])] }, () => getNhlLiveScores());
  check("NHL: logo set; an off-CDN logo is dropped", [nhl[0].homeLogoUrl, nhl[0].awayLogoUrl], [CDN + "nhl/500/sea.png", null]);

  const mlb = await withFetch(
    {
      dates: [
        {
          games: [
            {
              gamePk: 1,
              gameDate: "2026-11-12T23:00:00Z",
              status: { abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" },
              teams: { home: { team: { id: 139, name: "Tampa Bay Rays" } }, away: { team: { id: 147, name: "New York Yankees" } } },
            },
          ],
        },
      ],
    },
    () => getMlbLiveScores()
  );
  check("MLB: logos from the Stats API team ids", [mlb[0].homeLogoUrl, mlb[0].awayLogoUrl], [CDN + "mlb/500/tb.png", CDN + "mlb/500/nyy.png"]);

  // College is a later phase: the plumbing is ESPN-generic but the college getters don't opt in yet.
  const ncaab = await withFetch(
    { events: [espnEvent("c1", ["Duke Blue Devils", CDN + "ncaa/500/150.png"], ["Kansas Jayhawks", CDN + "ncaa/500/2305.png"])] },
    () => getNcaabLiveScores()
  );
  check("NCAAB: no logo fields yet", ["homeLogoUrl" in ncaab[0], "awayLogoUrl" in ncaab[0]], [false, false]);

  // ---- the logos survive the client trim and reach an odds-spelled card ----
  const client = toClientScores(nba);
  check("toClientScores keeps the logos", [client[0].homeLogoUrl, client[0].awayLogoUrl], [CDN + "nba/500/lac.png", CDN + "nba/500/phi.png"]);

  // The card is spelled the way The Odds API spells it ("Los Angeles Clippers"), the score row the ESPN way ("LA Clippers").
  const card = { homeTeam: "Los Angeles Clippers", awayTeam: "Philadelphia 76ers", commenceTime: "2026-11-12T23:00:00Z" };
  const matched = matchScoreToGame(client, card, "basketball_nba");
  check("odds-spelled card matches its ESPN row", matched?.id, "n1");
  check("card gets home/away logos via scoreLogos", scoreLogos(matched), { home: CDN + "nba/500/lac.png", away: CDN + "nba/500/phi.png" });
  check("a card that matched nothing has no logos", scoreLogos(matchScoreToGame(client, { ...card, homeTeam: "Nope" }, "basketball_nba")), { home: null, away: null });
  check("scoreLogos(undefined) is safe", scoreLogos(undefined), { home: null, away: null });
  const bare: ScoreGame = { ...client[0], homeLogoUrl: undefined, awayLogoUrl: undefined };
  check("a score row with no logo fields -> nulls", scoreLogos(bare), { home: null, away: null });

  // ---- TeamMark: the logo, or exactly the old mark ----
  const fb = createElement("span", { id: "old-mark" });
  const withLogo = renderToStaticMarkup(createElement(TeamMark, { logoUrl: CDN + "nba/500/lac.png", fallback: fb }));
  check("logo renders an <img> with the URL", withLogo.includes('<img') && withLogo.includes('src="' + CDN + 'nba/500/lac.png"'), true);
  check("the logo is decorative (alt empty)", withLogo.includes('alt=""'), true);
  check("with a logo the old mark is not rendered", withLogo.includes("old-mark"), false);
  for (const missing of [null, undefined, ""]) {
    const html = renderToStaticMarkup(createElement(TeamMark, { logoUrl: missing, fallback: fb }));
    check(`logoUrl ${JSON.stringify(missing)} renders only the old mark`, html, '<span id="old-mark"></span>');
  }
  check("no logo and no fallback renders nothing", renderToStaticMarkup(createElement(TeamMark, { logoUrl: null, fallback: null })), "");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
