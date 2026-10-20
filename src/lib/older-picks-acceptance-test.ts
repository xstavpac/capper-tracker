// lib/older-picks.ts, the pure half of /picks "Load older picks": what the
// action accepts from the client, the final-score windows, the day grouping,
// and the filter key that resets loaded rows. Pure, no DB:
//   npx tsx src/lib/older-picks-acceptance-test.ts
import {
  groupByDay,
  mergedTimeWindows,
  olderPicksQueryKey,
  parseOlderPicksCursor,
  parseOlderPicksQuery,
  OLDER_PICKS_MAX_PAGES_PER_CLICK,
  OLDER_PICKS_MIN_VISIBLE,
  OLDER_PICKS_PAGE_SIZE,
} from "@/lib/older-picks";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

// Sizes
expect("page size 50, at least 10 visible, at most 3 pages a click", [OLDER_PICKS_PAGE_SIZE, OLDER_PICKS_MIN_VISIBLE, OLDER_PICKS_MAX_PAGES_PER_CLICK], [50, 10, 3]);

// Query validation
const ok = { capperId: "cmgx1abc", sportId: "cmgy2def", status: "WIN", betType: "F5_TOTAL", before: "2026-10-20" };
expect("a full, well-formed query passes as is", parseOlderPicksQuery(ok), ok);
expect("empty filters are dropped", parseOlderPicksQuery({ before: "2026-10-20", capperId: "", sportId: undefined }), { before: "2026-10-20" });
for (const [label, q] of [
  ["no window start", { capperId: "abc" }],
  ["window start not a date key", { before: "2026-10-2" }],
  ["window start not a real date", { before: "2026-13-45" }],
  ["capper id with SQL in it", { before: "2026-10-20", capperId: "a' OR '1'='1" }],
  ["sport id too long", { before: "2026-10-20", sportId: "x".repeat(65) }],
  ["unknown status", { before: "2026-10-20", status: "WON" }],
  ["lower-case bet type", { before: "2026-10-20", betType: "total" }],
  ["a field the page never sends (userId)", { before: "2026-10-20", userId: "someone" }],
  ["a non-string value", { before: "2026-10-20", capperId: 7 }],
  ["not an object", "before=2026-10-20"],
  ["null", null],
] as [string, unknown][]) {
  expect(`refused: ${label}`, parseOlderPicksQuery(q), null);
}

// Cursor validation
expect("no cursor: the first click", parseOlderPicksCursor(null), null);
expect("a well-formed cursor passes", parseOlderPicksCursor({ gameTime: "2026-10-19T23:05:00.000Z", id: "cmh0abc" }), { gameTime: "2026-10-19T23:05:00.000Z", id: "cmh0abc" });
for (const [label, c] of [
  ["a date that is not a canonical ISO string", { gameTime: "2026-10-19", id: "abc" }],
  ["an unparseable date", { gameTime: "yesterday", id: "abc" }],
  ["an id with a space", { gameTime: "2026-10-19T23:05:00.000Z", id: "a b" }],
  ["a missing id", { gameTime: "2026-10-19T23:05:00.000Z" }],
  ["a string", "2026-10-19T23:05:00.000Z|abc"],
] as [string, unknown][]) {
  expect(`refused cursor: ${label}`, parseOlderPicksCursor(c), "invalid");
}

// Filter key: any filter change resets, field order doesn't matter, empties don't count.
expect("same filters, same key", olderPicksQueryKey({ before: "2026-10-20", capperId: "a", status: "WIN" }), olderPicksQueryKey({ status: "WIN", capperId: "a", before: "2026-10-20" }));
expect("an empty filter is no filter", olderPicksQueryKey({ before: "2026-10-20", sportId: "" }), olderPicksQueryKey({ before: "2026-10-20" }));
expect("each filter changes the key", new Set([
  olderPicksQueryKey({ before: "2026-10-20" }),
  olderPicksQueryKey({ before: "2026-10-19" }),
  olderPicksQueryKey({ before: "2026-10-20", capperId: "a" }),
  olderPicksQueryKey({ before: "2026-10-20", sportId: "a" }),
  olderPicksQueryKey({ before: "2026-10-20", status: "WIN" }),
  olderPicksQueryKey({ before: "2026-10-20", betType: "TOTAL" }),
]).size, 6);

// Final-score windows: +-pad around each time, overlapping ones merged, a gap kept out.
const D = 86_400_000;
expect("one time: one window", mergedTimeWindows([10 * D], 2 * D), [{ start: 8 * D, end: 12 * D }]);
expect("times 3 days apart overlap into one window", mergedTimeWindows([13 * D, 10 * D], 2 * D), [{ start: 8 * D, end: 15 * D }]);
expect("times 4 weeks apart stay two windows", mergedTimeWindows([0, 28 * D], 2 * D), [{ start: -2 * D, end: 2 * D }, { start: 26 * D, end: 30 * D }]);
expect("touching windows merge", mergedTimeWindows([0, 4 * D], 2 * D), [{ start: -2 * D, end: 6 * D }]);
expect("no times, no windows", mergedTimeWindows([], 2 * D), []);

// Day grouping over the merged list: one header per day even when a day spans two clicks.
const click1 = [{ id: "a", day: "10-19" }, { id: "b", day: "10-19" }, { id: "c", day: "10-18" }];
const click2 = [{ id: "d", day: "10-18" }, { id: "e", day: "10-17" }];
const merged = groupByDay([...click1, ...click2], (r) => r.day);
expect("a day split across clicks gets one header", merged.map((g) => [g.dayKey, g.rows.map((r) => r.id).join("")]), [["10-19", "ab"], ["10-18", "cd"], ["10-17", "e"]]);
expect("grouping per click would have given 10-18 two headers", [...groupByDay(click1, (r) => r.day), ...groupByDay(click2, (r) => r.day)].filter((g) => g.dayKey === "10-18").length, 2);

console.log(failures ? `\n${failures} FAILED` : "\nAll older-picks checks passed.");
process.exit(failures ? 1 : 0);
