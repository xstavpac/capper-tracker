// Page-level parity for the /dashboard summary: computeDashboardSummary (ONE statement composed
// from the shared SQL blocks) against the frozen legacy JS path (dashboard-summary-legacy.ts), for
// the design doc's dashboard cases (docs/design/dashboard-capper-detail-egress.md §8):
//   a user with zero picks; only PENDING; CANCELLED-with-gradedAt; a settled history above the
//   2,000-point downsample threshold (5,000 picks) and one exactly at it; same-gameTime ties across
//   the recent-10 LIMIT edge (canonical (gameTime, createdAt, id) order on both sides); the
//   stale-PENDING cutoff edge; a WIN at odds = 0 (the JS Infinity/NaN reproduced); unstamped and
//   NULL-category rows; a random mixed history. Comparison is `===` with -0 == +0 and NaN == NaN.
// Also pins Q4's shape (only wins/losses/pushes/roi/netUnits remain on `overall`) and that
// getDashboardSummary (the cachedByTag wrapper) returns the same thing.
//
// DB-backed and WRITING (ids prefixed `__DashboardSummary__`, deleted by exact id at the end);
// refuses to run unless DATABASE_URL is local.
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { PICK_CATEGORY_VERSION, pickCategory } from "@/server/data/stats";
import { computeDashboardSummary, getDashboardSummary } from "@/server/data/dashboard-summary";
import { computeDashboardSummaryLegacy, firstDiff, loadLegacyDashboardPicks, narrowLegacySummary } from "@/server/data/dashboard-summary-legacy";

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

const PREFIX = "__DashboardSummary__";
const NOW = new Date(Date.UTC(2026, 8, 20, 16, 0, 0));
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
  unstamped?: boolean;
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
  const category = s.unstamped ? null : pickCategory({ betType, period, betDetail, odds, line, sportName: sport, pickedSide: null, mlFavoredSide: null, propMarket: null });
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
    datePosted: s.gameTime,
    gameTime: s.gameTime,
    status,
    gradedAt: s.gradedAt === "auto" || s.gradedAt === undefined ? (status === "PENDING" ? null : new Date(s.gameTime.getTime() + 3 * 3600000)) : s.gradedAt,
    createdAt: s.createdAt ?? new Date(NOW.getTime() - seq * 1000),
    category,
    categoryVersion: s.unstamped ? 0 : PICK_CATEGORY_VERSION,
  };
}
async function insertAll(rows: Prisma.PickCreateManyInput[]) {
  for (let i = 0; i < rows.length; i += 5000) await prisma.pick.createMany({ data: rows.slice(i, i + 5000) });
}

function randomSpecs(capperId: string, n: number, seed: number, spanDays = 70): Spec[] {
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
      sport: pick(["MLB", "MLB", "NFL", "NHL"]),
      betType,
      period: r() < 0.1 ? "FIRST_HALF" : "FULL_GAME",
      betDetail,
      odds: pick([-110, -110, -130, -180, -250, 100, 120, 150, 210, 340, -105]),
      line,
      units: pick([0.5, 1, 1, 1.5, 2, 0.25, 3, 0.1]),
      status,
      gameTime: i % 6 === 5 && prev ? prev.gameTime : ago(Math.floor(r() * spanDays * 1440)),
      gradedAt: status === "PENDING" ? null : r() < 0.1 ? null : "auto",
      unstamped: false,
      createdAt: new Date(NOW.getTime() - Math.floor(r() * 1e7) * 1000),
    });
  }
  return specs;
}

async function compare(label: string, userId: string, now = NOW) {
  const legacyRaw = computeDashboardSummaryLegacy(await loadLegacyDashboardPicks(userId), now);
  const legacy = narrowLegacySummary(legacyRaw);
  // `trends` (the stat cards' weekly series) has no legacy counterpart: checked on its own below.
  const { trends, ...next } = await computeDashboardSummary(userId, now);
  const d = firstDiff(next, legacy);
  check(`${label}: summary identical to legacy (===, -0 == +0)`, d === null, d ?? "");
  return { legacy, next, trends };
}

async function makeUser(tag: string) {
  const id = `${PREFIX}user-${tag}`;
  await prisma.user.create({ data: { id, supabaseId: `${PREFIX}sb-${tag}`, email: `${PREFIX}${tag}@example.invalid` } });
  createdUserIds.push(id);
  const capperId = `${PREFIX}capper-${tag}`;
  await prisma.capper.create({ data: { id: capperId, userId: id, name: `Capper ${tag}`, source: "OTHER" } });
  return { userId: id, capperId };
}

async function main() {
  for (const s of ["MLB", "NFL", "NHL"]) await ensureSport(s);

  {
    const { userId } = await makeUser("zero");
    const { next } = await compare("zero picks", userId);
    check("zero picks: everything empty/zero", next.totalPicks === 0 && next.chartData.length === 0 && next.recentPicks.length === 0 && next.categoryBreakdown.length === 0 && next.overall.roi === 0 && next.pendingCount === 0);
  }
  {
    const { userId, capperId } = await makeUser("pending");
    await insertAll(Array.from({ length: 5 }, (_, i) => row(userId, { capperId, status: "PENDING", gameTime: ago(60 * (i + 1)), gradedAt: null })));
    const { next } = await compare("only PENDING", userId);
    check("only PENDING: 5 picks, no record, no tiles, no chart, 5 pending", next.totalPicks === 5 && next.pendingCount === 5 && next.overall.wins === 0 && next.chartData.length === 0 && next.categoryBreakdown.length === 0);
  }
  {
    const { userId, capperId } = await makeUser("cancelled");
    await insertAll([
      row(userId, { capperId, status: "CANCELLED", gameTime: ago(600), gradedAt: "auto" }),
      row(userId, { capperId, status: "CANCELLED", gameTime: ago(700), gradedAt: null }),
      row(userId, { capperId, status: "WIN", gameTime: ago(800) }),
    ]);
    const { next } = await compare("CANCELLED with and without gradedAt", userId);
    check("CANCELLED counts toward totalPicks (3) but not the record or the chart", next.totalPicks === 3 && next.overall.wins === 1 && next.overall.losses === 0 && next.chartData.length === 1);
  }
  {
    // Ties across the recent-10 LIMIT edge: 14 picks share ONE gameTime; createdAt (then id) decides which 10.
    const { userId, capperId } = await makeUser("ties");
    const t = ago(1000);
    const specs: Spec[] = Array.from({ length: 14 }, (_, i) => ({ capperId, gameTime: t, createdAt: new Date(NOW.getTime() - ((i * 7) % 14) * 1000 - 5000), status: "WIN", homeTeam: `Tie${i}` }));
    // and two picks with identical gameTime AND createdAt: only the id can order them
    specs.push({ capperId, gameTime: ago(900), createdAt: ago(2000), status: "LOSS", homeTeam: "IdA" }, { capperId, gameTime: ago(900), createdAt: ago(2000), status: "LOSS", homeTeam: "IdB" });
    await insertAll(specs.map((s) => row(userId, s)));
    const { next, legacy } = await compare("gameTime ties across the LIMIT 10 edge", userId);
    check("ties: recent 10 are exactly the canonical newest 10 and include the same-key pair in id order", next.recentPicks.length === 10 && legacy.recentPicks.length === 10 && next.recentPicks[0].homeTeam === "IdB");
  }
  {
    // Stale PENDING: at exactly now - 24h is NOT stale (strict <), one ms earlier is.
    const { userId, capperId } = await makeUser("stale");
    await insertAll([
      row(userId, { capperId, status: "PENDING", gameTime: new Date(NOW.getTime() - 24 * 3600000), gradedAt: null }),
      row(userId, { capperId, status: "PENDING", gameTime: new Date(NOW.getTime() - 24 * 3600000 - 1), gradedAt: null }),
      row(userId, { capperId, status: "PENDING", gameTime: new Date(NOW.getTime() - 3600000), gradedAt: null }),
    ]);
    const { next } = await compare("stale-PENDING cutoff edge", userId);
    check("stale edge: 3 pending, exactly 1 stale", next.pendingCount === 3 && next.stalePendingCount === 1);
  }
  {
    // WIN at odds = 0: uncreatable via the app, legal in the table. JS poisons unitsWon/ROI/the chart.
    const { userId, capperId } = await makeUser("zeroodds");
    const specs = randomSpecs(capperId, 60, 3);
    specs[20] = { ...specs[20], status: "WIN", odds: 0, units: 1, gradedAt: "auto" };
    await insertAll(specs.map((s) => row(userId, s)));
    const { next } = await compare("a WIN at odds = 0 (JS Infinity reproduced on netUnits/roi/chart)", userId);
    check("zero odds: netUnits is +Infinity and the chart is poisoned from that point", next.overall.netUnits === Infinity && next.chartData.some((p) => p.cumulativeUnits === Infinity));
  }
  {
    const { userId, capperId } = await makeUser("mixed");
    const specs = randomSpecs(capperId, 400, 21);
    await insertAll(specs.map((s) => row(userId, s)));
    const { next, trends } = await compare("random mixed history (400 picks, all statuses, gradedAt gaps, ties)", userId);
    check("mixed: tiles present, at most 6", next.categoryBreakdown.length > 0 && next.categoryBreakdown.length <= 6);

    // trends: the 8 rolling weeks ending NOW, re-derived from the specs (datePosted == gameTime in this
    // fixture). Posted counts every status; the record and units risked only decided picks.
    const WEEK = 7 * 86400000;
    const zeros = () => Array.from({ length: 8 }, () => 0);
    const want = { posted: zeros(), wins: zeros(), losses: zeros(), pushes: zeros(), unitsRisked: zeros() };
    for (const s of specs) {
      const wk = Math.floor((s.gameTime.getTime() - (NOW.getTime() - 8 * WEEK)) / WEEK);
      if (wk < 0 || wk > 7 || s.gameTime >= NOW) continue;
      want.posted[wk]++;
      const key = s.status === "WIN" ? "wins" : s.status === "LOSS" ? "losses" : s.status === "PUSH" ? "pushes" : null;
      if (!key) continue;
      want[key][wk]++;
      want.unitsRisked[wk] += s.units ?? 1;
    }
    const w = trends.weekly;
    check("trends: picks posted per week == re-derivation, and some fall outside the 8 weeks", w.posted.join() === want.posted.join() && want.posted.reduce((a, b) => a + b, 0) < specs.length, `${w.posted.join()} vs ${want.posted.join()}`);
    check("trends: weekly W / L / P == re-derivation", [w.wins, w.losses, w.pushes].join("|") === [want.wins, want.losses, want.pushes].join("|"), `${[w.wins, w.losses, w.pushes].join("|")} vs ${[want.wins, want.losses, want.pushes].join("|")}`);
    check("trends: weekly units risked == re-derivation", w.unitsRisked.every((v, i) => Math.abs(v - want.unitsRisked[i]) < 1e-9), `${w.unitsRisked.join()} vs ${want.unitsRisked.join()}`);
    check("trends: weekly net units never exceed the all-time record's reach (won - lost is finite, lost <= risked)", w.unitsLost.every((v, i) => v <= w.unitsRisked[i] + 1e-9) && w.unitsWon.every(Number.isFinite));
    // The fixture's one capper was created just now: after every (pinned) week end, inside the last 30 days.
    check("trends: roster counts 1 capper, added this month, in no past week's roster", trends.capperCount === 1 && trends.newCappersThisMonth === 1 && w.tracked.join() === zeros().join(), JSON.stringify(trends));
    await prisma.capper.create({ data: { id: `${PREFIX}capper-mixed-test`, userId, name: "Test capper", source: "OTHER", isTest: true } });
    check("trends: a test capper is not counted", (await computeDashboardSummary(userId, NOW)).trends.capperCount === 1);
  }
  {
    // G4, documented: the SQL tiles read the STORED category, so a never-stamped row (categoryVersion 0,
    // category NULL) is absent from them while the legacy path classifies it at runtime. The parity harness
    // stamps first (backfill-pick-category --apply); this pins that the only difference is exactly those rows.
    const { userId, capperId } = await makeUser("unstamped");
    const specs = randomSpecs(capperId, 120, 77).map((s, i) => ({ ...s, unstamped: i % 9 === 0 }));
    await insertAll(specs.map((s) => row(userId, s)));
    const legacy = narrowLegacySummary(computeDashboardSummaryLegacy(await loadLegacyDashboardPicks(userId), NOW));
    const { trends: _trends, ...next } = await computeDashboardSummary(userId, NOW);
    const { categoryBreakdown: lb, ...lrest } = legacy;
    const { categoryBreakdown: nb, ...nrest } = next;
    check("unstamped rows: everything except the tiles is still identical", firstDiff(nrest, lrest) === null, firstDiff(nrest, lrest) ?? "");
    const unstampedDecidedInChips = specs.filter((s) => s.unstamped && ["WIN", "LOSS", "PUSH"].includes(s.status ?? "WIN")).length;
    const total = (b: typeof lb) => b.reduce((a, t) => a + t.count, 0);
    check(`unstamped rows: SQL tiles hold fewer decided picks than legacy (${total(nb)} vs ${total(lb)}), never more, and only rows with no stored category are missing`, total(nb) <= total(lb) && total(lb) - total(nb) <= unstampedDecidedInChips && total(lb) !== total(nb));
  }
  for (const n of [2000, 2001, 5000]) {
    const { userId, capperId } = await makeUser(`big${n}`);
    const specs = randomSpecs(capperId, n, 40 + n, 300).map((s) => ({ ...s, status: s.status === "PENDING" || s.status === "CANCELLED" ? ("LOSS" as const) : s.status, gradedAt: "auto" as const }));
    await insertAll(specs.map((s) => row(userId, s)));
    const { next } = await compare(`${n} settled picks (${n > 2000 ? "downsampled" : "identity at the threshold"})`, userId);
    check(`${n} settled picks: chart has ${next.chartData.length} points (<= 2000${n > 2000 ? ", bucketed" : ", all points"})`, next.chartData.length <= 2000 && (n > 2000 ? next.chartData.length < n : next.chartData.length === n));
  }
  {
    // Cache wrapper: outside a Next request there is no incremental cache, so it runs the function directly.
    const userId = `${PREFIX}user-mixed`;
    const viaWrapper = await getDashboardSummary(userId);
    const direct = await computeDashboardSummary(userId);
    // `now` differs by milliseconds between the calls; nothing in this fixture sits near the cutoff.
    check("getDashboardSummary (cachedByTag wrapper) == computeDashboardSummary", firstDiff(viaWrapper, direct) === null, firstDiff(viaWrapper, direct) ?? "");
    check("Q4 shape: overall is exactly { wins, losses, pushes, roi, netUnits }", Object.keys(direct.overall).sort().join() === "losses,netUnits,pushes,roi,wins");
    check("summary keys are the page's reads: overall, totalPicks, categoryBreakdown, chartData, pendingCount, stalePendingCount, recentPicks, trends", Object.keys(direct).sort().join() === "categoryBreakdown,chartData,overall,pendingCount,recentPicks,stalePendingCount,totalPicks,trends");
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
