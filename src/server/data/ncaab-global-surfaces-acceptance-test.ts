// Pins where NCAAB is deliberately NOT shown - run with:
//   npx tsx src/server/data/ncaab-global-surfaces-acceptance-test.ts
//
// No test framework in this repo. console.logs PASS/FAIL, exits non-zero on any
// failure. No DB, no network.
//
// NCAAB's slate (~180 games on a busy day) would drown the cross-league
// surfaces, so:
//   1. the ticker and its public score feeds leave it out;
//   2. /live never opens on it by itself (it stays in the tab row, after NCAAF).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAllLiveScores, TICKER_SPORT_KEYS } from "./live-ticker";
import { LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "./odds";
import { pickDefaultLeague, LIVE_DEFAULT_FALLBACK } from "@/lib/live-default-league";
import { isTickerSportKey } from "@/lib/global-surface-sports";
import { GET as publicLiveScores } from "../../app/api/public/live-scores/route";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const NCAAB = "basketball_ncaab";

async function main() {
  // ---- the ticker ----
  check("NCAAB is a resolvable sport (so the exclusion below is doing something)", RESOLVABLE_SPORT_KEYS.includes(NCAAB), true);
  check("TICKER_SPORT_KEYS excludes NCAAB", TICKER_SPORT_KEYS.includes(NCAAB), false);
  check(
    "TICKER_SPORT_KEYS is every other resolvable sport, in order",
    TICKER_SPORT_KEYS,
    RESOLVABLE_SPORT_KEYS.filter((k) => k !== NCAAB)
  );
  check("NCAAF is still a ticker sport", TICKER_SPORT_KEYS.includes("americanfootball_ncaaf"), true);
  check("isTickerSportKey: NCAAB false, NBA true", [isTickerSportKey(NCAAB), isTickerSportKey("basketball_nba")], [false, true]);

  // The combined public feed (/api/public/ticker-scores): NCAAB is never fetched and never in the map.
  const asked: string[] = [];
  const { scoresBySport, failed } = await getAllLiveScores(async (k) => {
    asked.push(k);
    return [];
  });
  check("combined feed never asks for NCAAB", asked.includes(NCAAB), false);
  check("combined feed carries no NCAAB key", NCAAB in scoresBySport, false);
  check("combined feed carries every ticker sport", TICKER_SPORT_KEYS.every((k) => k in scoresBySport), true);
  check("combined feed reports no failure for the omitted sport", failed.includes(NCAAB), false);

  // The per-sport public route answers NCAAB like an unknown sport (and, like one, before any read).
  const ncaabRes = await publicLiveScores(new Request("http://x/api/public/live-scores?sport=" + NCAAB));
  check("/api/public/live-scores?sport=basketball_ncaab -> 400", ncaabRes.status, 400);
  check("... with the unknown-sport body", await ncaabRes.json(), { error: "unknown sport" });
  const bogusRes = await publicLiveScores(new Request("http://x/api/public/live-scores?sport=curling"));
  check("an unknown sport -> 400 (same answer)", bogusRes.status, 400);

  // ---- the /live tab row ----
  const keys = LIVE_SPORTS.map((s) => s.key);
  check("NCAAB is in the /live tab row", keys.includes(NCAAB), true);
  check("... directly after NCAAF", keys[keys.indexOf("americanfootball_ncaaf") + 1], NCAAB);

  // ---- the default tab ----
  const NOW = new Date("2026-11-02T19:00:00Z"); // 2:00 pm ET
  const live = (sportKey: string, iso: string) => ({ sportKey, games: [{ status: "live" as const, commenceTime: iso }] });
  const preview = (sportKey: string, iso: string) => ({ sportKey, games: [{ status: "preview" as const, commenceTime: iso }] });

  check(
    "NCAAB live earliest of all: another league still wins",
    pickDefaultLeague([live(NCAAB, "2026-11-02T17:00:00Z"), live("basketball_nba", "2026-11-02T18:30:00Z")], NOW),
    "basketball_nba"
  );
  check(
    "NCAAB live while another league only has a game later today: that league wins",
    pickDefaultLeague([live(NCAAB, "2026-11-02T17:00:00Z"), preview("icehockey_nhl", "2026-11-02T23:00:00Z")], NOW),
    "icehockey_nhl"
  );
  check(
    "NCAAB is the only league with games: falls back to the usual default, not NCAAB",
    pickDefaultLeague([live(NCAAB, "2026-11-02T17:00:00Z"), preview(NCAAB, "2026-11-02T23:00:00Z")], NOW),
    LIVE_DEFAULT_FALLBACK
  );
  check(
    "NCAAB upcoming tomorrow, nothing else: fallback",
    pickDefaultLeague([preview(NCAAB, "2026-11-03T23:00:00Z")], NOW),
    LIVE_DEFAULT_FALLBACK
  );
  check(
    "behavior without NCAAB is unchanged: earliest live wins",
    pickDefaultLeague([live("baseball_mlb", "2026-11-02T18:30:00Z"), live("icehockey_nhl", "2026-11-02T18:00:00Z")], NOW),
    "icehockey_nhl"
  );

  // The reader does not even fetch NCAAB's scores (pickDefaultLeague would drop them).
  const reader = readFileSync(join(__dirname, "live-default-sport.ts"), "utf8");
  check("live-default-sport.ts filters the excluded leagues before reading their feed", /DEFAULT_TAB_EXCLUDED_SPORT_KEYS\.has\(s\.key\)/.test(reader), true);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
