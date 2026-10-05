// Parity + behavior tests for the /cappers page bundle (cappers-page-aggregates.ts): the ONE
// statement that filters, ranks, searches, paginates and summarizes in the database must show the
// same numbers the old page computed - record, win %, ROI, units, streaks, specialist tags, the
// favorites summary, most active - for the same time range and league, on every page; and the
// last-20 sparkline series must follow its rules (canonical order + tie-break, pending/cancelled
// excluded, push = 0 step, <20 and <3 picks).
//
// The "old page" reference is what the previous page.tsx called: adapter.getCapperLeaderboardTable /
// getFavoriteCappersSummary / getMostActiveThisWeek (themselves parity-tested against the raw-pick
// cappers.ts path), followed by the JS filter/sort/paginate the page used.
//
// DB-backed and WRITING: creates its own users/cappers/picks (ids prefixed `__CappersPageBundle__`)
// and deletes them by exact id at the end; REFUSES to run unless DATABASE_URL is localhost. Run
// against a disposable local Postgres with migrations applied:
//   DATABASE_URL=postgresql://postgres@localhost:5433/t_x DIRECT_URL=... npx tsx <this file>
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { PICK_CATEGORY_VERSION, SCORECARD_WINDOWS, pickCategory, currentStreak, type ScorecardWindow } from "@/server/data/stats";
import * as adapter from "@/server/data/pick-aggregates-cappers-adapter";
import type { LeaderboardEntry } from "@/server/data/cappers";
import { getCappersPageData, sparklineTone, SPARKLINE_MIN_PICKS, HOT_STREAK_MIN, STANDOUT_MIN_GRADED, STAT_WEEKS, getPanelRows, consistencyScore, consistencyTier, type ActiveEntry, type CapperSparkline, type PanelWindow, type StreakEntry } from "@/server/data/cappers-page-aggregates";
import { risingSeries } from "@/lib/cappers-panels";
import { sparklineLabel } from "@/components/dashboard/capper-sparkline";
import { comparePicksChronological } from "@/lib/pick-order";
import { MIN_PICKS_OPTIONS, PAGE_SIZE, SORT_OPTIONS, type CappersSortKey } from "@/lib/cappers-page-params";

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
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
}
function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b) || Math.abs(a - b) < 1e-9 ? null : `${path}: ${a} !== ${b}`;
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

// ---- fixture plumbing -------------------------------------------------------

const PREFIX = "__CappersPageBundle__";
const T0 = Date.now();
const ago = (minutes: number, seconds = 30) => new Date(T0 - minutes * 60000 - seconds * 1000);
const DAY = 1440;
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
async function makeUser(tag: string) {
  const id = `${PREFIX}user-${tag}`;
  await prisma.user.create({ data: { id, supabaseId: `${PREFIX}sb-${tag}`, email: `${PREFIX}${tag}@example.invalid` } });
  createdUserIds.push(id);
  return id;
}
async function makeCapper(userId: string, key: string, name: string, favorite = false) {
  const id = `${PREFIX}${userId.slice(PREFIX.length)}-${key}`;
  await prisma.capper.create({ data: { id, userId, name, source: "OTHER", isFavorite: favorite } });
  return id;
}

type PickSpec = {
  id?: string;
  capperId: string;
  sport?: string;
  betType?: Prisma.PickUncheckedCreateInput["betType"];
  odds?: number;
  units?: number;
  status?: Prisma.PickUncheckedCreateInput["status"];
  gameTime: Date;
  createdAt?: Date;
  datePosted?: Date;
  gradedAt?: Date | null | "auto";
};
let pickSeq = 0;
function pickRow(userId: string, s: PickSpec): Prisma.PickCreateManyInput {
  pickSeq++;
  const sport = s.sport ?? "MLB";
  const betType = s.betType ?? "MONEYLINE";
  const odds = s.odds ?? -110;
  const status = s.status ?? "WIN";
  return {
    id: s.id ?? `${PREFIX}pick-${String(pickSeq).padStart(6, "0")}`,
    userId,
    capperId: s.capperId,
    sportId: sportIdByName.get(sport)!,
    homeTeam: "Home",
    awayTeam: "Away",
    betType,
    betDetail: null,
    odds,
    line: null,
    period: "FULL_GAME",
    units: s.units ?? 1,
    datePosted: s.datePosted ?? s.gameTime,
    gameTime: s.gameTime,
    status,
    gradedAt: s.gradedAt === "auto" || s.gradedAt === undefined ? (status !== "PENDING" ? new Date(s.gameTime.getTime() + 3 * 3600000) : null) : s.gradedAt,
    createdAt: s.createdAt ?? new Date(T0 - pickSeq * 1000),
    pickedSide: null,
    mlFavoredSide: null,
    propMarket: null,
    category: pickCategory({ betType, period: "FULL_GAME", betDetail: null, odds, line: null, sportName: sport, pickedSide: null, mlFavoredSide: null, propMarket: null }),
    categoryVersion: PICK_CATEGORY_VERSION,
  };
}
const addPicks = (userId: string, specs: PickSpec[]) => prisma.pick.createMany({ data: specs.map((s) => pickRow(userId, s)) });

// ---- old-page reference -----------------------------------------------------

const stripStats = (e: LeaderboardEntry) => {
  const { longestWinStreak: _w, longestLossStreak: _l, ...stats } = e.stats as unknown as Record<string, unknown>;
  return { ...e, stats };
};
const decided = (e: LeaderboardEntry) => e.stats.wins + e.stats.losses + e.stats.pushes;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const SORTERS: Record<CappersSortKey, (a: LeaderboardEntry, b: LeaderboardEntry) => number> = {
  roi: (a, b) => b.stats.roi - a.stats.roi,
  win: (a, b) => b.stats.winPct - a.stats.winPct,
  units: (a, b) => b.stats.netUnits - a.stats.netUnits,
  record: (a, b) => b.stats.wins - b.stats.losses - (a.stats.wins - a.stats.losses) || b.stats.wins - a.stats.wins,
};
function rank(entries: LeaderboardEntry[], sort: CappersSortKey) {
  return [...entries].sort(
    (a, b) =>
      SORTERS[sort](a, b) ||
      b.stats.netUnits - a.stats.netUnits ||
      cmpStr(a.name.toLowerCase(), b.name.toLowerCase()) ||
      cmpStr(a.name, b.name) ||
      cmpStr(a.capperId, b.capperId)
  );
}

// Independent sparkline reference straight from the raw picks (comparePicksChronological is the JS
// twin of the SQL order).
async function referenceSparklines(userId: string): Promise<Map<string, { points: number[]; n: number }>> {
  const picks = await prisma.pick.findMany({ where: { userId, status: { in: ["WIN", "LOSS", "PUSH"] } } });
  const by = new Map<string, typeof picks>();
  for (const p of picks) (by.get(p.capperId) ?? by.set(p.capperId, []).get(p.capperId)!).push(p);
  const out = new Map<string, { points: number[]; n: number }>();
  for (const [cid, list] of by) {
    const last = list.sort(comparePicksChronological).slice(-20);
    let cum = 0;
    const points = [0];
    for (const p of last) {
      cum += p.status === "WIN" ? (p.odds === 0 ? 0 : p.units * (p.odds > 0 ? p.odds / 100 : 100 / Math.abs(p.odds))) : p.status === "LOSS" ? -p.units : 0;
      points.push(cum);
    }
    out.set(cid, { points, n: last.length });
  }
  return out;
}

// ---- fixtures ---------------------------------------------------------------

async function buildMainFixture(U: string) {
  const r = rng(7);
  const sports = ["MLB", "NFL", "NBA"];
  const names = ["Alpha", "bravo", "Charlie", "Delta", "echo", "Foxtrot", "Golf", "hotel", "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "Xray", "Yankee", "Zulu"];
  const ids: string[] = [];
  for (let i = 0; i < 52; i++) ids.push(await makeCapper(U, `c${i}`, names[i % names.length] + " " + String(i).padStart(2, "0"), i % 7 === 0));
  const specs: PickSpec[] = [];
  ids.forEach((capperId, i) => {
    // 0-pick cappers, tiny cappers, and heavy ones (some >20 picks so the last-20 cut matters).
    const n = i % 13 === 5 ? 0 : i % 5 === 0 ? 1 + (i % 4) : 8 + Math.floor(r() * 45);
    const skill = 0.35 + r() * 0.35;
    for (let k = 0; k < n; k++) {
      const minutesAgo = Math.floor(r() * 75 * DAY) + 5;
      const roll = r();
      const status: Prisma.PickUncheckedCreateInput["status"] = roll < 0.06 ? "PENDING" : roll < 0.09 ? "CANCELLED" : roll < 0.13 ? "PUSH" : r() < skill ? "WIN" : "LOSS";
      specs.push({
        capperId,
        sport: sports[Math.floor(r() * 3)],
        status,
        odds: [-110, -150, 130, 200, -105][Math.floor(r() * 5)],
        units: [1, 1, 2, 0.5, 1.5][Math.floor(r() * 5)],
        gameTime: ago(minutesAgo),
        datePosted: ago(minutesAgo + 60),
      });
    }
  });
  // One capper riding a long win streak at the tail (hot streak), one on a loss streak.
  const hot = ids[3];
  for (let k = 0; k < 7; k++) specs.push({ capperId: hot, sport: "MLB", status: "WIN", gameTime: ago(120 + k * 60), datePosted: ago(150 + k * 60) });
  const cold = ids[4];
  for (let k = 0; k < 4; k++) specs.push({ capperId: cold, sport: "NFL", status: "LOSS", gameTime: ago(100 + k * 60), datePosted: ago(130 + k * 60) });
  await addPicks(U, specs);
  return ids;
}

async function buildSparklineFixture(U: string) {
  const G = "MLB";
  const specs: PickSpec[] = [];
  // S1: 25 graded picks, distinct times -> exactly the newest 20, oldest-first.
  const s1 = await makeCapper(U, "s1", "Spark 25");
  for (let k = 0; k < 25; k++) specs.push({ capperId: s1, sport: G, status: k % 3 === 0 ? "LOSS" : "WIN", odds: k % 2 ? 150 : -120, units: 1 + (k % 3) * 0.5, gameTime: ago(1000 + (25 - k) * 100) });
  // S2: 22 picks; the newest 6 share ONE gameTime, so the 20-pick cutoff falls inside a tie group.
  // Tie-break is createdAt then id: distinct createdAt for four, identical createdAt (id decides) for two.
  const s2 = await makeCapper(U, "s2", "Spark tie");
  for (let k = 0; k < 16; k++) specs.push({ capperId: s2, sport: G, status: "WIN", gameTime: ago(3000 + (16 - k) * 60) });
  const tieTime = ago(2000);
  const base = T0 - 10_000_000;
  [
    { id: "a", status: "LOSS", c: 1 },
    { id: "b", status: "WIN", c: 2 },
    { id: "c", status: "LOSS", c: 3 },
    { id: "d", status: "WIN", c: 4 },
    { id: "e", status: "LOSS", c: 5 },
    { id: "f", status: "WIN", c: 5 },
  ].forEach((t, i) =>
    specs.push({ id: `${PREFIX}tie-${t.id}`, capperId: s2, sport: G, status: t.status as "WIN" | "LOSS", gameTime: tieTime, createdAt: new Date(base + t.c * 1000), units: 1 + i })
  );
  // S3: pending and cancelled mixed with a push -> only W/L/P count; the push is a flat step.
  const s3 = await makeCapper(U, "s3", "Spark mixed");
  specs.push(
    { capperId: s3, sport: G, status: "WIN", gameTime: ago(900) },
    { capperId: s3, sport: G, status: "PENDING", gameTime: ago(800) },
    { capperId: s3, sport: G, status: "PUSH", gameTime: ago(700) },
    { capperId: s3, sport: G, status: "CANCELLED", gameTime: ago(600) },
    { capperId: s3, sport: G, status: "LOSS", gameTime: ago(500) },
    { capperId: s3, sport: G, status: "PENDING", gameTime: ago(400) }
  );
  // S4: only two graded picks -> below the 3-pick minimum. S5: none graded. S6: net exactly zero.
  const s4 = await makeCapper(U, "s4", "Spark two");
  specs.push({ capperId: s4, sport: G, status: "WIN", gameTime: ago(300) }, { capperId: s4, sport: G, status: "LOSS", gameTime: ago(200) });
  const s5 = await makeCapper(U, "s5", "Spark none");
  specs.push({ capperId: s5, sport: G, status: "PENDING", gameTime: ago(100) });
  const s6 = await makeCapper(U, "s6", "Spark zero");
  specs.push(
    { capperId: s6, sport: G, status: "WIN", odds: 100, gameTime: ago(700) },
    { capperId: s6, sport: G, status: "LOSS", odds: 100, gameTime: ago(600) },
    { capperId: s6, sport: G, status: "PUSH", gameTime: ago(500) }
  );
  await addPicks(U, specs);
  return { s1, s2, s3, s4, s5, s6 };
}

// ---- main -------------------------------------------------------------------

async function main() {
  for (const s of ["MLB", "NFL", "NBA"]) await ensureSport(s);

  // ============ Main parity fixture ============
  const U = await makeUser("main");
  await buildMainFixture(U);
  console.log(`main fixture: ${await prisma.pick.count({ where: { userId: U } })} picks, ${await prisma.capper.count({ where: { userId: U } })} cappers\n`);

  const leagues: (string | undefined)[] = [undefined, "MLB", "NFL"];
  const combos: { min: number; sort: CappersSortKey; fav: boolean; q: string }[] = [
    { min: 10, sort: "roi", fav: false, q: "" },
    { min: 0, sort: "record", fav: false, q: "" },
    { min: 5, sort: "win", fav: false, q: "" },
    { min: 20, sort: "units", fav: false, q: "" },
    { min: 0, sort: "roi", fav: true, q: "" },
    { min: 0, sort: "units", fav: false, q: "ALPHA" },
  ];

  for (const window of SCORECARD_WINDOWS as ScorecardWindow[]) {
    for (const league of leagues) {
      const label = `${window} ${league ?? "all leagues"}`;
      const oldAll = await adapter.getCapperLeaderboardTable(U, window);
      const oldEntries = league ? await adapter.getCapperLeaderboardTable(U, window, { sportName: league }) : oldAll;

      for (const c of combos) {
        const q = c.q.trim().toLowerCase();
        const expectedAll = rank(
          oldEntries.filter((e) => decided(e) >= c.min && (!c.fav || e.isFavorite) && (!q || e.name.toLowerCase().includes(q))),
          c.sort
        );
        const last = Math.max(1, Math.ceil(expectedAll.length / PAGE_SIZE));
        const pages = last === 1 ? [1] : [1, 2, last];
        for (const page of pages) {
          const got = await getCappersPageData({ userId: U, window, league, min: c.min, sort: c.sort, fav: c.fav, q: c.q, page });
          const expected = expectedAll.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
          same(`rows [${label}] min=${c.min} sort=${c.sort} fav=${c.fav} q="${c.q}" p${page}/${last} (${expected.length} rows)`, got.rows.map(stripStats), expected.map(stripStats));
          check(`total [${label}] min=${c.min} sort=${c.sort} fav=${c.fav} q="${c.q}"`, got.total === expectedAll.length, `${got.total} vs ${expectedAll.length}`);
        }
      }

      // Page beyond the last clamps to the last page.
      const clampCombo = combos[1];
      const expectedClamp = rank(oldEntries.filter((e) => decided(e) >= clampCombo.min), clampCombo.sort);
      const lastP = Math.max(1, Math.ceil(expectedClamp.length / PAGE_SIZE));
      const clamped = await getCappersPageData({ userId: U, window, league, ...clampCombo, page: 999 });
      check(`page clamp [${label}]`, clamped.page === lastP && clamped.rows.length === expectedClamp.slice((lastP - 1) * PAGE_SIZE).length, `page ${clamped.page} vs ${lastP}`);

      // Everything below is independent of the leaderboard filters: use the default query.
      const data = await getCappersPageData({ userId: U, window, league, min: 10, sort: "roi", fav: true, q: "", page: 1 });

      // Standout: unscoped by league, the window's own minimum (not the leaderboard's), net units > 0
      // AND wins > losses (finite), ranked by net units, then win %, then graded picks.
      const topExpected = oldAll
        .filter((e) => decided(e) >= STANDOUT_MIN_GRADED[window] && e.stats.netUnits > 0 && Number.isFinite(e.stats.netUnits) && e.stats.wins > e.stats.losses)
        .sort((a, b) => b.stats.netUnits - a.stats.netUnits || b.stats.winPct - a.stats.winPct || decided(b) - decided(a))
        .slice(0, 4);
      // The cards draw name, avatar colour, record, win %, ROI and units - no badges - so specialist and
      // streak are deliberately not fetched for them.
      const cardFields = (e: LeaderboardEntry) => {
        const { currentStreak: _s, longestWinStreak: _w, longestLossStreak: _l, ...stats } = e.stats as unknown as Record<string, unknown>;
        return { capperId: e.capperId, name: e.name, colorTag: e.colorTag, stats };
      };
      same(`top cappers [${label}]`, data.top.map(cardFields), topExpected.map(cardFields));
      // The leaderboard's min-picks dropdown never changes Standout.
      const dataLoose = await getCappersPageData({ userId: U, window, league, min: 0, sort: "units", fav: false, q: "", page: 1 });
      same(`top cappers ignore the min-picks dropdown [${label}]`, dataLoose.top.map(cardFields), data.top.map(cardFields));

      // Favorites summary: the old function, all sports regardless of league.
      const oldFav = await adapter.getFavoriteCappersSummary(U, window);
      const { currentStreak: _c, longestWinStreak: _lw, longestLossStreak: _ll, ...newCollective } = data.favSummary!.collectiveStats as unknown as Record<string, unknown>;
      const { currentStreak: _c2, longestWinStreak: _lw2, longestLossStreak: _ll2, ...oldCollective } = oldFav!.collectiveStats as unknown as Record<string, unknown>;
      same(`favorites summary [${label}]`, newCollective, oldCollective);

      // Most active: the old function (this week, never league/window scoped).
      // totalPicks is new with the panel footer (checked on its own fixture below); the old page had no such number.
      same(`most active [${label}]`, data.mostActive.map(({ totalPicks: _total, ...e }) => e), await adapter.getMostActiveThisWeek(U));

      // Hot streaks card = unscoped WIN streaks >= 5 in the window (from the old entries' streaks).
      const hotExpected = oldAll.filter((e) => e.stats.currentStreak.type === "WIN" && e.stats.currentStreak.count >= HOT_STREAK_MIN).length;
      check(`hot streaks [${label}]`, data.overview.hotStreaks === hotExpected, `${data.overview.hotStreaks} vs ${hotExpected}`);

      // Overview money totals (avg ROI, graded picks) pooled across cappers.
      const pooledDecided = oldAll.reduce((s, e) => s + decided(e), 0);
      check(`graded picks [${label}]`, data.overview.gradedPicks === pooledDecided, `${data.overview.gradedPicks} vs ${pooledDecided}`);
    }
  }
  check("hot-streak fixture actually has a hot capper", (await getCappersPageData({ userId: U, window: "ALL", min: 0, sort: "roi", fav: false, q: "", page: 1 })).overview.hotStreaks >= 1);

  // Active cappers / picks this week straight from the raw rows.
  const rawPicks = await prisma.pick.findMany({ where: { userId: U }, select: { capperId: true, datePosted: true } });
  const now = new Date();
  const weekAgo = now.getTime() - 7 * 86400000;
  const twoWeeks = now.getTime() - 14 * 86400000;
  const ov = (await getCappersPageData({ userId: U, window: "ALL", min: 0, sort: "roi", fav: false, q: "", page: 1, now })).overview;
  check("active cappers ALL = cappers with any pick", ov.activeCappers === new Set(rawPicks.map((p) => p.capperId)).size);
  const activeIn = (from: number, to: number) => new Set(rawPicks.filter((p) => p.datePosted.getTime() >= from && p.datePosted.getTime() < to).map((p) => p.capperId)).size;
  check("active cappers delta = this week's active cappers minus last week's", ov.activeCappersDelta === activeIn(weekAgo, now.getTime()) - activeIn(twoWeeks, weekAgo), String(ov.activeCappersDelta));
  check("picks this week", ov.picksThisWeek === rawPicks.filter((p) => p.datePosted.getTime() >= weekAgo).length);
  const priorWeek = rawPicks.filter((p) => p.datePosted.getTime() >= twoWeeks && p.datePosted.getTime() < weekAgo).length;
  check("picks this week % vs last week", priorWeek === 0 ? ov.picksThisWeekPct === null : Math.abs(ov.picksThisWeekPct! - Math.round(((ov.picksThisWeek - priorWeek) / priorWeek) * 1000) / 10) < 1e-9);

  // Sparklines: only for the displayed cappers, each equal to the raw-pick reference.
  const ref = await referenceSparklines(U);
  const disp = await getCappersPageData({ userId: U, window: "LAST_30", min: 0, sort: "units", fav: false, q: "", page: 2 });
  const shownIds = new Set([...disp.rows.map((e) => e.capperId), ]);
  check("sparklines cover only displayed cappers", [...disp.sparklines.keys()].every((k) => shownIds.has(k)), `${disp.sparklines.size} series for ${shownIds.size} displayed`);
  check("sparklines cover every displayed capper with a graded pick", [...shownIds].every((id) => !ref.has(id) || disp.sparklines.has(id)));
  for (const [id, s] of disp.sparklines) same(`sparkline series matches raw reference (${id.slice(-4)})`, s.points, ref.get(id)!.points);

  // ============ Sparkline rules fixture ============
  const U2 = await makeUser("spark");
  const sc = await buildSparklineFixture(U2);
  const d2 = await getCappersPageData({ userId: U2, window: "ALL", min: 0, sort: "roi", fav: false, q: "", page: 1 });
  const ref2 = await referenceSparklines(U2);
  const S = (id: string): CapperSparkline | undefined => d2.sparklines.get(id);

  for (const [k, id] of Object.entries(sc)) {
    const r = ref2.get(id);
    if (r) same(`sparkline ${k} points == reference`, S(id)?.points, r.points);
    else check(`sparkline ${k}: no graded picks -> no series`, S(id) === undefined);
  }
  check("S1: 25 graded picks -> the newest 20 (21 points from 0)", S(sc.s1)!.n === 20 && S(sc.s1)!.points.length === 21 && S(sc.s1)!.points[0] === 0);
  // S2: the cutoff (20 newest of 22) falls inside the 6-way gameTime tie; the tie-break is createdAt, id,
  // so the two oldest excluded picks are 16 wins-side... assert via the reference, plus the exact drop count.
  check("S2: 22 graded picks -> 20 kept", S(sc.s2)!.n === 20);
  check("S3: pending + cancelled excluded, push counted (WIN, PUSH, LOSS = 3 graded)", S(sc.s3)!.n === 3);
  const s3pts = S(sc.s3)!.points;
  check("S3: the push is a flat step (0 added)", s3pts[2] === s3pts[1], JSON.stringify(s3pts));
  check("S4: 2 graded picks -> series present but below the minimum (flat tone, no label)", S(sc.s4)!.n === 2 && sparklineTone(S(sc.s4)) === "flat" && sparklineLabel(S(sc.s4)) === null);
  check("S5: only pending -> no series (flat, no label)", S(sc.s5) === undefined && sparklineTone(undefined) === "flat" && sparklineLabel(undefined) === null);
  check("S6: net exactly 0 -> grey with a label", S(sc.s6)!.netUnits === 0 && sparklineTone(S(sc.s6)) === "flat" && sparklineLabel(S(sc.s6))?.text === "0.0u L20");
  check("min-pick constant is 3", SPARKLINE_MIN_PICKS === 3);
  const up: CapperSparkline = { points: [0, 1, 6.14], netUnits: 6.14, n: 3 };
  const down: CapperSparkline = { points: [0, -1, -3.2], netUnits: -3.2, n: 3 };
  check("tone/label: positive is green '+6.1u L20'", sparklineTone(up) === "up" && sparklineLabel(up)?.text === "+6.1u L20");
  check("tone/label: negative is red '−3.2u L20'", sparklineTone(down) === "down" && sparklineLabel(down)?.text === "−3.2u L20");

  // ============ Odds = 0 wins: the sort key must be exactly the displayed value ============
  // A WIN at odds 0 makes the DISPLAYED unitsWon (and ROI, net units) Infinity / -Infinity / NaN. The SQL
  // sort keys use the same poisoned expression, so the order always follows the numbers on screen
  // (Infinity first ... -Infinity last, NaN last of all - it has no place in an order).
  const U3 = await makeUser("odds0");
  const z: Record<string, string> = {};
  for (const k of ["inf", "nan", "ninf", "a", "b", "c", "d"]) z[k] = await makeCapper(U3, k, "Odds " + k);
  await addPicks(U3, [
    { capperId: z.inf, status: "WIN", odds: 0, units: 1, gameTime: ago(500) },
    { capperId: z.inf, status: "LOSS", odds: -110, units: 1, gameTime: ago(400) },
    { capperId: z.nan, status: "WIN", odds: 0, units: 0, gameTime: ago(500) },
    { capperId: z.nan, status: "LOSS", odds: -110, units: 1, gameTime: ago(400) },
    { capperId: z.ninf, status: "WIN", odds: 0, units: -1, gameTime: ago(500) },
    { capperId: z.ninf, status: "LOSS", odds: -110, units: 3, gameTime: ago(400) },
    { capperId: z.a, status: "WIN", odds: 200, units: 1, gameTime: ago(500) },
    { capperId: z.b, status: "WIN", odds: 100, units: 1, gameTime: ago(500) },
    { capperId: z.b, status: "LOSS", odds: 100, units: 1, gameTime: ago(450) },
    { capperId: z.c, status: "LOSS", odds: -110, units: 2, gameTime: ago(500) },
    { capperId: z.d, status: "WIN", odds: -110, units: 1, gameTime: ago(500) },
    { capperId: z.d, status: "LOSS", odds: -110, units: 1.5, gameTime: ago(450) },
  ]);
  // Total order over displayed numbers: NaN last; otherwise descending (Infinity first, -Infinity last).
  const nanRank = (v: number) => (Number.isNaN(v) ? 1 : 0);
  const cmpDesc = (a: number, b: number) => nanRank(a) - nanRank(b) || (a === b ? 0 : b > a ? 1 : -1);
  for (const sort of ["roi", "units"] as const) {
    const d3 = await getCappersPageData({ userId: U3, window: "ALL", min: 0, sort, fav: false, q: "", page: 1 });
    const shown = d3.rows.map((e) => (sort === "roi" ? e.stats.roi : e.stats.netUnits));
    check(`odds 0: fixture displays Infinity, -Infinity and NaN (sort=${sort})`, shown.includes(Infinity) && shown.includes(-Infinity) && shown.some(Number.isNaN), shown.map(String).join(","));
    check(`odds 0: sort=${sort} order follows the displayed values`, shown.every((v, i) => i === 0 || cmpDesc(shown[i - 1], v) <= 0), shown.map(String).join(","));
    check(`odds 0: sort=${sort} puts Infinity first and NaN last`, shown[0] === Infinity && Number.isNaN(shown[shown.length - 1]), shown.map(String).join(","));
  }
  const top3 = await getCappersPageData({ userId: U3, window: "ALL", min: 1, sort: "roi", fav: false, q: "", page: 1 });
  const topShown = top3.top.map((e) => e.stats.roi);
  check("odds 0: Standout leaves out non-finite units, rest ordered by net units", top3.top.every((e) => Number.isFinite(e.stats.netUnits) && e.stats.netUnits > 0) && top3.top.every((e, i) => i === 0 || top3.top[i - 1].stats.netUnits >= e.stats.netUnits), JSON.stringify(topShown));

  // ============ Winners this week ============
  // Independent reference straight from the raw picks: datePosted in the last 7 days (Most active's
  // window), graded (WIN/LOSS/PUSH) only, >= 5 graded, net units = sum(win units) - sum(loss units)
  // with a push at 0, rounded to 2dp, > 0; ordered units desc, then the page's tie order.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  async function referenceWinners(userId: string) {
    const since = Date.now() - 7 * 86400000;
    const picks = await prisma.pick.findMany({ where: { userId, datePosted: { gte: new Date(since) }, status: { in: ["WIN", "LOSS", "PUSH"] } }, include: { capper: true } });
    const by = new Map<string, { name: string; n: number; net: number; wins: number; losses: number }>();
    for (const p of picks) {
      const e = by.get(p.capperId) ?? by.set(p.capperId, { name: p.capper.name, n: 0, net: 0, wins: 0, losses: 0 }).get(p.capperId)!;
      e.n++;
      if (p.status === "WIN") e.wins++;
      if (p.status === "LOSS") e.losses++;
      e.net += p.status === "WIN" ? p.units * (p.odds > 0 ? p.odds / 100 : 100 / Math.abs(p.odds)) : p.status === "LOSS" ? -p.units : 0;
    }
    return [...by.entries()]
      .map(([capperId, e]) => ({ capperId, name: e.name, n: e.n, netUnits: r2(e.net), wins: e.wins, losses: e.losses }))
      .filter((e) => e.n >= 5 && e.netUnits > 0)
      .sort((a, b) => b.netUnits - a.netUnits || cmpStr(a.name.toLowerCase(), b.name.toLowerCase()) || cmpStr(a.name, b.name) || cmpStr(a.capperId, b.capperId))
      .slice(0, 5)
      .map(({ capperId, name, netUnits, wins, losses }) => ({ capperId, name, colorTag: null as string | null, netUnits, wins, losses }));
  }
  const winnersOf = async (userId: string, o: { window?: ScorecardWindow; league?: string } = {}) =>
    (await getCappersPageData({ userId, window: o.window ?? "ALL", league: o.league, min: 0, sort: "roi", fav: false, q: "", page: 1 })).winners;
  // One pick per status, posted `startMin`, `startMin`+60, ... minutes ago.
  const seq = (capperId: string, statuses: PickSpec["status"][], o: { odds?: number; units?: number; startMin?: number; sport?: string } = {}): PickSpec[] =>
    statuses.map((status, i) => ({ capperId, status, odds: o.odds ?? 100, units: o.units ?? 1, sport: o.sport, gameTime: ago((o.startMin ?? 60) + i * 60) }));
  const W = "WIN" as const;
  const L = "LOSS" as const;
  const P = "PUSH" as const;

  // Fixture A: eight qualifiers (only the top 5 are returned), ties, and every exclusion rule.
  const UH = await makeUser("hot");
  const h: Record<string, string> = {};
  const hotNames: Record<string, string> = {
    a: "Hot A", b: "Hot B", c: "Hot C", d: "Hot D", tieB: "Bravo tie", tieA: "alpha tie", pushy: "Pushy",
    lucky: "Lucky", pending: "Pending", stale: "Stale", cold: "Cold", zero: "Zero", posted: "Posted late", cancelled: "Cancelled", fav: "Fav ignored",
  };
  for (const [k, name] of Object.entries(hotNames)) h[k] = await makeCapper(UH, k, name, k === "fav");
  await addPicks(UH, [
    ...seq(h.a, [W, W, W, L, L, L], { units: 2, odds: 150 }), // 3*3 - 3*2 = +3.0
    ...seq(h.b, [W, W, W, W, L], { odds: -110 }), // 4*0.909.. - 1 = +2.636.. -> 2.64
    ...seq(h.c, [W, W, W, W, W, L], { odds: 100 }), // +4.0
    ...seq(h.d, [W, W, W, L, L], { odds: 200, units: 0.5 }), // 3*1 - 1 = +2.0
    ...seq(h.tieB, [W, L, L, W, W], { odds: 100 }), // +1.0
    ...seq(h.tieA, [W, L, L, W, W], { odds: 100 }), // +1.0 (same as Bravo tie: name order decides)
    ...seq(h.pushy, [W, W, W, P, P], { odds: 100 }), // pushes count toward the 5 and add 0: +3.0
    ...seq(h.lucky, [W, W, W, W], { odds: 1000, units: 5 }), // +200 but only 4 graded -> excluded
    ...seq(h.pending, [W, W, W, W, "PENDING", "PENDING", "PENDING"], { odds: 100 }), // 4 graded + pending -> excluded
    ...seq(h.cancelled, [W, W, W, W, "CANCELLED", "CANCELLED"], { odds: 100 }), // 4 graded + cancelled -> excluded
    ...seq(h.stale, [W, W, W, W, W, W], { odds: 100, startMin: 8 * DAY + 60 }), // posted 8+ days ago -> outside the window
    ...seq(h.cold, [W, L, L, L, L], { odds: 100 }), // negative
    ...seq(h.zero, [W, L, W, L, P], { odds: 100 }), // exactly 0
    // datePosted (not gameTime) decides the window: game just now, posted 9 days ago -> not counted.
    ...[W, W, W, W, W].map((status, i): PickSpec => ({ capperId: h.posted, status, odds: 100, gameTime: ago(60 + i * 60), datePosted: ago(9 * DAY + i) })),
    ...seq(h.fav, [W, W, W, W, W], { odds: 100 }), // +5.0: favorites get no special treatment
    // Old winners must not rescue "Cold", and an old loss must not touch "Lucky".
    ...seq(h.cold, [W, W, W, W, W, W, W, W], { odds: 100, startMin: 10 * DAY }),
    ...seq(h.lucky, [L], { odds: 100, startMin: 12 * DAY }),
  ]);

  const gotH = await winnersOf(UH);
  same("winners: equals the raw-pick reference (top 5, ordered by units, page tie order)", gotH, await referenceWinners(UH));
  check("winners: exactly 5 rows although 7 cappers qualify", gotH.length === 5, String(gotH.length));
  check(
    "winners: ordered by net units, ties by name (Fav 5.0, Hot C 4.0, then Hot A / Pushy at 3.0, Hot B 2.64)",
    gotH.map((e) => e.name).join("|") === "Fav ignored|Hot C|Hot A|Pushy|Hot B",
    gotH.map((e) => e.name + " " + e.netUnits).join("|")
  );
  same("winners: units values (exact, 2dp)", gotH.map((e) => e.netUnits), [5, 4, 3, 3, 2.64]);
  const nameSet = new Set(gotH.map((e) => e.name));
  for (const [why, name] of [
    ["min 5 graded picks", "Lucky"],
    ["pending picks are not graded", "Pending"],
    ["cancelled picks are not graded", "Cancelled"],
    ["picks posted before the 7-day window", "Stale"],
    ["datePosted (not gameTime) decides the window", "Posted late"],
    ["net units < 0", "Cold"],
    ["net units = 0", "Zero"],
  ] as const)
    check(`winners: "${name}" excluded (${why})`, !nameSet.has(name));
  check("winners: a push adds 0 units and counts as a graded pick (3 wins + 2 pushes = +3.0, eligible)", gotH.find((e) => e.name === "Pushy")?.netUnits === 3);

  // Tie rule at the cut: three cappers on exactly +1.0 compete for the one remaining slot.
  const UT = await makeUser("hottie");
  const tt: Record<string, string> = {};
  for (const [k, name] of Object.entries({ z1: "Top 1", z2: "Top 2", z3: "Top 3", z4: "Top 4", b: "Bravo tie", a: "alpha tie", c: "charlie tie" })) tt[k] = await makeCapper(UT, k, name);
  await addPicks(UT, [
    ...seq(tt.z1, [W, W, W, W, W, W], { units: 4 }),
    ...seq(tt.z2, [W, W, W, W, W, W], { units: 3 }),
    ...seq(tt.z3, [W, W, W, W, W, W], { units: 2 }),
    ...seq(tt.z4, [W, W, W, W, W, W], { units: 1.5 }),
    ...seq(tt.b, [W, L, L, W, W]),
    ...seq(tt.a, [W, L, L, W, W]),
    ...seq(tt.c, [W, L, L, W, W]),
  ]);
  const gotT = await winnersOf(UT);
  same("winners tie rule: equal units -> lower(name) (names are unique per user, case-insensitively) (matches reference)", gotT, await referenceWinners(UT));
  check("winners tie rule: 'alpha tie' < 'Bravo tie' < 'charlie tie' by lower(name) (raw byte order would pick 'Bravo tie') -> the last slot goes to 'alpha tie'", gotT.length === 5 && gotT[4].name === "alpha tie", gotT.map((e) => e.name).join("|"));

  // Fewer than 5 qualify -> fewer rows; none qualify -> empty list (the panel shows its muted empty state).
  const UF = await makeUser("hotfew");
  const ff: Record<string, string> = {};
  for (const k of ["a", "b", "loser", "few"]) ff[k] = await makeCapper(UF, k, "Few " + k);
  await addPicks(UF, [
    ...seq(ff.a, [W, W, W, W, W]),
    ...seq(ff.b, [W, W, W, W, L]),
    ...seq(ff.loser, [L, L, L, L, L]),
    ...seq(ff.few, [W, W]), // too few picks
  ]);
  const gotF = await winnersOf(UF);
  same("winners: fewer than 5 qualify -> only those rows", gotF, await referenceWinners(UF));
  check("winners: fewer-than-5 case returns exactly the 2 winners, best first", gotF.map((e) => e.name + " " + e.netUnits).join("|") === "Few a 5|Few b 3", gotF.map((e) => e.name + " " + e.netUnits).join("|"));

  const UN = await makeUser("hotnone");
  const nn = await makeCapper(UN, "n1", "Nobody wins");
  const nn2 = await makeCapper(UN, "n2", "Lucky small");
  await addPicks(UN, [...seq(nn, [L, L, L, L, L, W]), ...seq(nn2, [W, W, W, W])]);
  check("winners: no winning capper -> empty list", (await winnersOf(UN)).length === 0);
  check("winners: a user with no picks at all -> empty list", (await winnersOf(await makeUser("hotempty"))).length === 0);

  // The card ignores the time tabs and the league select: same list for every window and league.
  for (const window of SCORECARD_WINDOWS as ScorecardWindow[])
    for (const league of [undefined, "MLB", "NFL"]) same(`winners ignores window/league [${window} ${league ?? "all"}]`, await winnersOf(UH, { window, league }), gotH);

  // Same units as elsewhere: these cappers have all their picks inside the week, so the ALL-time
  // leaderboard's displayed net units (the number every other card shows) must equal the Winners value.
  const allTime = new Map((await adapter.getCapperLeaderboardTable(UH, "ALL")).map((e) => [e.capperId, e.stats.netUnits]));
  for (const e of gotH) check(`winners units == leaderboard units (${e.name})`, allTime.get(e.capperId) === e.netUnits, `${e.netUnits} vs ${allTime.get(e.capperId)}`);

  // An odds = 0 win poisons the displayed units (Infinity / NaN); such a value has no bar or "+X.Xu", so it is left out.
  const U0 = await makeUser("hotodds0");
  const o0 = await makeCapper(U0, "o", "Odds zero");
  const o1 = await makeCapper(U0, "p", "Odds normal");
  await addPicks(U0, [...seq(o0, [W, W, W, W, L], { odds: 0 }), ...seq(o1, [W, W, W, W, L], { odds: 100 })]);
  same("winners: non-finite (odds = 0 win) units are left out, normal capper still listed", (await winnersOf(U0)).map((e) => e.name), ["Odds normal"]);

  // Scoped to the user: every returned capper belongs to that user's fixture.
  check("winners: scoped to the user (no cross-user rows)", gotH.every((e) => e.capperId.startsWith(PREFIX + "user-hot-")) && gotT.every((e) => e.capperId.startsWith(PREFIX + "user-hottie-")));

  // ---- Hottest / Coldest: CURRENT win / loss streak (v2 panels) ------------------------------------
  // Same streak definition as the "Hot streaks" stat: WIN/LOSS only, a push or void neither extends nor
  // breaks a run, newest first by (gameTime, createdAt, id). The panel window only decides eligibility
  // (>= 1 graded pick with gameTime in the window); the run itself reads the whole history of the capper.
  const streakOf = async (userId: string, panel: "hottest" | "coldest", window: PanelWindow = "week") => (await getPanelRows({ userId, panel, window })) as StreakEntry[];
  const line = (rows: StreakEntry[]) => rows.map((e) => e.name + ":" + e.streak + (e.units === undefined ? "" : ":" + e.units));
  const D8 = 8 * DAY + 60;
  // Statuses below are listed NEWEST FIRST (seq puts index 0 the most recent).
  const scenario = async (tag: string, cappers: { name: string; specs: (capperId: string) => PickSpec[] }[]) => {
    const u = await makeUser(tag);
    const ids: Record<string, string> = {};
    for (const [i, c] of cappers.entries()) {
      ids[c.name] = await makeCapper(u, String(i), c.name);
      await addPicks(u, c.specs(ids[c.name]));
    }
    return { u, ids };
  };

  // 1. Skip rules and the minimum length.
  const S1 = await scenario("streakskip", [
    { name: "Six wins", specs: (c) => seq(c, [W, W, W, W, W, W, L], { odds: 100 }) },
    { name: "Push skipped", specs: (c) => seq(c, [W, W, P, W, W, L], { odds: 100 }) }, // a push mid-run is skipped: 4 wins
    { name: "Void skipped", specs: (c) => seq(c, [W, "CANCELLED", W, "PENDING", W, L], { odds: 100 }) }, // void + pending skipped: 3 wins
    { name: "Loss breaks", specs: (c) => seq(c, [W, W, L, W, W, W], { odds: 100 }) }, // a LOSS ends the run at 2: below the minimum 3
    { name: "Push on top", specs: (c) => seq(c, [P, W, W, W, L], { odds: 100 }) }, // newest pick is a push: the 3 wins behind it still count
    { name: "Mixed", specs: (c) => seq(c, [W, L, W, L], { odds: 100 }) },
  ]);
  same("hottest: longest run first, then units, then name; pushes/voids skipped, a loss breaks a run, min 3", line(await streakOf(S1.u, "hottest")), [
    "Six wins:6", "Push skipped:4", "Push on top:3", "Void skipped:3",
  ]);
  same("coldest: none of them are on a loss streak >= 3", await streakOf(S1.u, "coldest"), []);
  // The default-window panel on the page is the same SQL as the dropdown fetch.
  const pageS1 = await getCappersPageData({ userId: S1.u, window: "ALL", min: 0, sort: "roi", fav: false, q: "", page: 1 });
  same("hottest: page statement == dropdown fetch (week)", pageS1.hottest, await streakOf(S1.u, "hottest"));
  same("coldest: page statement == dropdown fetch (week)", pageS1.coldest, await streakOf(S1.u, "coldest"));
  // Every streak length agrees with the JS definition (stats.ts currentStreak) over the picks of the capper.
  for (const [name, id] of Object.entries(S1.ids)) {
    const picks = await prisma.pick.findMany({ where: { capperId: id } });
    const ref = currentStreak(picks.sort(comparePicksChronological).map((p) => ({ status: p.status }) as never));
    const got = (await streakOf(S1.u, "hottest")).find((e) => e.name === name);
    check(`hottest: "${name}" length == stats.ts currentStreak`, ref.type === "WIN" && ref.count >= 3 ? got?.streak === ref.count : got === undefined, `${JSON.stringify(ref)} vs ${got?.streak}`);
  }
  // Standout cards carry the same streak the leaderboard shows (ALL window).
  const lbAll = new Map((await adapter.getCapperLeaderboardTable(S1.u, "ALL")).map((e) => [e.capperId, e.stats.currentStreak]));
  for (const e of pageS1.top) same(`standout card streak == leaderboard streak (${e.name})`, e.stats.currentStreak, lbAll.get(e.capperId));

  // 2. The window is only an eligibility filter.
  const S2 = await scenario("streakwin", [
    { name: "Old only", specs: (c) => seq(c, [W, W, W, W, W], { odds: 100, startMin: D8 }) }, // nothing this week
    { name: "Spans window", specs: (c) => [...seq(c, [W, W, W], { odds: 100 }), ...seq(c, [W, W, W, L], { odds: 100, startMin: D8 })] }, // true run 6, not truncated to 3
    { name: "Pending only", specs: (c) => [...seq(c, ["PENDING"], { odds: 100 }), ...seq(c, [W, W, W, W, W], { odds: 100, startMin: D8 })] }, // a pending pick is not graded
    { name: "Push eligible", specs: (c) => [...seq(c, [P], { odds: 100 }), ...seq(c, [W, W, W, W, L], { odds: 100, startMin: D8 })] }, // a graded push makes it eligible
    { name: "Month only", specs: (c) => seq(c, [W, W, W], { odds: 100, startMin: 10 * DAY }) },
    { name: "No picks", specs: () => [] },
  ]);
  same("hottest [week]: true run length shown (6, not the 3 inside the window); no graded pick in window / pending-only excluded", line(await streakOf(S2.u, "hottest")), [
    "Spans window:6", "Push eligible:4",
  ]);
  same("hottest [30d]: a wider window admits more cappers", line(await streakOf(S2.u, "hottest", "30d")), [
    "Spans window:6", "Old only:5", "Pending only:5", "Push eligible:4", "Month only:3",
  ]);
  // Today (Eastern day so far): only a capper with a graded pick since Eastern midnight is eligible.
  const S2t = await scenario("streaktoday", [
    { name: "Today hot", specs: (c) => seq(c, [W, W, W], { odds: 100, startMin: 1 }) },
    { name: "Two days ago", specs: (c) => seq(c, [W, W, W], { odds: 100, startMin: 2 * DAY }) },
  ]);
  same("hottest [today]: needs a graded pick since Eastern midnight", line(await streakOf(S2t.u, "hottest", "today")), ["Today hot:3"]);

  // 3. Ties on length: larger units first, then name (case-insensitive, then bytewise).
  const S3 = await scenario("streaktie", [
    { name: "Bravo tie", specs: (c) => seq(c, [W, W, W, W, L], { odds: 100 }) },
    { name: "alpha tie", specs: (c) => seq(c, [W, W, W, W, L], { odds: 100 }) },
    { name: "Tie bigger units", specs: (c) => seq(c, [W, W, W, W, L], { odds: 200 }) },
    { name: "Two wins", specs: (c) => seq(c, [W, W, L], { odds: 100 }) },
  ]);
  same("hottest: tie on length -> larger units, then name", line(await streakOf(S3.u, "hottest")), ["Tie bigger units:4", "alpha tie:4", "Bravo tie:4"]);

  // 4. Coldest: units lost across the run, negated; odds-0 picks count toward the length but not the units.
  const S4 = await scenario("streakcold", [
    { name: "Cold six", specs: (c) => seq(c, [L, L, L, L, L, L, W], { odds: 100, units: 2 }) }, // 6 losses, -12.0u
    { name: "Cold odds zero", specs: (c) => [...seq(c, [L], { odds: 0, startMin: 60 }), ...seq(c, [L, L, L, W], { odds: 100, startMin: 120 })] }, // 4 losses, the odds-0 one left out: -3.0u
    { name: "Cold broken", specs: (c) => seq(c, [L, L, W, L, L, L], { odds: 100 }) }, // 2 -> excluded
    { name: "Cold tie big", specs: (c) => seq(c, [L, L, L, L, W], { odds: 100, units: 3 }) }, // 4 losses, -12.0u
    { name: "Cold tie small", specs: (c) => seq(c, [L, L, L, L, W], { odds: 100, units: 1 }) }, // 4 losses, -4.0u
    { name: "Cold push", specs: (c) => seq(c, [L, P, L, L, W], { odds: 100 }) }, // push skipped: 3 losses, -3.0u
    { name: "Hot one", specs: (c) => seq(c, [W, W, W], { odds: 100 }) },
  ]);
  same("coldest: longest loss run first, then larger units lost, then name; odds-0 left out of units; push skipped", line(await streakOf(S4.u, "coldest")), [
    "Cold six:6:-12", "Cold tie big:4:-12", "Cold tie small:4:-4", "Cold odds zero:4:-3", "Cold push:3:-3",
  ]);
  same("hottest: only the win streak shows in Hottest", line(await streakOf(S4.u, "hottest")), ["Hot one:3"]);
  same("coldest: page statement == dropdown fetch", (await getCappersPageData({ userId: S4.u, window: "ALL", min: 0, sort: "roi", fav: false, q: "", page: 1 })).coldest, await streakOf(S4.u, "coldest"));
  check("streak panels: scoped to the user", (await streakOf(S4.u, "coldest")).every((e) => e.capperId.startsWith(PREFIX + "user-streakcold-")));
  check("streak panels: a five-row response is small", JSON.stringify(await streakOf(S4.u, "coldest")).length < 2048);

  // ---- Redesign fields ---------------------------------------------------------------------------
  same("winners: the window's wins-losses ride on each row", gotH.map((e) => e.name + " " + e.wins + "-" + e.losses), ["Fav ignored 5-0", "Hot C 5-1", "Hot A 3-3", "Pushy 3-0", "Hot B 4-1"]);

  // 5. Most Active total + the stat cards' weekly series. Newest first: "A" 2-1 this week and 0-2 the
  // week before; "H" lost an hour ago after six straight wins 8 days back; six more cappers with one
  // pending pick each; a test account whose picks count nowhere.
  const S5 = await scenario("weekly", [
    { name: "A", specs: (c) => [...seq(c, [W, W, L], { odds: 100 }), ...seq(c, [L, L], { odds: 100, startMin: D8 })] },
    { name: "H", specs: (c) => [...seq(c, [L], { odds: 100 }), ...seq(c, [W, W, W, W, W, W], { odds: 100, startMin: D8 })] },
    ...["B", "C", "D", "E", "F", "G"].map((name) => ({ name, specs: (c: string) => seq(c, ["PENDING"], { odds: 100 }) })),
    { name: "Test account", specs: (c) => seq(c, [W, W, W, W, W, W, W], { odds: 100 }) },
  ]);
  await prisma.capper.update({ where: { id: S5.ids["Test account"] }, data: { isTest: true } });
  await prisma.capper.update({ where: { id: S5.ids.B }, data: { createdAt: new Date(Date.now() - 20 * 86400000) } });
  await prisma.capper.update({ where: { id: S5.ids.C }, data: { createdAt: new Date(Date.now() - 40 * 86400000) } });
  const pageS5 = await getCappersPageData({ userId: S5.u, window: "ALL", min: 0, sort: "roi", fav: false, q: "", page: 1 });
  const o5 = pageS5.overview;
  same("most active: five rows, each carrying the roster-wide total (test account left out)", pageS5.mostActive.map((e) => e.pickCount + "/" + e.totalPicks), ["3/10", "1/10", "1/10", "1/10", "1/10"]);
  same("most active: page statement == dropdown fetch (week)", pageS5.mostActive, (await getPanelRows({ userId: S5.u, panel: "active", window: "week" })) as ActiveEntry[]);
  check("weekly series: " + STAT_WEEKS + " points each", Object.values(o5.weekly).every((s) => s.length === STAT_WEEKS));
  same("weekly picks: posted per rolling week, oldest first", o5.weekly.picks, [0, 0, 0, 0, 0, 0, 8, 10]);
  check("weekly picks: the last two points are the Picks-this-week card's own numbers", o5.weekly.picks[7] === o5.picksThisWeek && o5.picksThisWeekPct === 25, o5.picksThisWeek + " " + o5.picksThisWeekPct);
  same("weekly active cappers", o5.weekly.active, [0, 0, 0, 0, 0, 0, 2, 8]);
  check("active cappers delta is week over week on the ALL tab too", o5.activeCappersDelta === 6, String(o5.activeCappersDelta));
  same("weekly tracked cappers: roster size at each week's end, by date added", o5.weekly.tracked, [0, 0, 1, 1, 1, 2, 2, 8]);
  check("tracked: last point == capper count; new this month excludes the one added 40 days ago", o5.weekly.tracked[7] === pageS5.capperCount && o5.newCappersThisMonth === 7, pageS5.capperCount + " " + o5.newCappersThisMonth);
  same("weekly ROI: pooled over the picks graded with a game that week", o5.weekly.roi, [0, 0, 0, 0, 0, 0, 50, 0]);
  same("weekly hot streaks: H was on six straight a week ago, and is not now", o5.weekly.hot, [0, 0, 0, 0, 0, 0, 1, 0]);
  check("weekly hot streaks: the last point agrees with the Hot-streaks card here", o5.weekly.hot[7] === o5.hotStreaks, String(o5.hotStreaks));
  const pageS5tab = await getCappersPageData({ userId: S5.u, window: "TODAY", min: 0, sort: "roi", fav: false, q: "", page: 1 });
  same("weekly series do not follow the time tab", pageS5tab.overview.weekly, o5.weekly);
  check("active cappers delta does not follow the time tab", pageS5tab.overview.activeCappersDelta === 6);

  // 6. Rising Fast points + results + baseline; Most Consistent deviation, confidence score and tier.
  const reps = (n: number, s: PickSpec["status"]) => Array.from({ length: n }, () => s);
  const block = (wins: number) => [...reps(wins, W), ...reps(10 - wins, L)];
  const S6 = await scenario("form", [
    // Recent 10: 8-2 (80%). Baseline 30: alternating W/L (50%). Score +30 points.
    { name: "Riser", specs: (c) => seq(c, [...reps(8, W), L, L, ...Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? W : L))], { odds: 100 }) },
    { name: "Flat", specs: (c) => seq(c, [...block(6), ...block(6), ...block(6), ...block(6), ...block(6)], { odds: 100 }) },
    { name: "Wavy", specs: (c) => seq(c, [...block(5), ...block(7), ...block(5), ...block(7), ...block(5)], { odds: 100 }) },
  ]);
  const pageS6 = await getCappersPageData({ userId: S6.u, window: "ALL", min: 0, sort: "roi", fav: false, q: "", page: 1 });
  same("rising: only the capper beating their baseline, with the score in points", pageS6.rising.map((e) => e.name + " +" + e.pts), ["Riser +30"]);
  same("rising: results = the last 10 decided picks, oldest first", pageS6.rising[0]?.results, [false, false, true, true, true, true, true, true, true, true]);
  same("rising: baseline = the win rate of the picks before those, as a fraction", pageS6.rising[0]?.baseline, 0.5);
  const lineS6 = risingSeries(pageS6.rising[0]?.results ?? [], pageS6.rising[0]?.baseline ?? 0);
  same("rising: chart line starts at 0 and adds (result - baseline) x 10 per pick", lineS6, [0, -5, -10, -5, 0, 5, 10, 15, 20, 25, 30]);
  check("rising: the line's last point is the displayed points", Math.round(lineS6[lineS6.length - 1]) === pageS6.rising[0]?.pts);
  same("rising: a baseline that is not a round fraction still ends on the score", Math.round(risingSeries([true, true, false, true, true, true, true, false, true, true], 0.51)[10]), 29);
  same("consistent: steadiest first, blocks oldest first", pageS6.consistent.map((e) => e.name + " " + e.blocks.join(",")), ["Flat 60,60,60,60,60", "Wavy 50,70,50,70,50"]);
  same("consistent: population standard deviation of the block win %s", pageS6.consistent.map((e) => e.sd), [0, Math.sqrt(96)]);
  same("consistent: confidence = clamp(round(100 - 2.5 * sd)) and its tier", pageS6.consistent.map((e) => consistencyScore(e.sd) + " " + consistencyTier(consistencyScore(e.sd))), ["100 Elite", "76 Steady"]);
  same("confidence: clamped to 0-100; tiers Elite >= 85, Rock Solid >= 80, Steady below", [consistencyScore(100), consistencyScore(0), consistencyScore(4), ...[85, 84, 80, 79].map(consistencyTier)], [0, 100, 90, "Elite", "Rock Solid", "Rock Solid", "Steady"]);

  console.log(`\n${assertions} assertions, ${failures} failed.`);
}

async function cleanup() {
  let deletedUsers = 0;
  for (const id of createdUserIds) deletedUsers += (await prisma.user.deleteMany({ where: { id } })).count;
  let deletedSports = 0;
  for (const id of createdSportIds) deletedSports += (await prisma.sport.deleteMany({ where: { id } })).count;
  console.log(`cleanup: deleted ${deletedUsers} user(s), ${deletedSports} sport(s).`);
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
