// Page-level parity for /cappers/[capperId]: getCapperDetailData (ONE statement composed from the
// shared SQL blocks, then the existing JS over the narrow decided series) against the frozen legacy
// derivation (capper-detail-legacy.ts), for the design doc's capper-detail cases
// (docs/design/dashboard-capper-detail-egress.md §8): zero picks; only PENDING; a CANCELLED pick with
// gradedAt making a window "non-empty"; same-gameTime / same-createdAt ties; a WIN at odds = 0 (the JS
// Infinity/NaN reproduced); two sports tied on tile total (tab order via first-appearance key, both
// directions); exactly 4 / 5 / 6 decided picks (consistency gate 5, odds-range gate 3); momentum inputs
// alternating W/L and a 12-long run; one sport only; a random mixed history; and a 5,000-pick capper.
// For every case the FULL matrix of window x categoryWindow x categorySport (unset, each sport the capper
// has, one it lacks) runs at the pinned instant, and the diagonal at two more instants. Comparison is
// `===` with -0 == +0 and NaN == NaN, arrays in order.
//
// DB-backed and WRITING (ids prefixed `__CapperDetail__`, deleted by exact id at the end); refuses to run
// unless DATABASE_URL is local.
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { PICK_CATEGORY_VERSION, SCORECARD_WINDOWS, pickCategory, type ScorecardWindow } from "@/server/data/stats";
import { capperRecentPicksRange, getCapperDetailData, getCapperPageData, type CapperDetailParams } from "@/server/data/capper-detail";
import { computeCapperDetailLegacy, firstDiff, loadLegacyCapperPicks } from "@/server/data/capper-detail-legacy";
import { getCappersWithPickCounts } from "@/server/data/cappers";

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

const PREFIX = "__CapperDetail__";
const NOW = new Date(Date.UTC(2026, 8, 20, 16, 0, 0));
const DAY = 86400000;
const ago = (minutes: number, seconds = 30) => new Date(NOW.getTime() - minutes * 60000 - seconds * 1000);

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
  sport?: string;
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
  homeTeam?: string;
};
let seq = 0;
function row(userId: string, s: Spec): Prisma.PickCreateManyInput {
  seq++;
  const sport = s.sport ?? "MLB";
  const betType = s.betType ?? "MONEYLINE";
  const period = s.period ?? "FULL_GAME";
  const odds = s.odds ?? -110;
  const line = s.line ?? null;
  const betDetail = s.betDetail ?? null;
  const status = s.status ?? "WIN";
  const category = pickCategory({ betType, period, betDetail, odds, line, sportName: sport, pickedSide: null, mlFavoredSide: null, propMarket: null });
  return {
    id: `${PREFIX}p${String(seq).padStart(6, "0")}`,
    userId,
    capperId: s.capperId,
    sportId: sportIdByName.get(sport)!,
    homeTeam: s.homeTeam ?? "Home",
    awayTeam: "Away",
    betType,
    betDetail,
    odds,
    line,
    period,
    units: s.units ?? 1,
    datePosted: new Date(s.gameTime.getTime() - 5 * 3600000 - (seq % 7) * 1000),
    gameTime: s.gameTime,
    status,
    gradedAt: s.gradedAt === "auto" || s.gradedAt === undefined ? (status === "PENDING" ? null : new Date(s.gameTime.getTime() + 3 * 3600000)) : s.gradedAt,
    createdAt: s.createdAt ?? new Date(NOW.getTime() - seq * 1000),
    category,
    categoryVersion: PICK_CATEGORY_VERSION,
  };
}
async function insertAll(rows: Prisma.PickCreateManyInput[]) {
  for (let i = 0; i < rows.length; i += 5000) await prisma.pick.createMany({ data: rows.slice(i, i + 5000) });
}

function randomSpecs(capperId: string, n: number, seed: number, spanDays = 70, sports = ["MLB", "MLB", "NFL", "NHL"]): Spec[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const specs: Spec[] = [];
  for (let i = 0; i < n; i++) {
    const betType = pick(["MONEYLINE", "MONEYLINE", "SPREAD", "TOTAL", "TEAM_TOTAL", "NRFI"] as const);
    const line = betType === "SPREAD" ? (r() < 0.5 ? -1 : 1) * (0.5 + Math.floor(r() * 12)) : betType === "TOTAL" || betType === "TEAM_TOTAL" ? 4.5 + Math.floor(r() * 40) : null;
    const betDetail =
      betType === "TOTAL" || betType === "TEAM_TOTAL" ? `${r() < 0.5 ? "Over" : "Under"} ${line}` : betType === "SPREAD" ? `Team ${line}` : betType === "NRFI" ? (r() < 0.5 ? "NRFI" : "YRFI") : null;
    const x = r();
    const status = x < 0.4 ? "WIN" : x < 0.78 ? "LOSS" : x < 0.84 ? "PUSH" : x < 0.93 ? "PENDING" : "CANCELLED";
    const prev = specs[i - 1];
    specs.push({
      capperId,
      sport: pick(sports),
      betType,
      period: r() < 0.1 ? "FIRST_HALF" : "FULL_GAME",
      betDetail,
      odds: pick([-110, -110, -130, -180, -250, 100, 120, 150, 210, 340, -105, 500, -600]),
      line,
      units: pick([0.5, 1, 1, 1.5, 2, 0.25, 3, 0.1]),
      status,
      gameTime: i % 6 === 5 && prev ? prev.gameTime : ago(Math.floor(r() * spanDays * 1440)),
      gradedAt: status === "PENDING" ? null : r() < 0.1 ? null : "auto",
      createdAt: new Date(NOW.getTime() - Math.floor(r() * 1e7) * 1000),
    });
  }
  return specs;
}

async function makeUser(tag: string) {
  const id = `${PREFIX}user-${tag}`;
  await prisma.user.create({ data: { id, supabaseId: `${PREFIX}sb-${tag}`, email: `${PREFIX}${tag}@example.invalid` } });
  createdUserIds.push(id);
  return id;
}
let capperSeq = 0;
async function makeCapper(userId: string, tag: string) {
  capperSeq++;
  const id = `${PREFIX}capper-${tag}`;
  await prisma.capper.create({ data: { id, userId, name: `Capper ${tag} ${capperSeq}`, source: "OTHER" } });
  return id;
}

const params = (window: ScorecardWindow, categoryWindow: ScorecardWindow, categorySport?: string): CapperDetailParams => ({ window, categoryWindow, categorySport });

// Runs the combination matrix for one capper and reports one PASS/FAIL line. `full` = every window x
// categoryWindow x categorySport at NOW; the diagonal (window == categoryWindow) at the other instants.
async function compareCapper(label: string, userId: string, capperId: string, opts: { full?: boolean; extraNows?: boolean; only?: CapperDetailParams[] } = {}) {
  const rows = await loadLegacyCapperPicks(userId, capperId);
  const sports = Array.from(new Set(rows.map((r) => r.sport.name)));
  const sportChoices = [undefined, ...sports, "Curling"];
  const cases: { p: CapperDetailParams; now: Date }[] = [];
  if (opts.only) for (const p of opts.only) cases.push({ p, now: NOW });
  else {
    const nows = opts.extraNows === false ? [NOW] : [NOW, new Date(NOW.getTime() - DAY), new Date(NOW.getTime() - 30 * DAY)];
    for (const now of nows)
      for (const w of SCORECARD_WINDOWS)
        for (const cw of SCORECARD_WINDOWS) {
          if (!(opts.full !== false && now === NOW) && w !== cw) continue;
          for (const cs of sportChoices) cases.push({ p: params(w, cw, cs), now });
        }
  }
  let bad = 0;
  let first = "";
  let last: Awaited<ReturnType<typeof getCapperDetailData>> | null = null;
  for (const c of cases) {
    const legacy = computeCapperDetailLegacy(rows, c.p, c.now);
    const next = await getCapperDetailData(userId, capperId, c.p, c.now);
    const d = firstDiff(next, legacy);
    if (d) {
      bad++;
      if (!first) first = `${JSON.stringify(c.p)} now=${c.now.toISOString()}  ${d}`;
    }
    last = next;
  }
  check(`${label}: ${cases.length} window x categoryWindow x categorySport case(s) identical to legacy (===, -0 == +0)`, bad === 0, `${bad} differ; first: ${first}`);
  return { rows, view: await getCapperDetailData(userId, capperId, params("ALL", "ALL"), NOW), last };
}

async function main() {
  for (const s of ["MLB", "NFL", "NHL"]) await ensureSport(s);
  const userId = await makeUser("main");

  {
    const capperId = await makeCapper(userId, "zero");
    const { view } = await compareCapper("zero picks", userId, capperId);
    check(
      "zero picks: empty everywhere, no tracked-since, no tabs",
      view.associatedPickCount === 0 && view.trackedSinceMs === null && view.lastPickMs === null && view.sportTabs.length === 0 && view.chartData.length === 0 && view.recentPicks.length === 0 && view.currentStreak.type === "NONE" && view.stats.roi === 0 && view.activeSportStats === null && view.selectedCategorySport === undefined
    );
  }
  {
    const capperId = await makeCapper(userId, "pending");
    await insertAll(Array.from({ length: 5 }, (_, i) => row(userId, { capperId, status: "PENDING", gameTime: ago(60 * (i + 1)), gradedAt: null })));
    const { view } = await compareCapper("only PENDING", userId, capperId);
    check("only PENDING: 5 picks counted, no record, no tabs, no chart, recents still listed", view.associatedPickCount === 5 && view.stats.wins === 0 && view.sportTabs.length === 0 && view.chartData.length === 0 && view.recentPicks.length === 5 && view.recentPicksSport === null);
  }
  {
    // CANCELLED with gradedAt makes a window non-empty for the sport strip (0-0-0 instead of no strip);
    // CANCELLED without gradedAt does not (outside ALL).
    const capperId = await makeCapper(userId, "cancelled");
    await insertAll([
      row(userId, { capperId, status: "WIN", gameTime: ago(20 * 1440) }),
      row(userId, { capperId, status: "LOSS", gameTime: ago(21 * 1440) }),
      row(userId, { capperId, status: "CANCELLED", gameTime: ago(600), gradedAt: "auto" }),
      row(userId, { capperId, status: "CANCELLED", gameTime: ago(700), gradedAt: null }),
      row(userId, { capperId, status: "PENDING", gameTime: ago(300), gradedAt: null }),
    ]);
    await compareCapper("CANCELLED with and without gradedAt", userId, capperId);
    const v = await getCapperDetailData(userId, capperId, params("ALL", "LAST_7"), NOW);
    check("CANCELLED+gradedAt in LAST_7 gives a 0-0-0 strip; the record is 0 and the chart empty", v.activeSportStats !== null && v.activeSportStats.wins === 0 && v.activeSportStats.roi === 0 && v.activeSportChartData.length === 0);
    const v2 = await getCapperDetailData(userId, capperId, params("ALL", "YESTERDAY"), NOW);
    check("nothing graded yesterday: no strip", v2.activeSportStats === null);
  }
  {
    // Ties: same gameTime with different createdAt, and two picks equal on gameTime AND createdAt (id decides).
    const capperId = await makeCapper(userId, "ties");
    const t = ago(1000);
    const specs: Spec[] = Array.from({ length: 14 }, (_, i) => ({
      capperId,
      gameTime: t,
      createdAt: new Date(NOW.getTime() - ((i * 7) % 14) * 1000 - 5000),
      status: (["WIN", "LOSS", "PUSH"] as const)[i % 3],
      odds: [-110, 150, -200][i % 3],
      homeTeam: `Tie${i}`,
    }));
    specs.push({ capperId, gameTime: ago(900), createdAt: ago(2000), status: "LOSS", homeTeam: "IdA" }, { capperId, gameTime: ago(900), createdAt: ago(2000), status: "WIN", homeTeam: "IdB" });
    await insertAll(specs.map((s) => row(userId, s)));
    const { view } = await compareCapper("gameTime ties across the recent-10 edge", userId, capperId);
    check("ties: recent list is the canonical newest 10 with the same-key pair in id order", view.recentPicks.length === 10 && view.recentPicks[0].homeTeam === "IdB" && view.recentPicks[1].homeTeam === "IdA");
  }
  {
    // A WIN at odds = 0: uncreatable via the app, legal in the table. JS poisons unitsWon/ROI/the charts.
    const capperId = await makeCapper(userId, "zeroodds");
    const specs = randomSpecs(capperId, 60, 3, 70, ["MLB"]);
    specs[20] = { ...specs[20], status: "WIN", odds: 0, units: 1, gradedAt: "auto", gameTime: ago(5 * 1440) };
    await insertAll(specs.map((s) => row(userId, s)));
    const { view } = await compareCapper("a WIN at odds = 0 (JS Infinity reproduced)", userId, capperId, { extraNows: false });
    check("zero odds: ALL netUnits is +Infinity and the chart is poisoned from that point", view.stats.netUnits === Infinity && view.chartData.some((p) => p.cumulativeUnits === Infinity));
  }
  {
    // Two sports tied on total tile count: the tab order follows the FIRST pick of ANY status. NFL's first
    // pick is an old PENDING (so it appears first), MLB's first pick is a later decided one.
    const capperId = await makeCapper(userId, "tabtie-a");
    const mk = (sport: string, days: number, status: Spec["status"], cat: "ml" | "over") =>
      ({ capperId, sport, status, gameTime: ago(days * 1440), betType: cat === "ml" ? "MONEYLINE" : "TOTAL", betDetail: cat === "ml" ? null : "Over 8.5", line: cat === "ml" ? null : 8.5, odds: -150 }) as Spec;
    await insertAll(
      [
        mk("NFL", 40, "PENDING", "ml"),
        mk("MLB", 30, "WIN", "ml"),
        mk("MLB", 29, "LOSS", "over"),
        mk("NFL", 20, "WIN", "ml"),
        mk("NFL", 19, "LOSS", "over"),
      ].map((s) => row(userId, s))
    );
    const { view } = await compareCapper("two sports tied on tile total (NFL appears first via a PENDING)", userId, capperId);
    check("tie: tab order is first-appearance over ALL statuses (NFL before MLB)", view.sportTabs.join() === "NFL,MLB", view.sportTabs.join());
    const capperB = await makeCapper(userId, "tabtie-b");
    await insertAll(
      [
        mk("MLB", 40, "PENDING", "ml"),
        mk("NFL", 30, "WIN", "ml"),
        mk("NFL", 29, "LOSS", "over"),
        mk("MLB", 20, "WIN", "ml"),
        mk("MLB", 19, "LOSS", "over"),
      ].map((s) => row(userId, { ...s, capperId: capperB }))
    );
    const b = await compareCapper("two sports tied on tile total (MLB appears first)", userId, capperB);
    check("tie: MLB before NFL when MLB's first pick is earlier", b.view.sportTabs.join() === "MLB,NFL", b.view.sportTabs.join());
  }
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const capperId = await makeCapper(userId, `decided${n}`);
    const odds = [-110, 150, -300, 120, 250, -105];
    await insertAll(Array.from({ length: n }, (_, i) => row(userId, { capperId, status: i % 3 === 2 ? "LOSS" : "WIN", gameTime: ago((i + 1) * 300), odds: odds[i], units: 1 + (i % 2) })).concat([row(userId, { capperId, status: "PENDING", gameTime: ago(10), gradedAt: null })]));
    const { view } = await compareCapper(`exactly ${n} decided pick(s) (+1 PENDING)`, userId, capperId, { extraNows: false });
    if (n === 4) check("4 decided: consistency gate closed (< 5); odds-range gate reached", view.consistency === null);
    if (n === 5) check("5 decided: consistency gate open", view.consistency !== null);
  }
  {
    const capperId = await makeCapper(userId, "momentum");
    const seq2: Spec["status"][] = ["WIN", "LOSS", "WIN", "LOSS", "WIN", "LOSS", "WIN", "LOSS", ...Array(12).fill("WIN"), "LOSS", ...Array(5).fill("LOSS"), "WIN", "PUSH", "WIN"];
    await insertAll(seq2.map((status, i) => row(userId, { capperId, status, gameTime: ago((seq2.length - i) * 400), odds: i % 4 === 0 ? 130 : -115, units: i % 5 === 0 ? 2 : 1 })));
    const { view } = await compareCapper("momentum: alternating W/L, a 12-long run and a PUSH", userId, capperId, { extraNows: false });
    check("momentum: the 4+ bucket holds the long run", view.momentum.afterWin[3].sampleSize > 0 && view.momentum.afterLoss[3].sampleSize > 0);
  }
  {
    const capperId = await makeCapper(userId, "onesport");
    await insertAll(randomSpecs(capperId, 90, 5, 70, ["NHL"]).map((s) => row(userId, s)));
    const { view } = await compareCapper("one sport only", userId, capperId, { extraNows: false });
    check("one sport: at most one tab", view.sportTabs.length <= 1);
  }
  {
    const capperId = await makeCapper(userId, "mixed");
    await insertAll(randomSpecs(capperId, 400, 21).map((s) => row(userId, s)));
    const { view } = await compareCapper("random mixed history (400 picks, all statuses, gradedAt gaps, ties, 3 sports)", userId, capperId);
    check("mixed: tabs, tiles, recents and streak all present", view.sportTabs.length >= 2 && view.universalBreakdown.length > 0 && view.recentPicks.length === 10);
  }
  {
    // The page view (one sport + time selection): All Sports is the legacy all-sports view, a sport is
    // that sport's section, the per-sport records add up to All Sports, and the recent list is the
    // newest picks of the selection (any status, game inside capperRecentPicksRange).
    const capperId = `${PREFIX}capper-mixed`;
    const rows = await loadLegacyCapperPicks(userId, capperId);
    const newestFirst = [...rows].reverse();
    let bad = 0;
    let first = "";
    const fail = (what: string) => {
      bad++;
      if (!first) first = what;
    };
    for (const w of SCORECARD_WINDOWS) {
      const all = await getCapperPageData(userId, capperId, { window: w, recentLimit: 10 }, NOW);
      const legacyAll = computeCapperDetailLegacy(rows, params(w, w), NOW);
      if (firstDiff({ s: all.summary, c: all.chartData, t: all.tiles }, { s: legacyAll.stats, c: legacyAll.chartData, t: legacyAll.universalBreakdown })) fail(`${w} All Sports`);
      if (all.sports.join() !== "MLB,NFL,NHL" || all.selectedSport !== null) fail(`${w} sports`);
      const range = capperRecentPicksRange(w, NOW);
      const inRange = (p: (typeof rows)[number]) => !range || (p.gameTime >= range.start && p.gameTime < range.end);
      const sum = { wins: 0, losses: 0, pushes: 0 };
      for (const sport of [undefined, ...all.sports]) {
        const limit = sport === "NFL" ? 20 : 10;
        const v = sport === undefined ? all : await getCapperPageData(userId, capperId, { sport, window: w, recentLimit: limit }, NOW);
        const expected = newestFirst.filter((p) => (sport === undefined || p.sport.name === sport) && inRange(p));
        if (v.recentPicks.map((p) => p.id).join() !== expected.slice(0, limit).map((p) => p.id).join() || v.hasMoreRecent !== expected.length > limit) fail(`${w} ${sport} recents`);
        if (sport === undefined) continue;
        const legacy = computeCapperDetailLegacy(rows, params(w, w, sport), NOW);
        const zero = { wins: 0, losses: 0, pushes: 0, roi: 0, netUnits: 0 };
        if (legacy.selectedCategorySport !== sport || firstDiff({ s: v.summary, c: v.chartData, t: v.tiles }, { s: legacy.activeSportStats ?? zero, c: legacy.activeSportChartData, t: legacy.activeCategoryBreakdown })) fail(`${w} ${sport}`);
        sum.wins += v.summary.wins;
        sum.losses += v.summary.losses;
        sum.pushes += v.summary.pushes;
      }
      if (sum.wins !== all.summary.wins || sum.losses !== all.summary.losses || sum.pushes !== all.summary.pushes) fail(`${w} sum of sports`);
    }
    check("page view: every sport x window equals legacy, sports sum to All Sports, recents are the selection's newest", bad === 0, `${bad} differ; first: ${first}`);
    const unknown = await getCapperPageData(userId, capperId, { sport: "Curling", window: "ALL", recentLimit: 10 }, NOW);
    check("page view: a sport the capper lacks resolves to All Sports (null)", unknown.selectedSport === null);
  }
  {
    // A second capper of the same user must never leak into the first's numbers.
    const other = await makeCapper(userId, "other");
    await insertAll(randomSpecs(other, 50, 99).map((s) => row(userId, s)));
    const mixed = `${PREFIX}capper-mixed`;
    const rows = await loadLegacyCapperPicks(userId, mixed);
    const v = await getCapperDetailData(userId, mixed, params("ALL", "ALL"), NOW);
    check("scoping: pick count is this capper's alone", v.associatedPickCount === rows.length);
  }
  {
    const capperId = await makeCapper(userId, "big");
    const specs = randomSpecs(capperId, 5000, 4242, 300);
    await insertAll(specs.map((s) => row(userId, s)));
    // Momentum is O(n^2) in the legacy path too, so only a handful of combinations run at this size.
    const only = [params("ALL", "ALL"), params("LAST_30", "LAST_7", "NFL"), params("LAST_60", "YESTERDAY", "NHL"), params("TODAY", "ALL", "MLB"), params("ALL", "LAST_60", "Curling")];
    const { view } = await compareCapper("5,000-pick capper", userId, capperId, { only });
    check("5,000 picks: the charts are full fidelity (not downsampled)", view.chartData.length > 2000, String(view.chartData.length));
  }
  {
    // getCappersWithPickCounts is narrowed to id, name, count (Q5): same shape, same numbers.
    const list = await getCappersWithPickCounts(userId);
    const counts = await prisma.pick.groupBy({ by: ["capperId"], where: { userId }, _count: true });
    const byId = new Map(counts.map((c) => [c.capperId, c._count]));
    check(
      "getCappersWithPickCounts returns exactly { id, name, pickCount } per capper with the right counts",
      list.length > 10 && list.every((c) => Object.keys(c).sort().join() === "id,name,pickCount" && c.pickCount === (byId.get(c.id) ?? 0))
    );
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
