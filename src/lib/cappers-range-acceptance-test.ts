// The /cappers time range options - run with:
//   npx tsx src/lib/cappers-range-acceptance-test.ts
//
// Proven here: 30 days is the longest range (no 60-day option); the banner pills use the short
// labels in order; a retired ?range=60d link lands on 30 days (not All time); unknown/absent keys
// still fall to All time; and the 30-day link round-trips through cappersHref.
import { RANGE_OPTIONS, cappersHref, parseCappersParams } from "./cappers-page-params";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

check("pill labels", RANGE_OPTIONS.map((r) => r.pill), ["All time", "Today", "Yesterday", "7 days", "30 days"]);
check("no window beyond 30 days", RANGE_OPTIONS.some((r) => r.window === "LAST_60"), false);
const p60 = parseCappersParams({ range: "60d" }, []);
check("?range=60d falls back to 30 days", [p60.range, p60.window], ["30d", "LAST_30"]);
check("?range=60d from an array param", parseCappersParams({ range: ["60d"] }, []).range, "30d");
check("unknown range -> All time", parseCappersParams({ range: "90d" }, []).range, "all");
check("no range -> All time", parseCappersParams({}, []).range, "all");
check("30d kept", parseCappersParams({ range: "30d" }, []).window, "LAST_30");
check("href for the fallback is the 30d link", cappersHref(p60), "/cappers?range=30d");

process.exit(failures > 0 ? 1 : 0);
