// Parity test for the /live category panel: the SQL getSportCategoryPanelData
// (pick-aggregates-cappers-adapter.ts, now what /live uses) must return exactly
// what the original raw-pick JS version (cappers.ts) returned, on a fixture with
// several cappers across many MLB categories.
//
// Only one difference is allowed and it is tested as such: cappers with an
// EQUAL win% in the same category. The original ordered them by unspecified
// fetch order (findMany with no orderBy); the SQL path orders them by the
// createdAt, id of the capper's first pick in that category. Everything else is
// asserted byte-identical, including which cappers make the top-5 cut.
//
// DB-backed and WRITING: every id is prefixed `__LiveCatPanel__` and deleted by
// exact id at the end (with before/after counts). Refuses to run unless
// DATABASE_URL points at localhost. Run against a disposable local Postgres with
// migrations applied:
//   DATABASE_URL=postgresql://postgres@localhost:54329/capper_pr_d \
//   DIRECT_URL=postgresql://postgres@localhost:54329/capper_pr_d \
//   npx tsx src/server/data/live-category-panel-parity-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";
import * as legacy from "@/server/data/sport-category-panel-legacy"; // getSportCategoryPanelData moved out of cappers.ts (#128 made it unused by any page) - see that file's header.
import * as adapter from "@/server/data/pick-aggregates-cappers-adapter";

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
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function canon(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canon(v)])
    );
  }
  return x;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const PREFIX = "__LiveCatPanel__";
const T0 = Date.now();
const createdUserIds: string[] = [];
const createdCapperIds: string[] = [];
const createdPickIds: string[] = [];
const createdSportIds: string[] = [];
const sportIdByName = new Map<string, string>();

async function ensureSport(name: string) {
  const existing = await prisma.sport.findUnique({ where: { name } });
  if (existing) return void sportIdByName.set(name, existing.id);
  const s = await prisma.sport.create({ data: { name } });
  createdSportIds.push(s.id);
  sportIdByName.set(name, s.id);
}

async function makeUser(tag: string, capperNames: Record<string, string>) {
  const id = `${PREFIX}user-${tag}`;
  await prisma.user.create({ data: { id, supabaseId: `${PREFIX}sb-${tag}`, email: `${PREFIX}${tag}@example.invalid` } });
  createdUserIds.push(id);
  const ids: Record<string, string> = {};
  for (const [key, name] of Object.entries(capperNames)) {
    const cid = `${PREFIX}${tag}-${key}`;
    await prisma.capper.create({ data: { id: cid, userId: id, name, source: "OTHER" } });
    createdCapperIds.push(cid);
    ids[key] = cid;
  }
  return { userId: id, cappers: ids };
}

type Extra = {
  sport?: string;
  betType?: Prisma.PickUncheckedCreateInput["betType"];
  period?: Prisma.PickUncheckedCreateInput["period"];
  betDetail?: string | null;
  odds?: number;
  line?: number | null;
};

let seq = 0;
// createdAt strictly increases with seq, so callers control "first pick" order
// by the order they call rec() in.
function row(userId: string, capperId: string, status: "WIN" | "LOSS" | "PUSH" | "PENDING" | "CANCELLED", e: Extra): Prisma.PickCreateManyInput {
  seq++;
  const sport = e.sport ?? "MLB";
  const betType = e.betType ?? "MONEYLINE";
  const period = e.period ?? "FULL_GAME";
  const odds = e.odds ?? -140;
  const line = e.line ?? null;
  const betDetail = e.betDetail ?? null;
  const gameTime = new Date(T0 - seq * 3 * 3600000);
  const id = `${PREFIX}pick-${seq}`;
  createdPickIds.push(id);
  return {
    id,
    userId,
    capperId,
    sportId: sportIdByName.get(sport)!,
    homeTeam: "Home",
    awayTeam: "Away",
    betType,
    betDetail,
    odds,
    line,
    period,
    units: 1,
    datePosted: gameTime,
    gameTime,
    status,
    gradedAt: status === "PENDING" ? null : new Date(gameTime.getTime() + 3 * 3600000),
    createdAt: new Date(T0 - 1e7 + seq * 1000),
    pickedSide: null,
    mlFavoredSide: null,
    propMarket: null,
    category: pickCategory({ betType, period, betDetail, odds, line, sportName: sport, pickedSide: null, mlFavoredSide: null, propMarket: null }),
    categoryVersion: PICK_CATEGORY_VERSION,
  };
}

function rec(rows: Prisma.PickCreateManyInput[], userId: string, capperId: string, w: number, l: number, e: Extra = {}, pushes = 0) {
  for (let i = 0; i < w; i++) rows.push(row(userId, capperId, "WIN", e));
  for (let i = 0; i < l; i++) rows.push(row(userId, capperId, "LOSS", e));
  for (let i = 0; i < pushes; i++) rows.push(row(userId, capperId, "PUSH", e));
}

const FAV = { odds: -140 };
const DOG = { odds: 150 };
const OVER = { betType: "TOTAL" as const, betDetail: "Over 8", odds: -110 };
const UNDER = { betType: "TOTAL" as const, betDetail: "Under 8", odds: -110 };
const NULLCAT = { betType: "TOTAL" as const, betDetail: "8.5", odds: -110 };
const SPREAD_M = { betType: "SPREAD" as const, line: -1.5, odds: -110 };
const SPREAD_P = { betType: "SPREAD" as const, line: 1.5, odds: -110 };
const F5 = { period: "FIRST_HALF" as const, odds: -120 };
const NRFI = { betType: "NRFI" as const, betDetail: "NRFI", odds: -120 };

async function main() {
  await ensureSport("MLB");
  await ensureSport("NFL");

  const before = {
    users: await prisma.user.count({ where: { id: { startsWith: PREFIX } } }),
    cappers: await prisma.capper.count({ where: { id: { startsWith: PREFIX } } }),
    picks: await prisma.pick.count({ where: { id: { startsWith: PREFIX } } }),
  };

  // ---- U1: tie-free, several cappers x many categories ----------------------
  const u1 = await makeUser("free", { A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf", H: "Hotel" });
  const r1: Prisma.PickCreateManyInput[] = [];
  const U = u1.userId;
  const c = u1.cappers;
  // FAV_ML: 8 cappers, all distinct win% (90, 83.3, 75, 70, 62.5, 50, 25, and G 2-0 under the 3-decided floor).
  rec(r1, U, c.A, 9, 1, FAV); rec(r1, U, c.B, 5, 1, FAV); rec(r1, U, c.C, 6, 2, FAV); rec(r1, U, c.D, 7, 3, FAV);
  rec(r1, U, c.H, 5, 3, FAV); rec(r1, U, c.E, 3, 3, FAV); rec(r1, U, c.F, 1, 3, FAV); rec(r1, U, c.G, 2, 0, FAV);
  // Cancelled and pending picks in a decided category must be ignored by both paths.
  r1.push(row(U, c.E, "CANCELLED", FAV), row(U, c.E, "PENDING", FAV));
  rec(r1, U, c.B, 2, 1, DOG); rec(r1, U, c.C, 1, 2, DOG); rec(r1, U, c.E, 3, 2, DOG); rec(r1, U, c.A, 2, 0, DOG);
  rec(r1, U, c.D, 4, 0, OVER); rec(r1, U, c.E, 3, 1, OVER); rec(r1, U, c.F, 2, 2, OVER);
  rec(r1, U, c.B, 4, 1, SPREAD_M); rec(r1, U, c.H, 2, 3, SPREAD_M); rec(r1, U, c.C, 3, 3, SPREAD_M);
  rec(r1, U, c.F, 3, 1, SPREAD_P); rec(r1, U, c.D, 2, 1, SPREAD_P);
  rec(r1, U, c.C, 3, 1, F5); rec(r1, U, c.E, 2, 2, F5, 1);
  rec(r1, U, c.A, 4, 1, NRFI); rec(r1, U, c.D, 3, 2, NRFI); rec(r1, U, c.B, 3, 3, NRFI);
  // A category whose only picks are still pending must produce no tile.
  r1.push(row(U, c.G, "PENDING", UNDER), row(U, c.H, "PENDING", UNDER));
  // A null-category total, and another sport that must not leak into MLB.
  rec(r1, U, c.G, 2, 2, NULLCAT);
  rec(r1, U, c.A, 6, 2, { ...FAV, sport: "NFL" });
  await prisma.pick.createMany({ data: r1 });

  // ---- U2: equal win% ties ---------------------------------------------------
  const u2 = await makeUser("ties", { X: "Xray", Y: "Yankee", Z: "Zulu", W: "Whiskey" });
  const r2: Prisma.PickCreateManyInput[] = [];
  // Yankee's first DOG_ML pick is created BEFORE Xray's, so the new tie rule puts
  // Yankee ahead of Xray. Both are 3-1 (75%); Whiskey is 3-1 too (three-way tie);
  // Zulu is 2-2. Fewer than 6 eligible cappers, so no tie straddles the top-5 cut.
  rec(r2, u2.userId, u2.cappers.Y, 3, 1, DOG);
  rec(r2, u2.userId, u2.cappers.X, 3, 1, DOG);
  rec(r2, u2.userId, u2.cappers.W, 3, 1, DOG);
  rec(r2, u2.userId, u2.cappers.Z, 2, 2, DOG);
  rec(r2, u2.userId, u2.cappers.X, 5, 0, FAV);
  await prisma.pick.createMany({ data: r2 });

  // Spy: count raw pick reads made by each implementation.
  type FindMany = typeof prisma.pick.findMany;
  const original: FindMany = prisma.pick.findMany.bind(prisma.pick) as FindMany;
  let rawPickReads = 0;
  (prisma.pick as unknown as { findMany: unknown }).findMany = ((args: never) => {
    rawPickReads++;
    return original(args);
  }) as FindMany;

  try {
    // ---- U1: exact parity --------------------------------------------------
    rawPickReads = 0;
    const neu = await adapter.getSportCategoryPanelData(U, "MLB");
    const newReads = rawPickReads;
    rawPickReads = 0;
    const old = await legacy.getSportCategoryPanelData(U, "MLB");
    const oldReads = rawPickReads;

    check("MLB fixture exercises many categories (non-vacuous)", neu.breakdown.length >= 7, `breakdown has ${neu.breakdown.length}: ${neu.breakdown.map((b) => b.key)}`);
    check("pending-only UNDER category produces no tile in either path", !neu.breakdown.some((b) => b.key === "UNDER") && !old.breakdown.some((b) => b.key === "UNDER"));
    check("FAV_ML leaderboard is capped at 5 with the right cappers", (neu.leaderboards.FAV_ML ?? []).map((e) => e.name).join(",") === "Alpha,Bravo,Charlie,Delta,Hotel", (neu.leaderboards.FAV_ML ?? []).map((e) => e.name).join(","));
    check("2-0 capper (below the 3-decided floor) is on no leaderboard but counted in the tile", !(neu.leaderboards.FAV_ML ?? []).some((e) => e.name === "Golf") && neu.breakdown.find((b) => b.key === "FAV_ML")!.wins === 9 + 5 + 6 + 7 + 5 + 3 + 1 + 2);
    check("NFL picks do not leak into the MLB panel", neu.breakdown.find((b) => b.key === "FAV_ML")!.count === 54);
    check("breakdown identical to original", same(neu.breakdown, old.breakdown));
    check("leaderboards identical to original (tie-free fixture, exact order)", same(neu.leaderboards, old.leaderboards));
    check("whole panel identical to original", same(neu, old));

    // ---- egress: the SQL path fetches no raw picks -------------------------
    check("original path reads raw picks (spy is live)", oldReads >= 1, `reads=${oldReads}`);
    check("SQL path issues zero raw pick reads", newReads === 0, `reads=${newReads}`);

    // ---- U2: ties -----------------------------------------------------------
    const tNew = await adapter.getSportCategoryPanelData(u2.userId, "MLB");
    const tOld = await legacy.getSportCategoryPanelData(u2.userId, "MLB");
    check("tie fixture: breakdown identical to original", same(tNew.breakdown, tOld.breakdown));
    const dogNew = tNew.leaderboards.DOG_ML ?? [];
    const dogOld = tOld.leaderboards.DOG_ML ?? [];
    check("tie fixture: same cappers and records as original, allowing tie order to differ", same([...dogNew].sort((a, b) => (a.capperId < b.capperId ? -1 : 1)), [...dogOld].sort((a, b) => (a.capperId < b.capperId ? -1 : 1))));
    check("tie fixture: win% is non-increasing in both", dogNew.every((e, i) => i === 0 || dogNew[i - 1].winPct >= e.winPct) && dogOld.every((e, i) => i === 0 || dogOld[i - 1].winPct >= e.winPct));
    check(
      "tie fixture: SQL path orders equal win% by first pick created (Yankee, Xray, Whiskey), then the 50% capper",
      dogNew.map((e) => e.name).join(",") === "Yankee,Xray,Whiskey,Zulu",
      dogNew.map((e) => e.name).join(",")
    );
    check("tie fixture: returned entries carry no internal ordering key", dogNew.every((e) => !("firstKey" in e)));

    // ---- wiring: /live no longer imports the raw-pick version ---------------
    const liveSrc = readFileSync(join(process.cwd(), "src/app/(app)/live/page.tsx"), "utf8");
    check(
      "/live imports getSportCategoryPanelData from the SQL adapter",
      /import\s*\{[^}]*getSportCategoryPanelData[^}]*\}\s*from\s*"@\/server\/data\/pick-aggregates-cappers-adapter"/.test(liveSrc)
    );
    check("/live does not import it from cappers.ts", !/getSportCategoryPanelData[^;]*from\s*"@\/server\/data\/cappers"/.test(liveSrc));
  } finally {
    (prisma.pick as unknown as { findMany: unknown }).findMany = original;
    const del = {
      picks: (await prisma.pick.deleteMany({ where: { id: { in: createdPickIds } } })).count,
      cappers: (await prisma.capper.deleteMany({ where: { id: { in: createdCapperIds } } })).count,
      users: (await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })).count,
      sports: createdSportIds.length ? (await prisma.sport.deleteMany({ where: { id: { in: createdSportIds } } })).count : 0,
    };
    const after = {
      users: await prisma.user.count({ where: { id: { startsWith: PREFIX } } }),
      cappers: await prisma.capper.count({ where: { id: { startsWith: PREFIX } } }),
      picks: await prisma.pick.count({ where: { id: { startsWith: PREFIX } } }),
    };
    console.log(`cleanup: prefixed rows before=${JSON.stringify(before)} deleted=${JSON.stringify(del)} after=${JSON.stringify(after)}`);
    if (after.users + after.cappers + after.picks !== 0) {
      console.log("FAIL: fixture rows remain after cleanup");
      failures++;
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failures > 0) process.exit(1);
    console.log("\nAll checks passed.");
  });
