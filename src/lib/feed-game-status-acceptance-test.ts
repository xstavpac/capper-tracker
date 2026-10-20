// resolveFeedStatus / mlbFeedStatus: a feed's "live" is believed only once the
// game's scheduled start has passed, and MLB Warmup is always scheduled.
// Run with:
//   npx tsx src/lib/feed-game-status-acceptance-test.ts
import { mlbFeedStatus, resolveFeedStatus } from "@/lib/feed-game-status";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log((ok ? "PASS" : "FAIL") + " - " + label + (ok ? "" : " (got " + String(actual) + ", expected " + String(expected) + ")"));
}

const START = "2026-10-15T00:00:00Z";
const at = (minutesFromStart: number) => new Date(new Date(START).getTime() + minutesFromStart * 60_000);

// Generic feeds (ESPN state "in", Odds API scores present)
check("feed says live 20 min before start -> scheduled", resolveFeedStatus("live", START, at(-20)), "preview");
check("feed says live 1 min after start -> live", resolveFeedStatus("live", START, at(1)), "live");
check("feed says live exactly at start -> live", resolveFeedStatus("live", START, at(0)), "live");
check("feed says final -> final, whatever the clock", resolveFeedStatus("final", START, at(-20)), "final");
check("feed says preview after start -> preview (not promoted)", resolveFeedStatus("preview", START, at(30)), "preview");
check("feed says live, no usable start time -> trust the feed", resolveFeedStatus("live", "", at(0)), "live");

// MLB StatsAPI
check("MLB Warmup (PW) after start -> scheduled", mlbFeedStatus({ abstractGameState: "Live", statusCode: "PW" }, START, at(5)), "preview");
check("MLB Warmup (PW) before start -> scheduled", mlbFeedStatus({ abstractGameState: "Live", statusCode: "PW" }, START, at(-20)), "preview");
check("MLB In Progress (I) before start -> scheduled", mlbFeedStatus({ abstractGameState: "Live", statusCode: "I" }, START, at(-20)), "preview");
check("MLB In Progress (I) after start -> live", mlbFeedStatus({ abstractGameState: "Live", statusCode: "I" }, START, at(1)), "live");
check("MLB Final -> final", mlbFeedStatus({ abstractGameState: "Final", codedGameState: "F", statusCode: "F" }, START, at(200)), "final");
check("MLB Preview -> preview", mlbFeedStatus({ abstractGameState: "Preview", statusCode: "S" }, START, at(-60)), "preview");
check("MLB missing status -> preview", mlbFeedStatus(undefined, START, at(10)), "preview");

if (failures > 0) {
  console.log("\n" + failures + " failure(s)");
  process.exit(1);
}
console.log("\nAll checks passed");
