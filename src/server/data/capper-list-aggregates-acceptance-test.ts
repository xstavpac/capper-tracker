// Parity + behavior tests for the /cappers database-side aggregation
// (capper-list-aggregates.ts + pick-aggregates-cappers-adapter.ts): the new SQL
// path must return exactly what the original raw-pick JS path
// (cappers.ts's getCapperLeaderboardTable / getFavoriteCappersSummary /
// getSportCategoryPanelData / getMostActiveThisWeek) returned, for the same
// rows.
//
// DB-backed and WRITING: it creates its own users/cappers/picks (every id
// prefixed `__ParityCappersList__`) and deletes them by exact id at the end. For
// that reason it REFUSES to run unless DATABASE_URL points at a local database
// (localhost / 127.0.0.1) - `npm test` would otherwise pick up a .env pointing
// at a real database. Run against a disposable local Postgres with migrations
// applied:
//   DATABASE_URL=postgresql://postgres@localhost:54329/capper_parity \
//   DIRECT_URL=postgresql://postgres@localhost:54329/capper_parity \
//   npx tsx src/server/data/capper-list-aggregates-acceptance-test.ts
//
// Fixtures avoid gameTime/createdAt ties and window-edge picks except in the
// dedicated tests that assert them (the window-edge test pins an explicit `now`;
// the tie tests assert the createdAt, id tie-break rule, which the old path left
// undefined). Exits non-zero on any failed assertion.
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  computeStats,
  computeCategoryBreakdown,
  chipSetForLeague,
  pickCategory,
  recordStatsFromTotals,
  scorecardWindowRange,
  PICK_CATEGORY_VERSION,
  SCORECARD_WINDOWS,
  type ScorecardWindow,
} from "@/server/data/stats";
import * as legacy from "@/server/data/cappers";
// getSportCategoryPanelData moved out of cappers.ts (unused by any page since
// #128) into its own test-only reference file - see that file's header.
import * as legacyPanel from "@/server/data/sport-category-panel-legacy";
import * as adapter from "@/server/data/pick-aggregates-cappers-adapter";
import { queryWindowTotals, queryCurrentStreaks } from "@/server/data/capper-list-aggregates";
import { getCapperPickDataset } from "@/server/data/pick-aggregates";
import { createPicksWithEntitlementCheck } from "@/server/data/subscriptions";

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

// Deep equality that treats NaN as equal to NaN and distinguishes Infinity;
// returns the first differing path (or null).
function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b) ? null : `${path}: ${a} !== ${b}`;
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

const PREFIX = "__ParityCappersList__";
const T0 = Date.now();
// A point in time `minutes` (+30s) before T0. The 30s keeps every fixture pick
// far from any minute-aligned window boundary, so the old and new calls (which
// each take their own `now`) can't straddle one.
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
  if (existing) {
    sportIdByName.set(name, existing.id);
    return;
  }
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

async function makeCappers(userId: string, specs: { key: string; name: string; favorite?: boolean }[]) {
  const ids: Record<string, string> = {};
  for (const s of specs) {
    const id = `${PREFIX}${userId.slice(PREFIX.length)}-${s.key}`;
    await prisma.capper.create({ data: { id, userId, name: s.name, source: "OTHER", isFavorite: !!s.favorite } });
    ids[s.key] = id;
  }
  return ids;
}

type PickSpec = {
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
  datePosted?: Date;
  pickedSide?: "HOME" | "AWAY" | null;
  mlFavoredSide?: "HOME" | "AWAY" | null;
  propMarket?: Prisma.PickUncheckedCreateInput["propMarket"];
};

let pickSeq = 0;
function pickRow(userId: string, s: PickSpec): Prisma.PickCreateManyInput {
  pickSeq++;
  const sport = s.sport ?? "MLB";
  const betType = s.betType ?? "MONEYLINE";
  const period = s.period ?? "FULL_GAME";
  const odds = s.odds ?? -110;
  const line = s.line ?? null;
  const status = s.status ?? "WIN";
  const betDetail = s.betDetail ?? null;
  const category = pickCategory({
    betType,
    period,
    betDetail,
    odds,
    line,
    sportName: sport,
    pickedSide: s.pickedSide ?? null,
    mlFavoredSide: s.mlFavoredSide ?? null,
    propMarket: s.propMarket ?? null,
  });
  const decidedOrCancelled = status !== "PENDING";
  return {
    id: `${PREFIX}pick-${pickSeq}`,
    userId,
    capperId: s.capperId,
    sportId: sportIdByName.get(sport)!,
    homeTeam: "Home",
    awayTeam: "Away",
    betType,
    betDetail,
    odds,
    line,
    period,
    units: s.units ?? 1,
    datePosted: s.datePosted ?? s.gameTime,
    gameTime: s.gameTime,
    status,
    gradedAt: s.gradedAt === "auto" || s.gradedAt === undefined ? (decidedOrCancelled ? new Date(s.gameTime.getTime() + 3 * 3600000) : null) : s.gradedAt,
    createdAt: s.createdAt ?? new Date(T0 - pickSeq * 1000),
    pickedSide: s.pickedSide ?? null,
    mlFavoredSide: s.mlFavoredSide ?? null,
    propMarket: s.propMarket ?? null,
    category,
    categoryVersion: PICK_CATEGORY_VERSION,
  };
}
async function addPicks(userId: string, specs: PickSpec[]) {
  await prisma.pick.createMany({ data: specs.map((s) => pickRow(userId, s)) });
}

const stripLongest = <T extends { stats: Record<string, unknown> }>(e: T) => {
  const { longestWinStreak: _w, longestLossStreak: _l, ...stats } = e.stats;
  return { ...e, stats };
};
const stripEntries = (entries: { stats: Record<string, unknown> }[]) => entries.map(stripLongest);
const stripCollective = (s: { collectiveStats: Record<string, unknown>; entries: { stats: Record<string, unknown> }[] } | null) => {
  if (!s) return null;
  // currentStreak on the pooled object is documented as meaningless and unread
  // (a fixed placeholder on the new path), and longest* aren't part of the new type.
  const { currentStreak: _c, longestWinStreak: _w, longestLossStreak: _l, ...collectiveStats } = s.collectiveStats;
  return { collectiveStats, entries: stripEntries(s.entries) };
};

// The raw-pick reference for the category panel: the original per-pick JS computation
// (computeCategoryBreakdown / pickCategory / computeStats over the user's picks), with
// the picks ordered by createdAt, id (getCapperPickDataset) so ties follow the D2 rule.
// Production no longer has this path - the panel reads the stored category in SQL - so
// this is what the SQL result is compared to wherever ties make the original
// cappers.ts implementation (unspecified order) an unreliable comparator.
async function referencePanel(userId: string, sportName: string): Promise<legacyPanel.SportCategoryPanelData> {
  const [dataset, roster] = await Promise.all([getCapperPickDataset(userId, { sportName }), legacy.getCappersForUser(userId)]);
  const nameByCapperId = new Map(roster.map((c) => [c.id, c.name]));
  const breakdown = computeCategoryBreakdown(dataset.all, chipSetForLeague(sportName));
  const leaderboards: legacyPanel.SportCategoryPanelData["leaderboards"] = {};
  for (const item of breakdown) {
    const scoped = dataset.all.filter((p) => pickCategory({ ...p, sportName }) === item.key);
    const byCapper = new Map<string, typeof scoped>();
    for (const pick of scoped) {
      const list = byCapper.get(pick.capperId);
      if (list) list.push(pick);
      else byCapper.set(pick.capperId, [pick]);
    }
    leaderboards[item.key] = Array.from(byCapper.entries())
      .map(([capperId, picks]) => {
        const s = computeStats(picks);
        return { capperId, name: nameByCapperId.get(capperId) ?? "Unknown capper", wins: s.wins, losses: s.losses, pushes: s.pushes, winPct: s.winPct };
      })
      .filter((e) => e.wins + e.losses + e.pushes >= 3)
      .sort((a, b) => b.winPct - a.winPct)
      .slice(0, 5);
  }
  return { breakdown, leaderboards };
}

// ---- main -------------------------------------------------------------------

async function buildMainFixture(userId: string) {
  const cappers = await makeCappers(userId, [
    { key: "A", name: "Alpha", favorite: true },
    { key: "B", name: "Bravo" },
    { key: "C", name: "Charlie", favorite: true },
    { key: "D", name: "Delta (no picks)" },
    { key: "E", name: "Echo (cancelled only)" },
    { key: "F", name: "Foxtrot (old NFL only)" },
    { key: "G", name: "Golf (streak shape)" },
    { key: "H", name: "Hotel (specialist)" },
    { key: "Y", name: "Yankee (zero-odds zero-units)" },
    { key: "Z", name: "Zulu (zero-odds win)" },
  ]);

  const rand = rng(20260928);
  const oddsChoices = [-250, -150, -120, -110, -105, 100, 110, 130, 170, 220];
  const unitChoices = [0.5, 1, 1, 1.5, 2, 3];
  type Tpl = Omit<PickSpec, "capperId" | "gameTime">;
  const templates: Tpl[] = [
    { betType: "MONEYLINE" },
    { betType: "MONEYLINE" },
    { betType: "MONEYLINE", period: "FIRST_HALF" },
    { betType: "MONEYLINE", pickedSide: "AWAY", mlFavoredSide: "HOME", odds: -104 },
    { betType: "SPREAD", line: -1.5 },
    { betType: "SPREAD", line: 3.5 },
    { betType: "SPREAD", line: null },
    { betType: "SPREAD", period: "FIRST_HALF", line: -0.5 },
    { betType: "TOTAL", betDetail: "Over 8.5" },
    { betType: "TOTAL", betDetail: "Under 9" },
    { betType: "TOTAL", betDetail: "8.5" },
    { betType: "NRFI", betDetail: "NRFI Under 0.5 1st inning" },
    { betType: "NRFI", betDetail: "YRFI Over 0.5 1st inning" },
    { betType: "TEAM_TOTAL", betDetail: "Home over 4.5" },
    { betType: "MONEYLINE", sport: "NFL" },
    { betType: "SPREAD", sport: "NFL", line: -3 },
    { betType: "SPREAD", sport: "NFL", line: 6.5 },
    { betType: "TOTAL", sport: "NFL", betDetail: "Under 44.5" },
    { betType: "TOTAL", sport: "NFL", period: "FIRST_QUARTER", betDetail: "Q1 Over 9.5" },
    { betType: "PLAYER_PROP", sport: "NFL", propMarket: "TD", betDetail: "Puka Nacua Anytime TD" },
  ];
  const cap = (k: string) => cappers[k];
  // Weighted roster for the random picks (not D/E/F/G/H/Y/Z - those are hand-built).
  const pool = ["A", "A", "A", "B", "B", "C", "C", "C"];

  const specs: PickSpec[] = [];
  for (let i = 0; i < 380; i++) {
    const tpl = templates[Math.floor(rand() * templates.length)];
    const r = rand();
    const status = r < 0.42 ? "WIN" : r < 0.8 ? "LOSS" : r < 0.85 ? "PUSH" : r < 0.93 ? "PENDING" : "CANCELLED";
    const minutesAgo = Math.round(i * 300 + rand() * 200);
    const future = status === "PENDING" && rand() < 0.5;
    specs.push({
      capperId: cap(pool[Math.floor(rand() * pool.length)]),
      ...tpl,
      odds: tpl.odds ?? oddsChoices[Math.floor(rand() * oddsChoices.length)],
      units: unitChoices[Math.floor(rand() * unitChoices.length)],
      status,
      gameTime: future ? ago(-(60 + Math.round(rand() * 3000))) : ago(minutesAgo + 1),
      // ~3% of decided picks lack gradedAt (in ALL, never in a windowed slice).
      gradedAt: (status === "WIN" || status === "LOSS") && rand() < 0.03 ? null : "auto",
      // CANCELLED: half carry a gradedAt (updatePickStatus sets one on any exit from PENDING).
      ...(status === "CANCELLED" ? { gradedAt: rand() < 0.5 ? "auto" : null } : {}),
      createdAt: new Date(T0 - i * 1000 - Math.floor(rand() * 500)),
      datePosted: ago(Math.round(rand() * 12 * DAY) + 1),
    });
  }

  // Echo: only CANCELLED picks. Ones WITH gradedAt in the last 7 days count as
  // "having a pick" in LAST_7 on the old path (quirk preserved, asserted below).
  specs.push(
    { capperId: cap("E"), status: "CANCELLED", gameTime: ago(2 * DAY + 5), gradedAt: "auto" },
    { capperId: cap("E"), status: "CANCELLED", gameTime: ago(40 * DAY + 5), gradedAt: null }
  );
  // Foxtrot: NFL picks only, all older than 60 days.
  for (let i = 0; i < 6; i++) {
    specs.push({ capperId: cap("F"), sport: "NFL", betType: "SPREAD", line: -2.5, status: i % 2 ? "LOSS" : "WIN", gameTime: ago(62 * DAY + i * 500 + 7) });
  }
  // Golf: WIN run that a 7-day cutoff truncates. ALL tail = 6 wins (incl. a WIN
  // with no gradedAt, which only ALL sees); LAST_7 tail = 2.
  specs.push(
    { capperId: cap("G"), status: "LOSS", gameTime: ago(20 * DAY + 5) },
    { capperId: cap("G"), status: "WIN", gameTime: ago(10 * DAY + 5) },
    { capperId: cap("G"), status: "WIN", gameTime: ago(9 * DAY + 5) },
    { capperId: cap("G"), status: "WIN", gameTime: ago(8 * DAY + 5) },
    { capperId: cap("G"), status: "WIN", gameTime: ago(6 * DAY + 5) },
    { capperId: cap("G"), status: "WIN", gameTime: ago(5 * DAY + 5) },
    { capperId: cap("G"), status: "PUSH", gameTime: ago(4 * DAY + 5) },
    { capperId: cap("G"), status: "WIN", gameTime: ago(1 * DAY + 5), gradedAt: null }
  );
  // Hotel: 8 FAV_ML wins and 2 losses out of 12 decided -> specialist candidate.
  for (let i = 0; i < 12; i++) {
    specs.push({ capperId: cap("H"), betType: "MONEYLINE", odds: -140, status: i < 8 ? "WIN" : i < 10 ? "LOSS" : "PUSH", gameTime: ago(i * 400 + 11) });
  }
  specs.push({ capperId: cap("H"), betType: "TOTAL", betDetail: "Over 8", status: "LOSS", gameTime: ago(6000 + 11) });
  // Zero-odds wins (open product question - the quirk is preserved, not fixed).
  specs.push(
    { capperId: cap("Z"), status: "WIN", odds: 0, units: 1, gameTime: ago(3 * DAY + 9) },
    { capperId: cap("Z"), status: "WIN", odds: -110, units: 2, gameTime: ago(3 * DAY + 90) },
    { capperId: cap("Z"), status: "LOSS", units: 1, gameTime: ago(2 * DAY + 9) },
    { capperId: cap("Y"), status: "WIN", odds: 0, units: 0, gameTime: ago(2 * DAY + 19) }
  );

  await addPicks(userId, specs);
  return cappers;
}

async function main() {
  const before = { users: await prisma.user.count(), picks: await prisma.pick.count(), sports: await prisma.sport.count() };
  console.log(`DB before: users=${before.users} picks=${before.picks} sports=${before.sports}\n`);
  await ensureSport("MLB");
  await ensureSport("NFL");
  await ensureSport("NBA");

  // ---------------- Main parity fixture ----------------
  const U1 = await makeUser("main");
  const c1 = await buildMainFixture(U1);
  const nMain = await prisma.pick.count({ where: { userId: U1 } });
  console.log(`main fixture: ${nMain} picks, ${Object.keys(c1).length} cappers\n`);

  // Leaderboard, every window, all leagues + MLB pill + NFL pill.
  for (const filter of [undefined, { sportName: "MLB" }, { sportName: "NFL" }, { sportName: "NBA" }]) {
    const label = filter ? filter.sportName! : "all leagues";
    const batched = await adapter.getCapperLeaderboardTablesByWindow(U1, filter);
    for (const w of SCORECARD_WINDOWS) {
      const old = await legacy.getCapperLeaderboardTable(U1, w, filter);
      same(`leaderboard parity [${label}] ${w} (${old.length} rows)`, batched[w], stripEntries(old));
    }
    const single = await adapter.getCapperLeaderboardTable(U1, "LAST_30", filter);
    same(`per-window wrapper == batched [${label}] LAST_30`, single, batched.LAST_30);
  }

  // Quirks preserved: a CANCELLED pick with gradedAt counts as "having a pick" in the window;
  // a WIN at odds = 0 makes unitsWon/ROI Infinity/NaN on the old path.
  const all = await adapter.getCapperLeaderboardTablesByWindow(U1);
  const has = (w: ScorecardWindow, key: string) => all[w].some((e) => e.capperId === c1[key]);
  check("quirk: cancelled-only capper listed in LAST_7 (CANCELLED with gradedAt counts)", has("LAST_7", "E") === true);
  check("quirk: ...but not in TODAY", has("TODAY", "E") === false);
  check("zero-pick capper present in ALL, absent from LAST_7", has("ALL", "D") && !has("LAST_7", "D"));
  const zulu = all.ALL.find((e) => e.capperId === c1.Z)!;
  const yank = all.ALL.find((e) => e.capperId === c1.Y)!;
  check("quirk: WIN at odds 0 -> unitsWon Infinity", zulu.stats.unitsWon === Infinity, `got ${zulu.stats.unitsWon}`);
  check("quirk: WIN at odds 0 with 0 units -> unitsWon NaN", Number.isNaN(yank.stats.unitsWon), `got ${yank.stats.unitsWon}`);

  // Streak semantics per window (tail run truncated by the window; ungraded W/L only in ALL).
  const golf = (w: ScorecardWindow) => all[w].find((e) => e.capperId === c1.G)?.stats.currentStreak;
  same("streak Golf ALL (6 wins incl. one with no gradedAt)", golf("ALL"), { type: "WIN", count: 6 });
  same("streak Golf LAST_7 (cutoff truncates the run)", golf("LAST_7"), { type: "WIN", count: 2 });
  same("streak Golf LAST_30", golf("LAST_30"), { type: "WIN", count: 5 });

  // Specialist: Hotel is 8-2-2 FAV_ML of 13 decided.
  check("specialist tag present for Hotel (ALL)", all.ALL.find((e) => e.capperId === c1.H)?.specialist?.category === "FAV_ML");

  // Favorites: with and without handing over the unscoped leaderboard; plus per-window wrapper.
  const favBatched = await adapter.getFavoriteCappersSummariesByWindow(U1);
  const favReuse = await adapter.getFavoriteCappersSummariesByWindow(U1, all);
  for (const w of SCORECARD_WINDOWS) {
    const old = await legacy.getFavoriteCappersSummary(U1, w);
    same(`favorites parity ${w}`, stripCollective(favBatched![w] as never), stripCollective(old as never));
    same(`favorites (reusing leaderboard) parity ${w}`, stripCollective(favReuse![w] as never), stripCollective(old as never));
  }
  same("favorites per-window wrapper == batched (TODAY)", await adapter.getFavoriteCappersSummary(U1, "TODAY"), favBatched!.TODAY);
  same("favorites: collective currentStreak is the documented placeholder", favBatched!.ALL.collectiveStats.currentStreak, { type: "NONE", count: 0 });

  // Category panel vs the original (ties in this random fixture are compared against referencePanel, a
  // raw-pick reference that implements the createdAt,id rule; the tie-free fixtures below are compared to the original).
  for (const sport of ["MLB", "NFL", "NBA"]) {
    const viaSql = await adapter.getSportCategoryPanelData(U1, sport);
    same(`category panel [${sport}] == ordered raw-pick path`, viaSql, await referencePanel(U1, sport));
    const orig = await legacyPanel.getSportCategoryPanelData(U1, sport);
    same(`category panel [${sport}] breakdown == original cappers.ts`, viaSql.breakdown, orig.breakdown);
  }

  // Most active this week.
  for (const filter of [undefined, { sportName: "MLB" }, { sportName: "NFL" }]) {
    same(`most active parity [${filter?.sportName ?? "all"}]`, await adapter.getMostActiveThisWeek(U1, filter), await legacy.getMostActiveThisWeek(U1, filter));
  }

  // The ordered raw-pick fallback (also the path for filter.category / unstamped users) agrees with the SQL path.
  for (const w of ["ALL", "LAST_30"] as const) {
    same(`ordered raw-pick leaderboard fallback == SQL path (${w})`, stripEntries(await adapter.legacyCapperLeaderboardTable(U1, w)), all[w]);
  }

  // ---------------- Window-edge test with an explicit `now` ----------------
  const U2 = await makeUser("edges");
  const c2 = await makeCappers(U2, [{ key: "E", name: "Edge" }]);
  const now = new Date("2026-07-15T16:30:00.000Z"); // a summer instant: Eastern is EDT (UTC-4)
  const edgeSpecs: PickSpec[] = [];
  let k = 0;
  for (const w of ["TODAY", "YESTERDAY", "LAST_7", "LAST_30", "LAST_60"] as const) {
    const range = scorecardWindowRange(w, now)!;
    for (const t of [range.start.getTime() - 1, range.start.getTime(), range.end.getTime() - 1, range.end.getTime(), range.end.getTime() + 1]) {
      k++;
      edgeSpecs.push({ capperId: c2.E, status: k % 3 === 0 ? "LOSS" : "WIN", units: 0.1 * k, gameTime: new Date(t), gradedAt: "auto" });
    }
    // Right at the start but never graded: excluded from every windowed slice.
    edgeSpecs.push({ capperId: c2.E, status: "WIN", units: 0.05, gameTime: range.start, gradedAt: null });
  }
  await addPicks(U2, edgeSpecs);
  // Edge picks deliberately share gameTimes (window ends coincide with the next window's start), so the
  // JS reference needs the createdAt, id order the SQL path uses (the old path left it undefined).
  const edgePicks = (await prisma.pick.findMany({ where: { userId: U2 } })).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const edgeTotals = await queryWindowTotals({ userId: U2, now });
  const edgeStreaks = await queryCurrentStreaks({ userId: U2, now });
  for (const w of SCORECARD_WINDOWS) {
    const range = scorecardWindowRange(w, now);
    const slice = range ? edgePicks.filter((p) => p.gradedAt && p.gameTime >= range.start && p.gameTime < range.end) : edgePicks;
    const expected = computeStats(slice);
    const row = edgeTotals.find((r) => r.window === w);
    const got = recordStatsFromTotals({
      wins: row?.wins ?? 0,
      losses: row?.losses ?? 0,
      pushes: row?.pushes ?? 0,
      unitsWon: row?.unitsWon ?? 0,
      unitsLost: row?.unitsLost ?? 0,
      unitsRisked: row?.unitsRisked ?? 0,
    });
    const { currentStreak: _cs, longestWinStreak: _lw, longestLossStreak: _ll, ...expRecord } = expected;
    same(`window edges (start-1ms/start/end-1ms/end/end+1ms) ${w}: stats`, got, expRecord);
    check(`window edges ${w}: pick count`, (row?.nPicks ?? 0) === slice.length, `sql ${row?.nPicks} vs js ${slice.length}`);
    const streak = edgeStreaks.find((r) => r.window === w);
    same(`window edges ${w}: streak`, streak ? { type: streak.type, count: streak.count } : { type: "NONE", count: 0 }, expected.currentStreak);
  }

  // ---------------- Tie-free category panel vs the ORIGINAL implementation ----------------
  const U3 = await makeUser("panel");
  const c3 = await makeCappers(U3, [
    { key: "P", name: "Pat" }, { key: "Q", name: "Quinn" }, { key: "R", name: "Rae" }, { key: "S", name: "Sam" },
    { key: "T", name: "Tess" }, { key: "U", name: "Uma" }, { key: "V", name: "Val" },
  ]);
  const record = (key: string, w: number, l: number, extra: Partial<PickSpec> = {}, startMin = 0) => {
    const out: PickSpec[] = [];
    for (let i = 0; i < w + l; i++) out.push({ capperId: c3[key], status: i < w ? "WIN" : "LOSS", gameTime: ago(startMin + 100 + i * 61), ...extra });
    return out;
  };
  let off = 0;
  const panelSpecs: PickSpec[] = [];
  const add = (key: string, w: number, l: number, extra: Partial<PickSpec> = {}) => {
    panelSpecs.push(...record(key, w, l, extra, off));
    off += (w + l) * 61 + 500;
  };
  // FAV_ML win% (all distinct): V 90, Q 83.3, P 75, U 70, R 50, S 25 (T is 2-0: under the 3-decided floor).
  add("V", 9, 1, { odds: -140 }); add("Q", 5, 1, { odds: -140 }); add("P", 6, 2, { odds: -140 });
  add("U", 7, 3, { odds: -140 }); add("R", 3, 3, { odds: -140 }); add("S", 1, 3, { odds: -140 }); add("T", 2, 0, { odds: -140 });
  // DOG_ML, OVER, and a category that only has pending picks (must not appear), a null-category total, NFL noise.
  add("P", 2, 1, { odds: 150 }); add("Q", 1, 2, { odds: 150 });
  add("R", 4, 0, { betType: "TOTAL", betDetail: "Over 8" }); add("S", 3, 1, { betType: "TOTAL", betDetail: "Over 8" });
  panelSpecs.push({ capperId: c3.T, status: "PENDING", betType: "TOTAL", betDetail: "Under 9", gameTime: ago(-300) });
  add("U", 2, 2, { betType: "TOTAL", betDetail: "8.5" });
  add("V", 6, 2, { sport: "NFL", odds: -140 });
  await addPicks(U3, panelSpecs);
  const panelNew = await adapter.getSportCategoryPanelData(U3, "MLB");
  const panelOld = await legacyPanel.getSportCategoryPanelData(U3, "MLB");
  same("tie-free category panel [MLB] == original cappers.ts (breakdown + leaderboards)", panelNew, panelOld);
  check("panel: FAV_ML leaderboard capped at 5 and led by Val (90%)", (panelNew.leaderboards.FAV_ML ?? []).length === 5 && panelNew.leaderboards.FAV_ML![0].name === "Val");
  check("panel: pending-only UNDER category absent from breakdown", !panelNew.breakdown.some((b) => b.key === "UNDER"));
  same("tie-free specialist/leaderboard [ALL] == original", stripEntries(await adapter.getCapperLeaderboardTable(U3, "ALL")), stripEntries(await legacy.getCapperLeaderboardTable(U3, "ALL")));

  // ---------------- Specialist threshold edges vs the ORIGINAL implementation ----------------
  // Fixtures here have no exact ties, so old-vs-new equality is exact. Each capper sits on one side of
  // one edge of the specialist rule: >=50% of decided volume, >=5 decided in the category, category win%
  // >= overall win%. (FAV_ML = MONEYLINE at -140, DOG_ML = MONEYLINE at +150, null category = TOTAL "8.5".)
  const U7 = await makeUser("specialist");
  const c7 = await makeCappers(U7, [
    { key: "S1", name: "S1 exactly 50% share", favorite: true },
    { key: "S2", name: "S2 just under 50%" },
    { key: "S3", name: "S3 only 4 in category" },
    { key: "S4", name: "S4 win% below overall" },
    { key: "S5", name: "S5 win% equals overall, null-category denominator" },
    { key: "S6", name: "S6 pushes count toward share" },
    { key: "S7", name: "S7 pending and cancelled ignored" },
    { key: "S8", name: "S8 spans two sports", favorite: true },
  ]);
  let m7 = 0;
  const rec7: PickSpec[] = [];
  const put = (key: string, status: PickSpec["status"], extra: Partial<PickSpec>) => {
    m7++;
    rec7.push({ capperId: c7[key], status, gameTime: ago(m7 * 130 + 20), createdAt: new Date(T0 - m7 * 1000), ...extra });
  };
  const FAV = { betType: "MONEYLINE" as const, odds: -140 };
  const DOG = { betType: "MONEYLINE" as const, odds: 150 };
  const NULLCAT = { betType: "TOTAL" as const, betDetail: "8.5" };
  for (let i = 0; i < 5; i++) put("S1", "WIN", FAV), put("S1", "LOSS", DOG); // FAV 5/10 = exactly 0.5, 100% vs overall 50%
  for (let i = 0; i < 5; i++) put("S2", "WIN", FAV);
  for (let i = 0; i < 6; i++) put("S2", "LOSS", DOG); // FAV 5/11 < 0.5
  for (let i = 0; i < 4; i++) put("S3", "WIN", FAV); // share 1.0 but n = 4 < 5
  for (let i = 0; i < 2; i++) put("S4", "WIN", FAV);
  for (let i = 0; i < 4; i++) put("S4", "LOSS", FAV);
  for (let i = 0; i < 4; i++) put("S4", "WIN", DOG); // FAV 2-4 (33%) < overall 6-4 (60%)
  for (let i = 0; i < 3; i++) put("S5", "WIN", FAV), put("S5", "LOSS", FAV); // FAV 3-3 (50%)
  for (let i = 0; i < 2; i++) put("S5", "WIN", NULLCAT), put("S5", "LOSS", NULLCAT); // overall 5-5 (50%); 6/10 share
  for (let i = 0; i < 4; i++) put("S6", "WIN", FAV);
  put("S6", "PUSH", FAV);
  for (let i = 0; i < 4; i++) put("S6", "LOSS", DOG); // FAV 4W+1P of 9 decided
  for (let i = 0; i < 5; i++) put("S7", "WIN", FAV);
  for (let i = 0; i < 12; i++) put("S7", i % 2 ? "PENDING" : "CANCELLED", DOG);
  for (let i = 0; i < 3; i++) put("S8", "WIN", { ...FAV, sport: "MLB" }), put("S8", "WIN", { ...FAV, sport: "NFL" });
  await addPicks(U7, rec7);
  const tags = (entries: { capperId: string; specialist: { category: string } | null }[]) =>
    Object.fromEntries(Object.entries(c7).map(([k, id]) => [k, entries.find((e) => e.capperId === id)?.specialist?.category ?? null]));
  for (const filter of [undefined, { sportName: "MLB" }, { sportName: "NFL" }]) {
    const label = filter?.sportName ?? "all leagues";
    const neu = await adapter.getCapperLeaderboardTable(U7, "ALL", filter);
    same(`specialist edges [${label}]: leaderboard == original`, neu, stripEntries(await legacy.getCapperLeaderboardTable(U7, "ALL", filter)));
    if (!filter) {
      same("specialist edges: expected tag per capper (non-vacuous)", tags(neu), {
        S1: "FAV_ML", S2: null, S3: null, S4: null, S5: "FAV_ML", S6: "FAV_ML", S7: "FAV_ML", S8: "FAV_ML",
      });
    }
    if (filter?.sportName === "MLB") same("specialist edges [MLB]: S8 has only 3 FAV_ML in MLB, so no tag", tags(neu).S8, null);
  }
  const fav7 = await adapter.getFavoriteCappersSummariesByWindow(U7);
  for (const w of ["ALL", "LAST_30"] as const) {
    same(`specialist edges: favorites (${w}) == original`, stripCollective(fav7![w] as never), stripCollective((await legacy.getFavoriteCappersSummary(U7, w)) as never));
  }

  // ---------------- Category leaderboard edges vs the ORIGINAL implementation ----------------
  // >=3 decided minimum (pushes count), top-5 selection, an under-minimum 100% capper must not displace
  // an eligible one, a category whose cappers are all under the minimum (empty leaderboard, still a tile).
  const U8 = await makeUser("panel-edges");
  const c8 = await makeCappers(U8, "abcdefghijk".split("").map((k) => ({ key: k, name: "Cap " + k })));
  let m8 = 0;
  const rec8: PickSpec[] = [];
  const put8 = (key: string, w: number, l: number, p: number, extra: Partial<PickSpec>) => {
    for (const [n, status] of [[w, "WIN"], [l, "LOSS"], [p, "PUSH"]] as const) {
      for (let i = 0; i < n; i++) {
        m8++;
        rec8.push({ capperId: c8[key], status, gameTime: ago(m8 * 90 + 30), createdAt: new Date(T0 - m8 * 1000), ...extra });
      }
    }
  };
  // FAV_ML: distinct win% (a 100, b 90, c 80, d 70, e 66.7 with exactly 3 decided, f 50 with 3 decided incl. a push,
  // g 100% but only 2 decided -> excluded, h 1-0 -> excluded). Eligible: a-f (6) -> top 5 = a..e; f cut.
  put8("a", 10, 0, 0, FAV); put8("b", 9, 1, 0, FAV); put8("c", 8, 2, 0, FAV); put8("d", 7, 3, 0, FAV);
  put8("e", 2, 1, 0, FAV); put8("f", 1, 1, 1, FAV); put8("g", 2, 0, 0, FAV); put8("h", 1, 0, 0, FAV);
  // DOG_ML: everyone under the minimum -> the tile exists (count > 0) with an empty leaderboard.
  put8("a", 1, 0, 0, DOG); put8("b", 1, 1, 0, DOG); put8("c", 0, 2, 0, DOG);
  // OVER: only 4 eligible cappers (< 5): all listed; i is 100% but 2 decided.
  put8("d", 5, 0, 0, { betType: "TOTAL", betDetail: "Over 8" }); put8("e", 4, 1, 0, { betType: "TOTAL", betDetail: "Over 8" });
  put8("f", 3, 1, 0, { betType: "TOTAL", betDetail: "Over 8" }); put8("g", 2, 2, 0, { betType: "TOTAL", betDetail: "Over 8" });
  put8("i", 2, 0, 0, { betType: "TOTAL", betDetail: "Over 8" });
  await addPicks(U8, rec8);
  const panel8 = await adapter.getSportCategoryPanelData(U8, "MLB");
  same("panel edges: == original cappers.ts (breakdown + leaderboards)", panel8, await legacyPanel.getSportCategoryPanelData(U8, "MLB"));
  same("panel edges: FAV_ML top 5 is a..e (f cut by top-5; g/h under the 3-decided minimum)", panel8.leaderboards.FAV_ML!.map((e) => e.name), ["Cap a", "Cap b", "Cap c", "Cap d", "Cap e"]);
  same("panel edges: DOG_ML tile exists with an empty leaderboard", [panel8.breakdown.some((b) => b.key === "DOG_ML"), panel8.leaderboards.DOG_ML], [true, []]);
  same("panel edges: OVER lists its 4 eligible cappers (i has only 2 decided)", panel8.leaderboards.OVER!.map((e) => e.name), ["Cap d", "Cap e", "Cap f", "Cap g"]);

  // Tied cut at rank 5: six cappers all 3-0 in one category -> the five whose first pick was created earliest.
  const U9 = await makeUser("panel-tie-cut");
  const c9 = await makeCappers(U9, "123456".split("").map((k) => ({ key: k, name: "Tie " + k })));
  const rec9: PickSpec[] = [];
  let m9 = 0;
  for (const [order, key] of ["4", "2", "6", "1", "5", "3"].entries()) {
    for (let i = 0; i < 3; i++) {
      m9++;
      // capper key's picks are created in the order given (4 first ... 3 last), interleaved gameTimes
      rec9.push({ capperId: c9[key], status: "WIN", ...FAV, gameTime: ago(m9 * 100 + 40), createdAt: new Date(T0 - 1000000 + order * 10000 + i * 100) });
    }
  }
  await addPicks(U9, rec9);
  const panel9 = await adapter.getSportCategoryPanelData(U9, "MLB");
  same("tied cut: five earliest-first-pick cappers, in that order", panel9.leaderboards.FAV_ML!.map((e) => e.name), ["Tie 4", "Tie 2", "Tie 6", "Tie 1", "Tie 5"]);
  same("tied cut: == ordered raw-pick path", panel9, await referencePanel(U9, "MLB"));

  // ---------------- The stored category is authoritative (no raw-pick fallback) ----------------
  // Specialist tags and the panel read Pick.category. Restamping the column changes the result,
  // proving nothing recomputes the category from the pick's fields behind it.
  const U4 = await makeUser("stored");
  const c4 = await makeCappers(U4, [{ key: "W", name: "Whiskey" }]);
  const storedSpecs: PickSpec[] = [];
  for (let i = 0; i < 6; i++) storedSpecs.push({ capperId: c4.W, status: "WIN", ...FAV, gameTime: ago(i * 700 + 15) }); // stamped FAV_ML
  await addPicks(U4, storedSpecs);
  const tag4 = async () => (await adapter.getCapperLeaderboardTable(U4, "ALL")).find((e) => e.capperId === c4.W)!.specialist?.category ?? null;
  same("stored category: specialist reads FAV_ML as stamped", await tag4(), "FAV_ML");
  await prisma.pick.updateMany({ where: { userId: U4 }, data: { category: "DOG_ML" } }); // pick fields still say favorite
  same("stored category: restamped to DOG_ML -> specialist follows the stored value", await tag4(), "DOG_ML");
  const panel4 = await adapter.getSportCategoryPanelData(U4, "MLB");
  same("stored category: panel follows the stored value too", [panel4.breakdown.map((b) => b.key), panel4.leaderboards.FAV_ML], [["DOG_ML"], undefined]);

  // ---------------- D2 tie-break tests: createdAt, id ----------------
  const U5 = await makeUser("ties");
  const c5 = await makeCappers(U5, [
    { key: "S1", name: "Streak tie" },
    { key: "L1", name: "Leader one" }, { key: "L2", name: "Leader two" },
    { key: "SP", name: "Specialist tie" },
  ]);
  const sameTime = ago(3 * DAY + 3);
  const streakWinFirst = [
    { capperId: c5.S1, status: "WIN" as const, gameTime: sameTime, createdAt: new Date(T0 - 5000) },
    { capperId: c5.S1, status: "LOSS" as const, gameTime: sameTime, createdAt: new Date(T0 - 4000) },
  ];
  await addPicks(U5, streakWinFirst);
  let lb = await adapter.getCapperLeaderboardTable(U5, "ALL");
  same("tie: equal gameTime, WIN created first -> LOSS is the latest (streak LOSS 1)", lb.find((e) => e.capperId === c5.S1)!.stats.currentStreak, { type: "LOSS", count: 1 });
  same("tie: streak agrees with the ordered raw-pick path", (await adapter.legacyCapperLeaderboardTable(U5, "ALL")).find((e) => e.capperId === c5.S1)!.stats.currentStreak, { type: "LOSS", count: 1 });
  await prisma.pick.update({ where: { id: `${PREFIX}pick-${pickSeq - 1}` }, data: { createdAt: new Date(T0 - 3000) } }); // WIN now created last
  lb = await adapter.getCapperLeaderboardTable(U5, "ALL");
  same("tie: swap createdAt -> WIN is now the latest (streak WIN 1)", lb.find((e) => e.capperId === c5.S1)!.stats.currentStreak, { type: "WIN", count: 1 });

  // Category-leaderboard tie: both 3-0 FAV_ML in MLB. L1's first pick is created earlier.
  const tieBase = (key: string, i: number, createdMs: number): PickSpec => ({ capperId: c5[key], status: "WIN", odds: -140, gameTime: ago(1000 + i * 90 + (key === "L1" ? 0 : 5)), createdAt: new Date(T0 - createdMs) });
  await addPicks(U5, [tieBase("L1", 0, 90000), tieBase("L1", 1, 80000), tieBase("L1", 2, 70000), tieBase("L2", 0, 60000), tieBase("L2", 1, 50000), tieBase("L2", 2, 40000)]);
  let panel = await adapter.getSportCategoryPanelData(U5, "MLB");
  same("tie: 100% win% tie -> earlier first pick (Leader one) ranks first", panel.leaderboards.FAV_ML!.map((e) => e.name), ["Leader one", "Leader two"]);
  same("tie: leaderboard order agrees with the ordered raw-pick path", panel, await referencePanel(U5, "MLB"));
  await prisma.pick.updateMany({ where: { userId: U5, capperId: c5.L2, category: "FAV_ML" }, data: { createdAt: new Date(T0 - 999000) } });
  panel = await adapter.getSportCategoryPanelData(U5, "MLB");
  same("tie: make Leader two's picks older -> they rank first", panel.leaderboards.FAV_ML!.map((e) => e.name), ["Leader two", "Leader one"]);
  same("tie: swapped order agrees with the ordered raw-pick path", panel, await referencePanel(U5, "MLB"));

  // Specialist exact-50% tie: 5 FAV_ML wins and 5 DOG_ML wins; the category whose first decided pick is earlier wins.
  const spec = (i: number, odds: number, createdMs: number): PickSpec => ({ capperId: c5.SP, status: "WIN", odds, gameTime: ago(2000 + i * 100 + (odds > 0 ? 3 : 0)), createdAt: new Date(T0 - createdMs) });
  const favFirst: PickSpec[] = [];
  for (let i = 0; i < 5; i++) favFirst.push(spec(i, -140, 300000 + i * 10), spec(i, 150, 200000 + i * 10));
  await addPicks(U5, favFirst);
  let sp = (await adapter.getCapperLeaderboardTable(U5, "ALL")).find((e) => e.capperId === c5.SP)!.specialist;
  same("tie: 50/50 specialist -> category with the earlier first pick (FAV_ML)", sp?.category, "FAV_ML");
  same("tie: specialist agrees with the ordered raw-pick path", (await adapter.legacyCapperLeaderboardTable(U5, "ALL")).find((e) => e.capperId === c5.SP)!.specialist, sp);
  await prisma.pick.updateMany({ where: { userId: U5, capperId: c5.SP, category: "DOG_ML" }, data: { createdAt: new Date(T0 - 900000) } });
  sp = (await adapter.getCapperLeaderboardTable(U5, "ALL")).find((e) => e.capperId === c5.SP)!.specialist;
  same("tie: make DOG_ML's first pick older -> DOG_ML wins the tie", sp?.category, "DOG_ML");
  same("tie: swapped specialist agrees with the ordered raw-pick path", (await adapter.legacyCapperLeaderboardTable(U5, "ALL")).find((e) => e.capperId === c5.SP)!.specialist, sp);

  // ---------------- Write path: stamped at insert ----------------
  const U6 = await makeUser("write");
  const c6 = await makeCappers(U6, [{ key: "W", name: "Writer" }]);
  const mlb = sportIdByName.get("MLB")!;
  const nfl = sportIdByName.get("NFL")!;
  const gt = ago(-500);
  const rows = [
    { capperId: c6.W, sportId: mlb, homeTeam: "A", awayTeam: "B", betType: "MONEYLINE" as const, odds: -120, period: "FIRST_HALF" as const, units: 1, gameTime: gt },
    { capperId: c6.W, sportId: nfl, homeTeam: "C", awayTeam: "D", betType: "MONEYLINE" as const, odds: 130, period: "FIRST_HALF" as const, units: 1, gameTime: gt },
    { capperId: c6.W, sportId: mlb, homeTeam: "A", awayTeam: "B", betType: "TOTAL" as const, betDetail: "8.5", odds: -110, units: 1, gameTime: gt },
    { capperId: c6.W, sportId: nfl, homeTeam: "C", awayTeam: "D", betType: "PLAYER_PROP" as const, betDetail: "anything", propMarket: "REC_YDS" as const, odds: -115, units: 1, gameTime: gt },
    { capperId: c6.W, sportId: mlb, homeTeam: "A", awayTeam: "B", betType: "SPREAD" as const, line: -1.5, odds: 120, units: 1, gameTime: gt },
  ];
  const result = await createPicksWithEntitlementCheck(U6, rows);
  check("write path: createPicksWithEntitlementCheck allowed", result.allowed === true);
  const written = result.allowed ? await prisma.pick.findMany({ where: { id: { in: result.created.map((c) => c.id) } }, include: { sport: true } }) : [];
  const byBet = (bt: string, sportName: string) => written.find((p) => p.betType === bt && p.sport.name === sportName)!;
  same("write path: MLB first-half ML stamped F5_ML", byBet("MONEYLINE", "MLB").category, "F5_ML");
  same("write path: NFL first-half ML stamped FIRST_HALF_ML", byBet("MONEYLINE", "NFL").category, "FIRST_HALF_ML");
  same("write path: TOTAL with no over/under stamped null (a real result, still versioned)", [byBet("TOTAL", "MLB").category, byBet("TOTAL", "MLB").categoryVersion], [null, PICK_CATEGORY_VERSION]);
  same("write path: player prop with propMarket stamped TD_PROP", byBet("PLAYER_PROP", "NFL").category, "TD_PROP");
  check("write path: every stamped row equals pickCategory(row) at the current version", written.every((p) => p.categoryVersion === PICK_CATEGORY_VERSION && p.category === pickCategory({ ...p, sportName: p.sport.name })));

  console.log(`\n${assertions} assertions, ${failures} failed.`);
}

async function cleanup() {
  // Exact ids only. Users cascade to their cappers and picks; sports are removed only if this run created them.
  let deletedUsers = 0;
  for (const id of createdUserIds) {
    const { count } = await prisma.user.deleteMany({ where: { id } });
    deletedUsers += count;
  }
  let deletedSports = 0;
  for (const id of createdSportIds) {
    const { count } = await prisma.sport.deleteMany({ where: { id } });
    deletedSports += count;
  }
  const after = { users: await prisma.user.count(), picks: await prisma.pick.count(), sports: await prisma.sport.count() };
  console.log(`cleanup: deleted ${deletedUsers} user(s), ${deletedSports} sport(s). DB after: users=${after.users} picks=${after.picks} sports=${after.sports}`);
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
