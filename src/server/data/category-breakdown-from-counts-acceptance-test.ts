// categoryBreakdownFromCounts (stats.ts) - the one mapping from per-category win/loss/push
// counts to tiles, shared by computeCategoryBreakdown (counts from picks in JS) and the SQL
// tile fragment (counts grouped by the database). Pure: no database.
//   - the mapping itself: label, winPct with pushes out of the denominator, count, `order`,
//     the drop of a category with no decided pick, duplicate rows summed, unknown keys ignored;
//   - computeCategoryBreakdown, refactored to call it, returns exactly what it returned before
//     (checked against an independent re-derivation on synthetic picks, with and without recentForm).
import {
  DEFAULT_CHIP_SET,
  PICK_CATEGORY_LABELS,
  categoryBreakdownFromCounts,
  chipSetForLeague,
  computeCategoryBreakdown,
  computeStats,
  pickCategory,
  type PickCategoryKey,
} from "@/server/data/stats";
import type { Pick } from "@prisma/client";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- the mapping ---
{
  const order: PickCategoryKey[] = ["FAV_ML", "DOG_ML", "OVER", "UNDER"];
  const out = categoryBreakdownFromCounts(
    [
      { category: "UNDER", wins: 1, losses: 3, pushes: 2 },
      { category: "FAV_ML", wins: 3, losses: 1, pushes: 1 },
      { category: "DOG_ML", wins: 0, losses: 0, pushes: 0 }, // no decided pick: no tile
      { category: "SPREAD_MINUS", wins: 9, losses: 0, pushes: 0 }, // not in `order`: ignored
      { category: "OVER", wins: 0, losses: 0, pushes: 4 }, // pushes only: a tile, winPct 0
    ],
    order
  );
  check("tiles come out in the caller's order, not the input order, with zero-count and out-of-order keys dropped", eq(out.map((t) => t.key), ["FAV_ML", "OVER", "UNDER"]));
  check("label is PICK_CATEGORY_LABELS[key]", out.every((t) => t.label === PICK_CATEGORY_LABELS[t.key]));
  check("winPct is wins/(wins+losses)*100 with pushes out of the denominator: 3-1-1 -> 75, 1-3-2 -> 25", out[0].winPct === 75 && out[2].winPct === 25);
  check("count = wins + losses + pushes; a pushes-only category is a tile at 0%", out[0].count === 5 && out[1].count === 4 && out[1].winPct === 0);
  check("no money field and no `recent` key on a tile", out.every((t) => !("recent" in t) && !("netUnits" in t) && !("unitsWon" in t)));

  const summed = categoryBreakdownFromCounts(
    [
      { category: "FAV_ML", wins: 2, losses: 1, pushes: 0 }, // e.g. the same category in two sports
      { category: "FAV_ML", wins: 1, losses: 1, pushes: 1 },
    ],
    order
  );
  check("rows for one category are summed before winPct is taken (3-2-1 -> 60%, not an average of 66.7 and 50)", eq(summed.map((t) => [t.wins, t.losses, t.pushes, t.winPct, t.count]), [[3, 2, 1, 60, 6]]));
  check("no rows -> no tiles", categoryBreakdownFromCounts([], order).length === 0);
  check("an empty order -> no tiles", categoryBreakdownFromCounts([{ category: "FAV_ML", wins: 1, losses: 0, pushes: 0 }], []).length === 0);
}

// --- computeCategoryBreakdown after the refactor ---
{
  function rng(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const r = rng(5);
  const T = Date.UTC(2026, 5, 1);
  const picks: (Pick & { sport: { name: string } })[] = [];
  for (let i = 0; i < 300; i++) {
    const betType = (["MONEYLINE", "MONEYLINE", "SPREAD", "TOTAL", "NRFI"] as const)[Math.floor(r() * 5)];
    const x = r();
    const line = betType === "SPREAD" ? (r() < 0.5 ? -1 : 1) * (0.5 + Math.floor(r() * 9)) : betType === "TOTAL" ? 5.5 + Math.floor(r() * 30) : null;
    picks.push({
      id: `p${String(i).padStart(4, "0")}`,
      userId: "u",
      capperId: "c",
      sportId: "s",
      leagueId: null,
      homeTeam: "H",
      awayTeam: "A",
      betType,
      betDetail: betType === "TOTAL" ? `${r() < 0.5 ? "Over" : "Under"} ${line}` : betType === "SPREAD" ? `T ${line}` : betType === "NRFI" ? (r() < 0.5 ? "NRFI" : "YRFI") : null,
      odds: [-110, -150, 120, 200, -300, 105][Math.floor(r() * 6)],
      line,
      period: "FULL_GAME",
      units: [0.5, 1, 2][Math.floor(r() * 3)],
      gameTime: new Date(T + i * 3600000),
      createdAt: new Date(T + i * 1000),
      status: x < 0.4 ? "WIN" : x < 0.75 ? "LOSS" : x < 0.83 ? "PUSH" : x < 0.93 ? "PENDING" : "CANCELLED",
      sport: { name: r() < 0.7 ? "MLB" : "NFL" },
    } as Pick & { sport: { name: string } });
  }
  // Independent re-derivation: group by runtime pickCategory, count W/L/P, in `order`, drop count 0.
  const reference = (list: typeof picks, order: PickCategoryKey[]) =>
    order
      .map((key) => {
        const own = list.filter((p) => pickCategory({ ...p, sportName: p.sport.name }) === key);
        const s = computeStats(own);
        return { key, label: PICK_CATEGORY_LABELS[key], wins: s.wins, losses: s.losses, pushes: s.pushes, winPct: s.winPct, count: s.wins + s.losses + s.pushes };
      })
      .filter((t) => t.count > 0);

  for (const [name, order] of [["DEFAULT_CHIP_SET", DEFAULT_CHIP_SET], ["MLB chips", chipSetForLeague("MLB")]] as const) {
    check(`computeCategoryBreakdown(${name}) == independent re-derivation over 300 synthetic picks`, eq(computeCategoryBreakdown(picks, order), reference(picks, order)));
  }
  const withRecent = computeCategoryBreakdown(picks, chipSetForLeague("MLB"), { window: 5, minSample: 30 });
  const without = computeCategoryBreakdown(picks, chipSetForLeague("MLB"));
  check("recentForm: tiles are otherwise identical, and `recent` is present on every tile (null below minSample)", eq(withRecent.map(({ recent: _r, ...t }) => t), without) && withRecent.every((t) => "recent" in t));
  check("recentForm: minSample is honored (a tile under it is null, one at/over it is populated)", withRecent.some((t) => t.recent === null && t.count < 30) && (withRecent.every((t) => t.count < 30 || t.recent !== null && t.recent !== undefined)));
  check("without recentForm no tile has a `recent` key", without.every((t) => !("recent" in t)));
}

console.log(`\n${failures} failed.`);
process.exit(failures > 0 ? 1 : 0);
