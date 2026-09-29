// Proof for the ticker's combined score feed: getAllLiveScores returns, per
// sport, exactly what the old per-sport polls (getLiveScoresForSport ->
// /api/public/live-scores?sport=) returned, merged into one map; a failed
// sport is omitted (not []); and /api/public/ticker-scores' cache headers.
// Run: npx tsx src/server/data/live-ticker-combined-scores-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { getAllLiveScores } from "./live-ticker";
import { RESOLVABLE_SPORT_KEYS, type ScoreGame } from "./odds";
import { buildTickerScoresResponse, TICKER_SCORES_CACHE_CONTROL } from "../../lib/ticker-scores-response";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function game(sportKey: string, i: number): ScoreGame {
  return {
    id: `${sportKey}-${i}`,
    homeTeam: `Home ${sportKey} ${i}`,
    awayTeam: `Away ${sportKey} ${i}`,
    status: i % 2 ? "live" : "final",
    scores: [
      { name: `Home ${sportKey} ${i}`, score: String(i + 3) },
      { name: `Away ${sportKey} ${i}`, score: String(i) },
    ],
    commenceTime: "2026-09-29T23:05:00.000Z",
    inningHalf: sportKey === "baseball_mlb" ? "Top" : null,
    inningOrdinal: sportKey === "baseball_mlb" ? "7th" : null,
    innings: null,
  };
}

const perSport = new Map<string, ScoreGame[]>(
  RESOLVABLE_SPORT_KEYS.map((k, idx) => [k, Array.from({ length: idx + 1 }, (_, i) => game(k, i))])
);
const oldStyleFetch = async (sportKey: string) => perSport.get(sportKey) ?? [];

async function main() {
  // ---- combined == the old per-sport responses merged ----
  const oldResponses = await Promise.all(RESOLVABLE_SPORT_KEYS.map(async (k) => [k, await oldStyleFetch(k)] as const));
  const mergedOld = Object.fromEntries(oldResponses);
  const { scoresBySport, failed } = await getAllLiveScores(oldStyleFetch);
  check("no failures reported", failed.length === 0);
  check(
    "combined output deep-equals the per-sport responses merged",
    JSON.stringify(scoresBySport) === JSON.stringify(mergedOld)
  );
  check(
    "covers every resolvable sport",
    RESOLVABLE_SPORT_KEYS.every((k) => Array.isArray(scoresBySport[k]))
  );
  check(
    "flattened game count equals sum of the old responses",
    Object.values(scoresBySport).flat().length === oldResponses.reduce((n, [, v]) => n + v.length, 0)
  );

  // ---- a failing sport is omitted, not sent as [] ----
  const boom = RESOLVABLE_SPORT_KEYS[1];
  const partial = await getAllLiveScores(async (k) => {
    if (k === boom) throw new Error("upstream down");
    return oldStyleFetch(k);
  });
  check("failed sport reported", partial.failed.length === 1 && partial.failed[0] === boom);
  check("failed sport omitted from map (not [])", !(boom in partial.scoresBySport));
  check(
    "other sports unaffected by the failure",
    RESOLVABLE_SPORT_KEYS.filter((k) => k !== boom).every(
      (k) => JSON.stringify(partial.scoresBySport[k]) === JSON.stringify(mergedOld[k])
    )
  );

  // ---- cache headers ----
  const ok = buildTickerScoresResponse({ scoresBySport, failed: [] });
  check(
    "success response is CDN-cacheable: public, s-maxage=15, stale-while-revalidate=30",
    ok.headers.get("Cache-Control") === "public, s-maxage=15, stale-while-revalidate=30" &&
      TICKER_SCORES_CACHE_CONTROL === "public, s-maxage=15, stale-while-revalidate=30",
    String(ok.headers.get("Cache-Control"))
  );
  check("success response sets no cookie", ok.headers.get("Set-Cookie") === null);
  check("response body is { scoresBySport }", JSON.stringify(await ok.json()) === JSON.stringify({ scoresBySport: mergedOld }));
  const degraded = buildTickerScoresResponse({ scoresBySport: partial.scoresBySport, failed: partial.failed });
  check("partial response is NOT cached (no-store)", degraded.headers.get("Cache-Control") === "no-store");

  if (failures > 0) {
    console.log(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
