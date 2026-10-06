// League Savant's daily league rotation (league-savant.ts): pure, no DB.
//   npx tsx src/lib/league-savant-rotation-test.ts
import { easternDateKey } from "@/lib/dates";
import { SAVANT_ROTATION_EPOCH, defaultSavantLeague, savantChoiceKey, savantDayIndex } from "@/lib/league-savant";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
function same(label: string, got: unknown, want: unknown) {
  check(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} !== ${JSON.stringify(want)}`);
}

// The card is handed the in-season leagues only, alphabetical; NBA and WNBA here are out of season.
const IN_SEASON = ["MLB", "NCAAF", "NFL", "NHL"];

same("day 0 is the epoch", savantDayIndex(SAVANT_ROTATION_EPOCH), 0);
same("a day later is day 1; across a month and a leap day too", [savantDayIndex("2026-01-02"), savantDayIndex("2026-02-01"), savantDayIndex("2028-03-01") - savantDayIndex("2028-02-28")], [1, 31, 2]);
same("across the spring-forward and fall-back days, still one step a day", [savantDayIndex("2026-03-09") - savantDayIndex("2026-03-08"), savantDayIndex("2026-11-02") - savantDayIndex("2026-11-01")], [1, 1]);

same("the same date gives the same league, every time", [defaultSavantLeague(IN_SEASON, "2026-10-06"), defaultSavantLeague(IN_SEASON, "2026-10-06")], ["NFL", "NFL"]);
check("the next day gives a different league", defaultSavantLeague(IN_SEASON, "2026-10-07") !== defaultSavantLeague(IN_SEASON, "2026-10-06"));
same("it steps through the list in order and wraps", ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((d) => defaultSavantLeague(IN_SEASON, d)), ["MLB", "NCAAF", "NFL", "NHL", "MLB"]);
const year = Array.from({ length: 366 }, (_, i) => defaultSavantLeague(IN_SEASON, new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10)));
check("an out-of-season league is never the day's league", year.every((l) => l !== null && IN_SEASON.includes(l)) && !year.includes("NBA") && !year.includes("WNBA"));
check("every in-season league gets its days", IN_SEASON.every((l) => year.includes(l)));
same("one league in season: that one, every day", [defaultSavantLeague(["NFL"], "2026-10-06"), defaultSavantLeague(["NFL"], "2026-10-07")], ["NFL", "NFL"]);
same("none in season: no league", defaultSavantLeague([], "2026-10-06"), null);
same("a date before the epoch still lands in the list", defaultSavantLeague(IN_SEASON, "2025-12-31"), "NHL");

// The league changes at midnight Eastern, not midnight UTC: 03:59Z is still the evening before in New York.
same("the day is the Eastern one", [easternDateKey(new Date("2026-10-07T03:59:00Z")), easternDateKey(new Date("2026-10-07T04:00:00Z"))], ["2026-10-06", "2026-10-07"]);
check("so the league holds until midnight Eastern, then steps", defaultSavantLeague(IN_SEASON, easternDateKey(new Date("2026-10-07T03:59:00Z"))) === "NFL" && defaultSavantLeague(IN_SEASON, easternDateKey(new Date("2026-10-07T04:00:00Z"))) === "NHL");

check("a viewer's choice is stored under the day, so the next day does not find it", savantChoiceKey("2026-10-06") !== savantChoiceKey("2026-10-07") && savantChoiceKey("2026-10-06").includes("2026-10-06"));

if (failures > 0) process.exit(1);
console.log("\nAll checks passed.");
