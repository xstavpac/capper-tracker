// Behavior + parity tests for the shared SQL building blocks in page-aggregate-fragments.ts
// (docs/design/dashboard-capper-detail-egress.md §3, §4.1, §8). Each block is compared with
// the JS it will stand in for, on the same rows:
//   - window totals with groupBySport  vs computeStats / recordStatsFromTotals per (window, sport)
//   - category tiles + sport first keys vs computeCategoryBreakdown, the tab sort, first appearance
//   - dashboard / capper recent picks   vs the newest-N slice and selectCapperRecentPicks
//   - pending counts                    vs the JS filters
//   - the narrow decided series         vs the full Pick rows: exact Date round trip, gradedAt
//                                       null-ness, order, and - the round-trip test - that the
//                                       existing JS functions return IDENTICAL results on it
//   - one composed statement (buildPageBundleQuery) returning the same rows as the parts run alone
//
// DB-backed and WRITING: every id is prefixed `__PageFragments__` and deleted by exact id at the end;
// refuses to run unless DATABASE_URL is local. Times are fixed (not Date.now()) and `now` is pinned, so
// the window edges are deterministic. Run against a disposable local Postgres with migrations applied.
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  DEFAULT_CHIP_SET,
  PICK_CATEGORY_VERSION,
  categoryBreakdownFromCounts,
  chipSetForLeague,
  computeBestOddsRange,
  computeCategoryBreakdown,
  computeConsistency,
  computeMomentum,
  computeStats,
  computeUnitsChartData,
  currentStreak,
  pickCategory,
  recordStatsFromTotals,
  scorecardWindowRange,
  selectCapperRecentPicks,
  betTypeLabel,
  type PickCategoryKey,
  type ScorecardWindow,
} from "@/server/data/stats";
import { formatPickLabel } from "@/lib/bet-line";
import { comparePicksChronological, comparePicksChronologicalDesc } from "@/lib/pick-order";
import { queryWindowTotals, windowTotalsSelect, windowsCte } from "@/server/data/capper-list-aggregates";
import {
  CAPPER_RECENT_ORDER_BY,
  DASHBOARD_RECENT_ORDER_BY,
  DECIDED_SERIES_ORDER_BY,
  buildPageBundleQuery,
  capperRecentPicksFromRows,
  capperRecentPicksSelect,
  categoryTileRowsFromBundle,
  categoryTilesSelect,
  chronoKeyOf,
  dashboardRecentPicksFromRows,
  dashboardRecentPicksSelect,
  decidedSeriesSelect,
  narrowSeriesFromRows,
  pendingCountsFromBundle,
  pendingCountsSelect,
  queryDecidedSeries,
  queryPageBundle,
  sportFirstKeysFromBundle,
  sportFirstKeysSelect,
  type CategoryTileRow,
} from "@/server/data/page-aggregate-fragments";

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostOf(process.env.DATABASE_URL))) {
  console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures and only runs against localhost/127.0.0.1.");
  process.exit(0);
}

let failures = 0;
let assertions = 0;
function check(label: string, pass: boolean, detail = "") {
  assertions++;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
// Deep equality that treats -0 as +0 (design doc §5) and NaN as NaN; returns the first differing path.
function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b)) ? null : `${path}: ${a} !== ${b}`;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? null : `${path}: ${a.toISOString()} !== ${b.toISOString()}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b ? null : `${path}: ${String(a)} !== ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs non-array`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.join(",") !== kb.join(",")) return `${path}: keys [${ka}] !== [${kb}]`;
  for (const k of ka) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}
function same(label: string, actual: unknown, expected: unknown) {
  const d = firstDiff(actual, expected);
  check(label, d === null, d ?? "");
}

const PREFIX = "__PageFragments__";
// 16:00 UTC = noon Eastern: the Eastern-day boundary (04:00 UTC) is 12 h back, nowhere near a fixture's minute+30 s.
const NOW = new Date(Date.UTC(2026, 8, 20, 16, 0, 0));
const ago = (minutes: number, seconds = 30) => new Date(NOW.getTime() - minutes * 60000 - seconds * 1000);
const WINDOWS: ScorecardWindow[] = ["ALL", "TODAY", "YESTERDAY", "LAST_7", "LAST_30", "LAST_60"];

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const createdUserIds: string[] = [];
const createdSportIds: string[] = [];
const sportIdByName = new Map<string, string>();
async function ensureSport(name: string) {
  const existing = await prisma.sport.findUnique({ where: { name } });
  if (existing) return void sportIdByName.set(name, existing.id);
  const s = await prisma.sport.create({ data: { name } });
  createdSportIds.push(s.id);
  sportIdByName.set(name, s.id);
}

type Spec = {
  capperId: string;
  sport: string;
  betType?: Prisma.PickUncheckedCreateInput["betType"];
  period?: Prisma.PickUncheckedCreateInput["period"];
  betDetail?: string | null;
  odds?: number;
  line?: number | null;
  units?: number;
  status?: Prisma.PickUncheckedCreateInput["status"];
  gameTime: Date;
  gradedAt?: Date | null | "auto";
  createdAt?: Date;
  unstamped?: boolean;
  homeTeam?: string;
  awayTeam?: string;
};
let seq = 0;
function row(userId: string, s: Spec): Prisma.PickCreateManyInput {
  seq++;
  const betType = s.betType ?? "MONEYLINE";
  const period = s.period ?? "FULL_GAME";
  const odds = s.odds ?? -110;
  const line = s.line ?? null;
  const betDetail = s.betDetail ?? null;
  const status = s.status ?? "WIN";
  const category = s.unstamped
    ? null
    : pickCategory({ betType, period, betDetail, odds, line, sportName: s.sport, pickedSide: null, mlFavoredSide: null, propMarket: null });
  return {
    id: `${PREFIX}p${String(seq).padStart(5, "0")}`,
    userId,
    capperId: s.capperId,
    sportId: sportIdByName.get(s.sport)!,
    homeTeam: s.homeTeam ?? "Home",
    awayTeam: s.awayTeam ?? "Away",
    betType,
    betDetail,
    odds,
    line,
    period,
    units: s.units ?? 1,
    datePosted: s.gameTime,
    gameTime: s.gameTime,
    status,
    gradedAt: s.gradedAt === "auto" || s.gradedAt === undefined ? (status === "PENDING" ? null : new Date(s.gameTime.getTime() + 3 * 3600000)) : s.gradedAt,
    createdAt: s.createdAt ?? new Date(NOW.getTime() - seq * 1000),
    category,
    categoryVersion: s.unstamped ? 0 : PICK_CATEGORY_VERSION,
  };
}

function randomSpecs(capperId: string, n: number, seed: number): Spec[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const specs: Spec[] = [];
  for (let i = 0; i < n; i++) {
    const sport = pick(["MLB", "MLB", "MLB", "NFL", "NFL", "NHL"]);
    const betType = pick(["MONEYLINE", "MONEYLINE", "SPREAD", "TOTAL", "TEAM_TOTAL", "NRFI"] as const);
    const period = r() < 0.12 ? pick(["FIRST_HALF", "FIRST_QUARTER", "SECOND_HALF"] as const) : "FULL_GAME";
    const lineSign = r() < 0.5 ? -1 : 1;
    const line = betType === "SPREAD" ? lineSign * (0.5 + Math.floor(r() * 12)) : betType === "TOTAL" || betType === "TEAM_TOTAL" ? 4.5 + Math.floor(r() * 40) : null;
    const betDetail =
      betType === "TOTAL" || betType === "TEAM_TOTAL" ? `${r() < 0.5 ? "Over" : "Under"} ${line}` : betType === "SPREAD" ? `Team ${line! > 0 ? "+" : ""}${line}` : betType === "NRFI" ? (r() < 0.5 ? "NRFI" : "YRFI") : null;
    const x = r();
    const status = x < 0.36 ? "WIN" : x < 0.72 ? "LOSS" : x < 0.8 ? "PUSH" : x < 0.9 ? "PENDING" : "CANCELLED";
    const minutes = Math.floor(r() * 70 * 1440);
    const prev = specs[i - 1];
    specs.push({
      capperId,
      sport,
      betType,
      period,
      betDetail,
      odds: pick([-110, -110, -130, -180, -250, 100, 120, 150, 210, 340, -105]),
      line,
      units: pick([0.5, 1, 1, 1.5, 2, 0.25, 3]),
      status,
      // Every 6th pick shares the previous pick's gameTime: ties broken by (createdAt, id).
      gameTime: i % 6 === 5 && prev ? prev.gameTime : ago(minutes),
      // ~15% of decided picks have no gradedAt: outside ALL they belong to no window.
      gradedAt: status === "PENDING" ? null : r() < 0.15 ? null : "auto",
      // ~5% unstamped: absent from every tile by design (G4).
      unstamped: r() < 0.05,
      createdAt: new Date(NOW.getTime() - Math.floor(r() * 1e7) * 1000),
    });
  }
  return specs;
}

type FullPick = Prisma.PickGetPayload<{ include: { sport: { select: { name: true } }; capper: { select: { name: true } } } }>;
async function loadPicks(userId: string, capperId?: string): Promise<FullPick[]> {
  const rows = await prisma.pick.findMany({
    where: { userId, ...(capperId ? { capperId } : {}) },
    include: { sport: { select: { name: true } }, capper: { select: { name: true } } },
  });
  return rows.sort(comparePicksChronological);
}
// The JS window filter, against the pinned NOW (filterPicksByGameWindow itself reads the wall clock).
function inWindow<T extends { gameTime: Date; gradedAt: Date | null }>(picks: T[], w: ScorecardWindow): T[] {
  const range = scorecardWindowRange(w, NOW);
  if (!range) return picks;
  return picks.filter((p) => p.gradedAt && p.gameTime >= range.start && p.gameTime < range.end);
}
const isTileEligible = (p: { categoryVersion: number }) => p.categoryVersion !== 0; // unstamped rows are absent from SQL tiles (G4)

async function main() {
  for (const s of ["MLB", "NFL", "NHL"]) await ensureSport(s);
  const userId = `${PREFIX}user`;
  await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}@example.invalid` } });
  createdUserIds.push(userId);
  const [capA, capB, capEmpty] = ["a", "b", "empty"].map((k) => `${PREFIX}capper-${k}`);
  for (const [id, name] of [[capA, "A"], [capB, "B"], [capEmpty, "Empty"]]) await prisma.capper.create({ data: { id, userId, name, source: "OTHER" } });

  // Capper A: 220 random picks over 70 days, three sports, every status, gradedAt gaps, ties, unstamped rows.
  await prisma.pick.createMany({ data: randomSpecs(capA, 220, 11).map((s) => row(userId, s)) });
  // Capper B: two sports with EXACTLY equal tile totals. NFL and MLB share the first gameTime and NFL has the
  // earlier createdAt, so NFL appears first and the stable sort must keep NFL before MLB; alphabetical order
  // (MLB, NFL) would be the wrong answer. Plus an all-PENDING sport that has no tile (so no tab).
  const tieStart = ago(3000);
  await prisma.pick.createMany({
    data: [
      { sport: "NFL", gameTime: tieStart, createdAt: ago(9001), status: "WIN" }, // same gameTime, EARLIER createdAt -> NFL is first
      { sport: "MLB", gameTime: tieStart, createdAt: ago(9000), status: "WIN" },
      { sport: "NFL", gameTime: ago(2900), status: "LOSS" },
      { sport: "MLB", gameTime: ago(2800), status: "LOSS" },
      { sport: "NFL", gameTime: ago(2700), status: "WIN" },
      { sport: "MLB", gameTime: ago(2600), status: "WIN" },
      { sport: "NHL", gameTime: ago(2500), status: "PENDING" },
    ].map((s) => row(userId, { capperId: capB, odds: -150, ...s } as Spec)),
  });

  const allPicks = await loadPicks(userId);
  const picksA = await loadPicks(userId, capA);
  const picksB = await loadPicks(userId, capB);
  check(`fixture: capper A has ${picksA.length} picks incl. all statuses and unstamped rows`, picksA.length === 220 && new Set(picksA.map((p) => p.status)).size === 5 && picksA.some((p) => p.categoryVersion === 0));

  // ---- 3.a totals: groupBySport ----------------------------------------------------------
  {
    const plain = await queryWindowTotals({ userId, capperIds: [capA], windows: WINDOWS, now: NOW });
    check("queryWindowTotals (refactored onto windowTotalsSelect): rows carry no `sport` key unless groupBySport", plain.every((r) => !("sport" in r)));
    const bySport = await queryWindowTotals({ userId, capperIds: [capA], windows: WINDOWS, now: NOW, groupBySport: true });
    const sports = Array.from(new Set(picksA.map((p) => p.sport.name)));
    let bad = "";
    let rowsSeen = 0;
    for (const w of WINDOWS) {
      for (const sport of sports) {
        const set = inWindow(picksA, w).filter((p) => p.sport.name === sport);
        const got = bySport.find((r) => r.window === w && r.sport === sport);
        if (set.length === 0) {
          if (got) bad ||= `${w}/${sport}: unexpected row`;
          continue;
        }
        rowsSeen++;
        if (!got) {
          bad ||= `${w}/${sport}: missing row`;
          continue;
        }
        const stats = computeStats(set);
        const fromTotals = recordStatsFromTotals(got);
        const { currentStreak: _c, longestWinStreak: _l1, longestLossStreak: _l2, ...expected } = stats;
        const d = firstDiff(fromTotals, expected, `${w}/${sport}`) ?? (got.nPicks === set.length ? null : `${w}/${sport}: nPicks ${got.nPicks} vs ${set.length}`);
        if (d) bad ||= d;
      }
    }
    check(`groupBySport: ${rowsSeen} (window, sport) rows == computeStats over the windowed sport picks (record, units, ROI, nPicks incl. CANCELLED-with-gradedAt)`, bad === "", bad);
    // Every plain (window) row is the sum of its sport rows: counts exactly, nPicks included.
    let sumBad = "";
    for (const p of plain) {
      const parts = bySport.filter((r) => r.window === p.window);
      const t = (k: "nPicks" | "wins" | "losses" | "pushes") => parts.reduce((a, r) => a + r[k], 0);
      for (const k of ["nPicks", "wins", "losses", "pushes"] as const) if (t(k) !== p[k]) sumBad ||= `${p.window}.${k}: ${t(k)} vs ${p[k]}`;
    }
    check("groupBySport rows sum to the ungrouped window rows", sumBad === "", sumBad);
    const nonAll = bySport.filter((r) => r.window !== "ALL");
    const gradedNull = picksA.filter((p) => p.status !== "PENDING" && !p.gradedAt).length;
    check(`fixture: ${gradedNull} decided/cancelled picks with gradedAt NULL exist and are excluded outside ALL`, gradedNull > 0 && nonAll.reduce((a, r) => a + r.nPicks, 0) <= WINDOWS.length * picksA.length);
    const pooled = await queryWindowTotals({ userId, pooled: true, windows: ["ALL"], now: NOW, groupBySport: true });
    const jsAll = computeStats(allPicks);
    const t = pooled.reduce((a, r) => ({ w: a.w + r.wins, l: a.l + r.losses, n: a.n + r.nPicks }), { w: 0, l: 0, n: 0 });
    check("pooled + groupBySport, ALL: no capperId, sport rows sum to the user's record and pick count", pooled.every((r) => r.capperId === null && r.sport) && t.w === jsAll.wins && t.l === jsAll.losses && t.n === allPicks.length);
  }

  // ---- 3.b tiles + first keys ---------------------------------------------------------------
  {
    const bundle = await queryPageBundle(
      buildPageBundleQuery({
        windows: { windows: ["ALL", "LAST_7", "LAST_30"], now: NOW },
        parts: [
          { name: "tiles", select: categoryTilesSelect({ userId, capperId: capA, groupBySport: true }) },
          { name: "firstKeys", select: sportFirstKeysSelect({ userId, capperId: capA }) },
        ],
      })
    );
    const tiles = categoryTileRowsFromBundle(bundle.tiles);
    const eligibleA = picksA.filter(isTileEligible);
    const sumOverSports = (win: ScorecardWindow, chip: string[]) => tiles.filter((t) => t.window === win && chip.includes(t.category));
    const bt = (rows: CategoryTileRow[], order: PickCategoryKey[]) => categoryBreakdownFromCounts(rows, order);

    same("tiles, all-time all-sports (the render gate): SQL rows -> categoryBreakdownFromCounts == computeCategoryBreakdown(picks, DEFAULT_CHIP_SET)", bt(sumOverSports("ALL", DEFAULT_CHIP_SET), DEFAULT_CHIP_SET), computeCategoryBreakdown(eligibleA, DEFAULT_CHIP_SET));
    same("tiles, `window` (LAST_7) all-sports", bt(sumOverSports("LAST_7", DEFAULT_CHIP_SET), DEFAULT_CHIP_SET), computeCategoryBreakdown(inWindow(eligibleA, "LAST_7"), DEFAULT_CHIP_SET));
    const sports = Array.from(new Set(picksA.map((p) => p.sport.name)));
    for (const sport of sports) {
      const chip = chipSetForLeague(sport);
      const sportRows = (win: ScorecardWindow) => tiles.filter((t) => t.window === win && t.sport === sport);
      same(`tiles, ${sport} all-time with chipSetForLeague(${sport})`, bt(sportRows("ALL"), chip), computeCategoryBreakdown(eligibleA.filter((p) => p.sport.name === sport), chip));
      same(`tiles, ${sport} categoryWindow LAST_30`, bt(sportRows("LAST_30"), chip), computeCategoryBreakdown(inWindow(eligibleA, "LAST_30").filter((p) => p.sport.name === sport), chip));
    }
    const unstampedDecided = picksA.filter((p) => p.categoryVersion === 0 && ["WIN", "LOSS", "PUSH"].includes(p.status)).length;
    const tileTotal = tiles.filter((t) => t.window === "ALL").reduce((a, t) => a + t.wins + t.losses + t.pushes, 0);
    const stampedNullDecided = eligibleA.filter((p) => p.category === null && ["WIN", "LOSS", "PUSH"].includes(p.status)).length;
    const decided = picksA.filter((p) => ["WIN", "LOSS", "PUSH"].includes(p.status)).length;
    check(`tiles omit NULL-category rows (${unstampedDecided} unstamped + ${stampedNullDecided} stamped-null decided) - counted in totals, in no tile`, unstampedDecided > 0 && tileTotal === decided - unstampedDecided - stampedNullDecided);
    check("tiles: PENDING/CANCELLED never appear (only WIN/LOSS/PUSH rows are grouped)", tileTotal <= decided);

    // Sport tabs: tile-total desc, ties by first appearance over ALL statuses - capper B has an exact tie.
    const tabsFor = async (capperId: string, picks: FullPick[]) => {
      const b = await queryPageBundle(
        buildPageBundleQuery({
          windows: { windows: ["ALL"], now: NOW },
          parts: [
            { name: "tiles", select: categoryTilesSelect({ userId, capperId, groupBySport: true }) },
            { name: "firstKeys", select: sportFirstKeysSelect({ userId, capperId }) },
          ],
        })
      );
      const tr = categoryTileRowsFromBundle(b.tiles);
      const fk = new Map(sportFirstKeysFromBundle(b.firstKeys).map((r) => [r.sport, r.firstKey]));
      const sqlTabs = Array.from(new Set(tr.map((t) => t.sport!)))
        .map((sport) => ({ sport, total: categoryBreakdownFromCounts(tr.filter((t) => t.sport === sport), chipSetForLeague(sport)).reduce((a, i) => a + i.count, 0) }))
        .filter((t) => t.total > 0)
        .sort((x, y) => y.total - x.total || (fk.get(x.sport)! < fk.get(y.sport)! ? -1 : 1))
        .map((t) => t.sport);
      // The page's JS today: first-appearance order over ALL statuses, stable sort by total tile count desc.
      const jsTabs = Array.from(new Set(picks.map((p) => p.sport.name)))
        .map((sport) => ({ sport, total: computeCategoryBreakdown(picks.filter((p) => p.sport.name === sport), chipSetForLeague(sport)).reduce((a, i) => a + i.count, 0) }))
        .filter((t) => t.total > 0)
        .sort((x, y) => y.total - x.total)
        .map((t) => t.sport);
      return { sqlTabs, jsTabs, fk, firstAppearance: Array.from(new Set(picks.map((p) => p.sport.name))) };
    };
    const a = await tabsFor(capA, eligibleA.length === picksA.length ? picksA : picksA.filter(isTileEligible));
    same("sport tabs, capper A (random totals): SQL tab order == JS tab order", a.sqlTabs, a.jsTabs);
    const bTabs = await tabsFor(capB, picksB);
    same("sport tabs, capper B (NFL and MLB tied on tile total; PENDING-only NHL has no tab): SQL == JS", bTabs.sqlTabs, bTabs.jsTabs);
    check("capper B: equal totals, so first appearance decides: NFL before MLB (alphabetical would say MLB first)", bTabs.sqlTabs.join() === "NFL,MLB", bTabs.sqlTabs.join());
    same("capper B: firstKey order == first-appearance order over ALL statuses (gameTime, then createdAt)", Array.from(bTabs.fk.entries()).sort((x, y) => (x[1] < y[1] ? -1 : 1)).map(([s]) => s), bTabs.firstAppearance);
    const minKeys = new Map<string, string>();
    for (const p of picksA) {
      const k = chronoKeyOf(p);
      if (!minKeys.has(p.sport.name) || k < minKeys.get(p.sport.name)!) minKeys.set(p.sport.name, k);
    }
    same("sportFirstKeysSelect == chronoKeyOf min per sport over every status", Object.fromEntries(a.fk), Object.fromEntries(minKeys));

    // Dashboard shape: user-wide, ALL, no sport grouping, DEFAULT_CHIP_SET pushed down.
    const dash = await queryPageBundle(
      buildPageBundleQuery({ windows: { windows: ["ALL"], now: NOW }, parts: [{ name: "tiles", select: categoryTilesSelect({ userId, chipSet: DEFAULT_CHIP_SET }) }] })
    );
    const dashRows = categoryTileRowsFromBundle(dash.tiles);
    check("dashboard tiles: at most 6 rows, only chip-set categories, no sport column", dashRows.length <= 6 && dashRows.every((r) => DEFAULT_CHIP_SET.includes(r.category as PickCategoryKey) && r.sport === undefined));
    same("dashboard tiles == computeCategoryBreakdown(all the user's picks, DEFAULT_CHIP_SET)", categoryBreakdownFromCounts(dashRows, DEFAULT_CHIP_SET), computeCategoryBreakdown(allPicks.filter(isTileEligible), DEFAULT_CHIP_SET));
  }

  // ---- 3.d recents -----------------------------------------------------------------------------
  {
    // Ties on gameTime across a LIMIT edge: five picks share one gameTime, createdAt decides.
    const tieCapper = capB;
    const bundle = await queryPageBundle(
      buildPageBundleQuery({
        parts: [
          { name: "dash", select: dashboardRecentPicksSelect({ userId }), orderBy: DASHBOARD_RECENT_ORDER_BY },
          { name: "recents", select: capperRecentPicksSelect({ userId, capperId: capA }), orderBy: CAPPER_RECENT_ORDER_BY },
        ],
      })
    );
    const legacyDash = [...allPicks].sort(comparePicksChronologicalDesc).slice(0, 10).map((p) => ({
      id: p.id,
      awayTeam: p.awayTeam,
      homeTeam: p.homeTeam,
      label: formatPickLabel(p.betDetail, p.betType, p.line) ?? betTypeLabel(p.betType),
      capperName: p.capper.name,
      status: p.status,
      units: p.units,
    }));
    same("dashboard recent 10: SQL (ORDER_DESC, LIMIT 10, capper name only) == the newest 10 of the full fetch, flattened", dashboardRecentPicksFromRows(bundle.dash), legacyDash);
    void tieCapper;

    const ascA = picksA; // already gameTime asc with the canonical tie-break
    const slim = (x: { picks: { id: string; awayTeam: string; homeTeam: string; betDetail: string | null; betType: string; line: number | null; odds: number; units: number; gameTime: Date; status: string; sport: { name: string } | string }[]; scopedSport: string | null }) => ({
      scopedSport: x.scopedSport,
      picks: x.picks.map((p) => ({ id: p.id, awayTeam: p.awayTeam, homeTeam: p.homeTeam, betDetail: p.betDetail, betType: p.betType, line: p.line, odds: p.odds, units: p.units, gameTime: p.gameTime, status: p.status, sport: typeof p.sport === "string" ? p.sport : p.sport.name })),
    });
    for (const sport of [...Array.from(new Set(ascA.map((p) => p.sport.name))), undefined, "CFL"]) {
      same(
        `capper recents, selected sport ${sport ?? "(none: all-sport fallback)"}: SQL == selectCapperRecentPicks over the full array (all statuses, ties included)`,
        slim(capperRecentPicksFromRows(bundle.recents, sport)),
        slim(selectCapperRecentPicks(ascA, sport))
      );
    }
    const perSportRows = (bundle.recents as { rs: number; ra: number; sport: string }[]);
    check(`capper recents payload is bounded: ${perSportRows.length} rows for 3 sports (<= 3 x 10 + 10)`, perSportRows.length <= 40);
  }

  // ---- 3.e pending counts -----------------------------------------------------------------------
  {
    const cutoff = new Date(NOW.getTime() - 24 * 3600000);
    const b = await queryPageBundle(buildPageBundleQuery({ parts: [{ name: "pending", select: pendingCountsSelect({ userId, staleCutoff: cutoff }) }] }));
    const got = pendingCountsFromBundle(b.pending);
    const pending = allPicks.filter((p) => p.status === "PENDING");
    same("pending counts: pending and stale (gameTime strictly before now - 24h) == the JS filters", got, { pending: pending.length, stale: pending.filter((p) => p.gameTime.getTime() < cutoff.getTime()).length });
    check("fixture has both stale and fresh PENDING picks", got.stale > 0 && got.stale < got.pending);
    const edge = new Date(NOW.getTime() - 24 * 3600000);
    await prisma.pick.createMany({ data: [row(userId, { capperId: capEmpty, sport: "MLB", status: "PENDING", gameTime: edge, gradedAt: null, homeTeam: "EDGE" })] });
    const at = pendingCountsFromBundle((await queryPageBundle(buildPageBundleQuery({ parts: [{ name: "pending", select: pendingCountsSelect({ userId, staleCutoff: cutoff }) }] }))).pending);
    check("a PENDING pick exactly at the cutoff is NOT stale (strict <), like the JS filter", at.pending === got.pending + 1 && at.stale === got.stale);
    await prisma.pick.deleteMany({ where: { userId, capperId: capEmpty } });
    same("pending counts, user with no picks: zeros", pendingCountsFromBundle((await queryPageBundle(buildPageBundleQuery({ parts: [{ name: "pending", select: pendingCountsSelect({ userId: `${PREFIX}nobody`, staleCutoff: cutoff }) }] }))).pending), { pending: 0, stale: 0 });
  }

  // ---- 4.1 the narrow decided series + round trip ---------------------------------------------------
  {
    // A capper with values that stress the round trip: millisecond edges, epoch-adjacent and far-future
    // times, a NULL gradedAt on a decided pick, fractional units, ties on gameTime, PENDING/CANCELLED.
    const capR = `${PREFIX}capper-rt`;
    await prisma.capper.create({ data: { id: capR, userId, name: "RT", source: "OTHER" } });
    const ms = (iso: string) => new Date(iso);
    const specs: Spec[] = [
      { gameTime: ms("1970-01-01T00:00:00.001Z"), createdAt: ms("1970-01-01T00:00:00.002Z"), gradedAt: ms("1970-01-01T00:00:00.003Z"), status: "WIN", units: 0.1, odds: -110 },
      { gameTime: ms("2026-03-01T00:00:00.001Z"), createdAt: ms("2026-03-01T00:00:00.999Z"), gradedAt: ms("2026-03-01T03:00:00.001Z"), status: "LOSS", units: 1 / 3, odds: 150 },
      { gameTime: ms("2026-03-01T00:00:00.001Z"), createdAt: ms("2026-03-01T00:00:00.999Z"), gradedAt: null, status: "WIN", units: 0.7, odds: -180 }, // same gameTime AND createdAt: id decides; gradedAt NULL
      { gameTime: ms("2026-03-02T23:59:59.999Z"), createdAt: ms("2026-03-01T00:00:00.000Z"), gradedAt: ms("2026-03-03T00:00:00.000Z"), status: "PUSH", units: 2, odds: 100 },
      { gameTime: ms("2026-03-02T23:59:59.999Z"), createdAt: ms("2026-02-28T12:00:00.500Z"), gradedAt: ms("2026-03-03T00:00:00.500Z"), status: "WIN", units: 1.5, odds: 210 }, // same gameTime, EARLIER createdAt
      { gameTime: ms("2026-03-05T12:00:00.000Z"), status: "LOSS", units: 0.3, odds: -250 },
      { gameTime: ms("2099-12-31T23:59:59.999Z"), status: "WIN", units: 1, odds: 340, gradedAt: ms("2099-12-31T23:59:59.999Z") },
      { gameTime: ms("2026-03-06T00:00:00.000Z"), status: "PENDING", gradedAt: null },
      { gameTime: ms("2026-03-06T01:00:00.000Z"), status: "CANCELLED" },
      { gameTime: ms("2026-03-07T00:00:00.000Z"), status: "WIN", sport: "NFL" as never, units: 1, odds: -105 },
    ].map((s) => ({ capperId: capR, sport: (s as { sport?: string }).sport ?? "MLB", ...s }) as Spec);
    // Enough decided picks that consistency (>= 5) and the odds-range gate (>= 3 in a bucket) are live.
    specs.push(...randomSpecs(capR, 40, 99).map((s) => ({ ...s, unstamped: false })));
    await prisma.pick.createMany({ data: specs.map((s) => row(userId, s)) });

    const full = await loadPicks(userId, capR);
    const decidedFull = full.filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH");
    const series = await queryDecidedSeries({ userId, capperId: capR });
    check(`narrow series: ${series.length} rows == the capper's ${decidedFull.length} decided picks (PENDING/CANCELLED excluded)`, series.length === decidedFull.length && series.every((p) => ["WIN", "LOSS", "PUSH"].includes(p.status)));
    same("narrow series: same ids in the canonical (gameTime, createdAt, id) order", series.map((p) => p.id), decidedFull.map((p) => p.id));
    let rt = "";
    series.forEach((p, i) => {
      const f = decidedFull[i];
      if (p.createdAt.getTime() !== f.createdAt.getTime()) rt ||= `createdAt ${p.id}: ${p.createdAt.toISOString()} vs ${f.createdAt.toISOString()}`;
      if (p.gameTime.getTime() !== f.gameTime.getTime()) rt ||= `gameTime ${p.id}: ${p.gameTime.toISOString()} vs ${f.gameTime.toISOString()}`;
      if ((p.gradedAt === null) !== (f.gradedAt === null) || (p.gradedAt && f.gradedAt && p.gradedAt.getTime() !== f.gradedAt.getTime())) rt ||= `gradedAt ${p.id}: ${p.gradedAt?.toISOString()} vs ${f.gradedAt?.toISOString()}`;
      if (!Object.is(p.units, f.units) || p.odds !== f.odds || p.status !== f.status || p.sport.name !== f.sport.name) rt ||= `units/odds/status/sport ${p.id}`;
    });
    check("round trip: bigint epoch-ms -> new Date == the timestamp(3) value (.001/.999 ms, 1970, 2099), gradedAt NULL stays null, units/odds/status/sport exact", rt === "", rt);
    check("fixture: a decided pick with gradedAt NULL and same-gameTime/same-createdAt ties are in the series", series.some((p) => p.gradedAt === null) && decidedFull.some((p, i) => i > 0 && p.gameTime.getTime() === decidedFull[i - 1].gameTime.getTime()));

    // The point of the narrow series: the EXISTING JS functions give identical results on it.
    same("computeStats: narrow series == full rows", computeStats(series), computeStats(full));
    same("currentStreak over the series == computeStats(full).currentStreak", currentStreak(series), computeStats(full).currentStreak);
    same("computeMomentum: narrow series == full rows", computeMomentum(series), computeMomentum(full));
    same("computeConsistency: narrow series == full rows", computeConsistency(series), computeConsistency(full));
    same("computeBestOddsRange: narrow series == full rows", computeBestOddsRange(series), computeBestOddsRange(full));
    same("computeUnitsChartData: narrow series == full rows", computeUnitsChartData(series), computeUnitsChartData(full));
    for (const w of WINDOWS) {
      same(`window ${w}: gradedAt-gated filter then computeStats agrees (narrow vs full)`, computeStats(inWindow(series, w)), computeStats(inWindow(full, w)));
    }
    same("sport-scoped chart (NFL): narrow == full", computeUnitsChartData(series.filter((p) => p.sport.name === "NFL")), computeUnitsChartData(full.filter((p) => p.sport.name === "NFL")));
    const empty = await queryDecidedSeries({ userId, capperId: capEmpty });
    check("a capper with no picks: empty series", empty.length === 0);

    // ---- bundle composition: one statement == the parts run alone ------------------------------------
    const one = await queryPageBundle(
      buildPageBundleQuery({
        windows: { windows: ["ALL", "LAST_30"], now: NOW },
        parts: [
          { name: "totals", select: windowTotalsSelect({ userId, capperIds: [capR], windows: ["ALL", "LAST_30"], now: NOW, groupBySport: true }) },
          { name: "series", select: decidedSeriesSelect({ userId, capperId: capR }), orderBy: DECIDED_SERIES_ORDER_BY },
        ],
      })
    );
    same("bundle: the series part == the fragment run alone (order preserved by ORDER BY inside jsonb_agg)", narrowSeriesFromRows(one.series), series);
    const alone = await queryWindowTotals({ userId, capperIds: [capR], windows: ["ALL", "LAST_30"], now: NOW, groupBySport: true });
    const key = (r: { window: string; sport?: string }) => `${r.window}/${r.sport}`;
    same("bundle: the totals part == queryWindowTotals (float sums identical through jsonb)", (one.totals as { window: string; sport?: string }[]).sort((x, y) => (key(x) < key(y) ? -1 : 1)), [...alone].sort((x, y) => (key(x) < key(y) ? -1 : 1)));
    let threw = false;
    try {
      buildPageBundleQuery({ parts: [{ name: "bad name; drop table picks", select: windowsCte(["ALL"], NOW) }] });
    } catch {
      threw = true;
    }
    check("bundle part names must be plain identifiers", threw);
  }

  console.log(`\n${assertions} assertions, ${failures} failed.`);
}

async function cleanup() {
  let deletedUsers = 0;
  for (const id of createdUserIds) deletedUsers += (await prisma.user.deleteMany({ where: { id } })).count;
  let deletedSports = 0;
  for (const id of createdSportIds) deletedSports += (await prisma.sport.deleteMany({ where: { id } })).count;
  console.log(`cleanup: deleted ${deletedUsers} user(s), ${deletedSports} sport(s); picks left with the prefix: ${await prisma.pick.count({ where: { id: { startsWith: PREFIX } } })}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures > 0 ? 1 : 0);
  });
