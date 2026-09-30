// Behavior-preservation test for getCapperPanels' move from a full-history pick
// fetch to database-side aggregates (capper-list-aggregates.ts), plus its caching.
//
// Three layers:
//   1. GOLDEN blocks below: captured from the ORIGINAL implementation (always
//      `include: { sport: true }`, uncached) against this exact fixture. The SQL
//      implementation must reproduce them byte for byte, unfiltered and with a
//      sportName filter. The one deliberate difference: the streak entries' `stats`
//      no longer carry longestWinStreak / longestLossStreak (nothing reads them; the
//      type narrowed to RecordStats), so those two keys are stripped from the goldens.
//   2. PARITY: getCapperPanels must equal the frozen raw-pick implementation
//      (capper-panels-legacy.ts) on the same rows - the fixture above plus a second
//      user whose picks stress the cases the golden fixture avoids: picks graded in
//      the same instant, an all-PENDING capper, a capper with no picks, picks on the
//      activity-cutoff edge, a zero-odds WIN.
//   3. Query shape (the panels never fetch pick rows) and cache-key uniqueness.
//
// DB-backed and WRITING: creates its own user/cappers/picks (ids prefixed
// `__PanelsCache__`) and deletes them by exact id at the end. Refuses to run
// unless DATABASE_URL points at localhost. Run against a disposable local
// Postgres with migrations applied:
//   DATABASE_URL=postgresql://postgres@localhost:54329/capper_pr_c \
//   DIRECT_URL=postgresql://postgres@localhost:54329/capper_pr_c \
//   npx tsx src/server/data/capper-panels-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getCapperPanels, capperPanelsCacheKey, type CapperPanels } from "@/server/data/capper-panels";
import { getCapperPanelsLegacy } from "@/server/data/capper-panels-legacy";
import { cacheKeys } from "@/lib/cache-keys";
import { computeStats } from "@/server/data/stats";
import { queryCurrentStreaks } from "@/server/data/capper-list-aggregates";

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

const PREFIX = "__PanelsCache__";
const T0 = Date.now();
const HOUR = 3600000;
const DAY = 24 * HOUR;

let seq = 0;
type Row = Prisma.PickCreateManyInput;

// `results` is oldest -> newest. Each pick's gradedAt strictly increases, so
// the "most recently graded first" ordering the panels use is unambiguous.
function picksFor(
  userId: string,
  capperId: string,
  sportId: string,
  results: ("WIN" | "LOSS" | "PUSH" | "PENDING")[],
  opts: { postedAgoDays: number; odds?: number; betType?: "MONEYLINE" | "SPREAD"; line?: number }
): Row[] {
  return results.map((status, i) => {
    seq++;
    const gradedAt = new Date(T0 - (results.length - i) * HOUR * 2);
    const betType = opts.betType ?? "MONEYLINE";
    return {
      id: `${PREFIX}pick-${seq}`,
      userId,
      capperId,
      sportId,
      homeTeam: "Home",
      awayTeam: "Away",
      betType,
      betDetail: null,
      odds: opts.odds ?? -120,
      line: betType === "SPREAD" ? opts.line ?? -3.5 : null,
      period: "FULL_GAME",
      units: 1 + (i % 3) * 0.5,
      datePosted: new Date(T0 - opts.postedAgoDays * DAY - i * 1000),
      gameTime: new Date(gradedAt.getTime() - 3 * HOUR),
      status,
      gradedAt: status === "PENDING" ? null : gradedAt,
      createdAt: new Date(T0 - seq * 1000),
    };
  });
}

const W = "WIN" as const;
const L = "LOSS" as const;
const P = "PUSH" as const;
const X = "PENDING" as const;

// NOTE (tie-break fix): Hot Hand's MLB and NFL picks deliberately share gameTime
// (MLB picks 8/9 vs NFL picks 0/1) - real slates have such ties. The original
// capture happened to fetch the MLB pick first inside each tie, giving a current
// streak of 2; the other fetch order gives 3. Picks are now ordered by the
// canonical (gameTime, createdAt, id) tie-break (src/lib/pick-order.ts), which
// puts the NFL picks (older createdAt) first: L, W, W, W -> streak 3. So the
// unfiltered and FAV_ML goldens' Hot Hand streakCount / currentStreak.count are
// 3 (was 2); every other value is byte-identical to the original capture, and
// the MLB-only golden (no tie) is unchanged. Set PANELS_DEBUG=1 to dump the
// actual outputs when a check fails.
// ---- GOLDEN (captured from the original implementation) ---------------------
const GOLDEN_UNFILTERED: unknown = {"hotStreaks":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"streakCount":8,"weightedScore":-3.93,"stats":{"wins":8,"losses":8,"pushes":0,"winPct":50,"unitsWon":10,"unitsLost":11.5,"netUnits":-1.5,"roi":-6.38,"currentStreak":{"type":"WIN","count":8},"longestWinStreak":8,"longestLossStreak":8}},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","streakCount":3,"weightedScore":10.16,"stats":{"wins":8,"losses":4,"pushes":0,"winPct":66.66666666666666,"unitsWon":9.17,"unitsLost":6,"netUnits":3.17,"roi":18.63,"currentStreak":{"type":"WIN","count":3},"longestWinStreak":3,"longestLossStreak":1}}],"coolingOff":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"streakCount":10,"weightedScore":15.14,"stats":{"wins":20,"losses":10,"pushes":0,"winPct":66.66666666666666,"unitsWon":24.58,"unitsLost":15.5,"netUnits":9.08,"roi":20.19,"currentStreak":{"type":"LOSS","count":10},"longestWinStreak":20,"longestLossStreak":10}},{"capperId":"__PanelsCache__c-cold","name":"Cold Cat","colorTag":null,"streakCount":4,"weightedScore":-11.98,"stats":{"wins":3,"losses":5,"pushes":0,"winPct":37.5,"unitsWon":4.9,"unitsLost":8,"netUnits":-3.1,"roi":-26.96,"currentStreak":{"type":"LOSS","count":4},"longestWinStreak":2,"longestLossStreak":4}}],"rising":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"previousWinPct":60,"recentWinPct":100,"risePts":40}],"fallingOff":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"lifetimeWinPct":66.67,"recentWinPct":0,"dropPts":66.67},{"capperId":"__PanelsCache__c-nfl","name":"Nfl Nate","colorTag":null,"lifetimeWinPct":80,"recentWinPct":70,"dropPts":10}],"bestLast20":[{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":8,"losses":4,"pushes":0,"recentWinPct":66.67,"weightedScore":60.18},{"capperId":"__PanelsCache__c-nfl","name":"Nfl Nate","colorTag":null,"wins":8,"losses":2,"pushes":2,"recentWinPct":66.67,"weightedScore":60.18},{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92},{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"wins":10,"losses":10,"pushes":0,"recentWinPct":50,"weightedScore":50.8}],"worstLast20":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"wins":10,"losses":10,"pushes":0,"recentWinPct":50,"weightedScore":50.8},{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":8,"losses":4,"pushes":0,"recentWinPct":66.67,"weightedScore":60.18},{"capperId":"__PanelsCache__c-nfl","name":"Nfl Nate","colorTag":null,"wins":8,"losses":2,"pushes":2,"recentWinPct":66.67,"weightedScore":60.18}]};
const GOLDEN_SPORT_MLB: unknown = {"hotStreaks":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"streakCount":8,"weightedScore":-3.93,"stats":{"wins":8,"losses":8,"pushes":0,"winPct":50,"unitsWon":10,"unitsLost":11.5,"netUnits":-1.5,"roi":-6.38,"currentStreak":{"type":"WIN","count":8},"longestWinStreak":8,"longestLossStreak":8}},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","streakCount":4,"weightedScore":10.06,"stats":{"wins":7,"losses":3,"pushes":0,"winPct":70,"unitsWon":7.92,"unitsLost":5,"netUnits":2.92,"roi":20.11,"currentStreak":{"type":"WIN","count":4},"longestWinStreak":4,"longestLossStreak":1}}],"coolingOff":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"streakCount":10,"weightedScore":15.14,"stats":{"wins":20,"losses":10,"pushes":0,"winPct":66.66666666666666,"unitsWon":24.58,"unitsLost":15.5,"netUnits":9.08,"roi":20.19,"currentStreak":{"type":"LOSS","count":10},"longestWinStreak":20,"longestLossStreak":10}},{"capperId":"__PanelsCache__c-cold","name":"Cold Cat","colorTag":null,"streakCount":4,"weightedScore":-11.98,"stats":{"wins":3,"losses":5,"pushes":0,"winPct":37.5,"unitsWon":4.9,"unitsLost":8,"netUnits":-3.1,"roi":-26.96,"currentStreak":{"type":"LOSS","count":4},"longestWinStreak":2,"longestLossStreak":4}}],"rising":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"previousWinPct":60,"recentWinPct":100,"risePts":40}],"fallingOff":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"lifetimeWinPct":66.67,"recentWinPct":0,"dropPts":66.67}],"bestLast20":[{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":7,"losses":3,"pushes":0,"recentWinPct":70,"weightedScore":61.2},{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92},{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"wins":10,"losses":10,"pushes":0,"recentWinPct":50,"weightedScore":50.8}],"worstLast20":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"wins":10,"losses":10,"pushes":0,"recentWinPct":50,"weightedScore":50.8},{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":7,"losses":3,"pushes":0,"recentWinPct":70,"weightedScore":61.2}]};


// Cases the golden fixture avoids. Everything is compared to the frozen raw-pick
// implementation, which defines correct behavior for these.
async function edgeCases(sportIds: Record<string, string>) {
  const edgeUser = `${PREFIX}edge-user`;
  await prisma.user.create({ data: { id: edgeUser, supabaseId: `${PREFIX}edge-sb`, email: `${PREFIX}edge@example.invalid` } });
  try {
    const cid = (k: string) => `${PREFIX}e-${k}`;
    for (const [k, name] of [["tie", "Tie Tim"], ["pend", "Pending Pam"], ["none", "No Picks Nina"], ["edge", "Edge Ed"], ["zero", "Zero Zed"]]) {
      await prisma.capper.create({ data: { id: cid(k), userId: edgeUser, name, source: "OTHER" } });
    }
    const base = {
      userId: edgeUser,
      sportId: sportIds.MLB,
      homeTeam: "H",
      awayTeam: "A",
      betType: "MONEYLINE" as const,
      betDetail: null,
      line: null,
      period: "FULL_GAME" as const,
      units: 1,
      odds: -110,
    };
    const rows: Row[] = [];
    let n = 0;
    const mk = (capper: string, status: "WIN" | "LOSS" | "PUSH" | "PENDING", o: { gradedAt?: Date | null; gameTime?: Date; createdAt?: Date; postedAgoMs?: number; odds?: number; id?: string }) => {
      n++;
      rows.push({
        ...base,
        id: o.id ?? `${PREFIX}edge-pick-${String(n).padStart(3, "0")}`,
        capperId: cid(capper),
        status,
        odds: o.odds ?? base.odds,
        datePosted: new Date(T0 - (o.postedAgoMs ?? HOUR)),
        gameTime: o.gameTime ?? new Date(T0 - n * HOUR),
        gradedAt: o.gradedAt === undefined ? (status === "PENDING" ? null : new Date(T0 - n * HOUR)) : o.gradedAt,
        createdAt: o.createdAt ?? new Date(T0 - n * 1000),
      });
    };

    // Tie Tim: 20 decided picks ALL graded in the same instant, so every rank in
    // the recent-form slices is decided purely by the (createdAt DESC, id DESC)
    // tie-break. Results alternate in blocks so the slice boundaries matter.
    const sameInstant = new Date(T0 - 5 * HOUR);
    const pattern: ("WIN" | "LOSS" | "PUSH")[] = ["W", "W", "L", "W", "L", "L", "W", "P", "W", "L", "W", "W", "L", "W", "L", "L", "W", "W", "L", "W"].map((c) => (c === "W" ? "WIN" : c === "L" ? "LOSS" : "PUSH"));
    pattern.forEach((status, i) => mk("tie", status, { gradedAt: sameInstant, createdAt: new Date(T0 - 100000 + i * 1000), id: `${PREFIX}edge-tie-${String(i).padStart(2, "0")}` }));
    // ...and two picks sharing gradedAt AND createdAt, separated by id alone.
    mk("tie", "WIN", { gradedAt: sameInstant, createdAt: new Date(T0 - 50000), id: `${PREFIX}edge-tie-zz-a` });
    mk("tie", "LOSS", { gradedAt: sameInstant, createdAt: new Date(T0 - 50000), id: `${PREFIX}edge-tie-zz-b` });

    // Pending Pam: only PENDING/ungraded picks - active, but no decided picks.
    for (let i = 0; i < 4; i++) mk("pend", "PENDING", {});

    // Edge Ed: newest datePosted is one minute INSIDE the 14-day activity cutoff.
    [ "WIN", "LOSS", "WIN", "WIN", "LOSS", "WIN", "LOSS", "LOSS", "WIN", "WIN", "WIN", "LOSS" ].forEach((s) =>
      mk("edge", s as "WIN" | "LOSS", { postedAgoMs: 14 * DAY - 60000 })
    );

    // Zero Zed: a WIN at odds 0 poisons unitsWon (Infinity/NaN in JS) - must
    // behave the same way on the SQL path.
    [ "LOSS", "WIN", "WIN", "WIN" ].forEach((s, i) => mk("zero", s as "WIN" | "LOSS", { odds: i === 1 ? 0 : -120 }));

    await prisma.pick.createMany({ data: rows });

    const a = await getCapperPanels(edgeUser);
    const b = await getCapperPanelsLegacy(edgeUser);
    const strip = (x: CapperPanels) => {
      const g = JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v))) as CapperPanels;
      for (const list of [g.hotStreaks, g.coolingOff]) for (const e of list) {
        const s = e.stats as unknown as Record<string, unknown>;
        delete s.longestWinStreak;
        delete s.longestLossStreak;
      }
      return g;
    };
    check("edge fixture: SQL panels == legacy (ties, pending-only, no picks, cutoff edge, zero odds)", JSON.stringify(strip(a)) === JSON.stringify(strip(b)), process.env.PANELS_DEBUG ? JSON.stringify(strip(a)) + "\nVS\n" + JSON.stringify(strip(b)) : "");
    const names = new Set([...a.bestLast20, ...a.hotStreaks, ...a.coolingOff, ...a.rising, ...a.fallingOff].map((e) => e.name));
    check("edge fixture: the tie capper reaches a panel (the tie-break is actually exercised)", names.has("Tie Tim"));
    check("edge fixture: capper with no picks never appears", !names.has("No Picks Nina"));
    check("edge fixture: all-pending capper never appears", !names.has("Pending Pam"));
  } finally {
    await prisma.pick.deleteMany({ where: { userId: edgeUser } });
    await prisma.capper.deleteMany({ where: { userId: edgeUser } });
    await prisma.user.deleteMany({ where: { id: edgeUser } });
  }
}

async function main() {
  const userId = `${PREFIX}user`;
  await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}u@example.invalid` } });

  const createdSportIds: string[] = [];
  const sportIds: Record<string, string> = {};
  for (const name of ["MLB", "NFL"]) {
    const existing = await prisma.sport.findUnique({ where: { name } });
    if (existing) sportIds[name] = existing.id;
    else {
      const s = await prisma.sport.create({ data: { name } });
      createdSportIds.push(s.id);
      sportIds[name] = s.id;
    }
  }

  const cappers = [
    { key: "hot", name: "Hot Hand" },
    { key: "cold", name: "Cold Cat" },
    { key: "rising", name: "Rising Rita" },
    { key: "fall", name: "Falling Fred" },
    { key: "idle", name: "Idle Ivan" },
    { key: "nfl", name: "Nfl Nate" },
  ];
  const capperId = (k: string) => `${PREFIX}c-${k}`;
  for (const c of cappers) {
    await prisma.capper.create({ data: { id: capperId(c.key), userId, name: c.name, source: "OTHER", colorTag: c.key === "hot" ? "#ff0000" : null } });
  }

  const rows: Row[] = [
    // Hot: long win streak at the end, mixed before.
    ...picksFor(userId, capperId("hot"), sportIds.MLB, [L, W, L, W, W, L, W, W, W, W], { postedAgoDays: 1 }),
    // Cold: loss streak at the end.
    ...picksFor(userId, capperId("cold"), sportIds.MLB, [W, W, L, W, L, L, L, L], { postedAgoDays: 2, odds: 140 }),
    // Rising: newest 8 all wins, prior 8 all losses (5- and 8-windows both clear +10).
    ...picksFor(userId, capperId("rising"), sportIds.MLB, [L, L, L, L, L, L, L, L, W, W, W, W, W, W, W, W], { postedAgoDays: 1 }),
    // Falling: 20 older wins then 10 straight losses (lifetime high, recent 10 poor).
    ...picksFor(userId, capperId("fall"), sportIds.MLB, [...Array(20).fill(W), ...Array(10).fill(L)], { postedAgoDays: 3, betType: "SPREAD" }),
    // Idle: plenty of picks, none posted inside the 14-day activity window.
    ...picksFor(userId, capperId("idle"), sportIds.MLB, [W, W, W, L, W, W], { postedAgoDays: 30 }),
    // NFL-only capper with pushes and a pending pick, also mixed in MLB elsewhere above.
    ...picksFor(userId, capperId("nfl"), sportIds.NFL, [W, P, W, W, L, W, X, W, W, P, W, L, W], { postedAgoDays: 1 }),
    // Hot also has a couple of NFL picks so a sportName filter changes its numbers.
    ...picksFor(userId, capperId("hot"), sportIds.NFL, [L, W], { postedAgoDays: 1 }),
  ];
  await prisma.pick.createMany({ data: rows });

  // Record how each call queries the pick table.
  type FindManyArgs = Parameters<typeof prisma.pick.findMany>[0];
  const seen: FindManyArgs[] = [];
  const originalFindMany = prisma.pick.findMany.bind(prisma.pick);
  (prisma.pick as unknown as { findMany: unknown }).findMany = (args: FindManyArgs) => {
    seen.push(args);
    return originalFindMany(args as never);
  };

  try {
    const unfiltered = await getCapperPanels(userId);
    const afterUnfiltered = seen.length;
    const sportMlb = await getCapperPanels(userId, { sportName: "MLB" });
    const afterMlb = seen.length;

    if (GOLDEN_UNFILTERED === null || GOLDEN_SPORT_MLB === null) {
      console.log("CAPTURE (no golden embedded yet):");
      console.log(JSON.stringify({ unfiltered, sportMlb }));
      process.exitCode = 2;
      return;
    }

    if (process.env.PANELS_DEBUG) {
      console.log("DEBUG unfiltered=" + JSON.stringify(unfiltered));
    }
    // The goldens predate the stats narrowing - see the header.
    const withoutLongestStreaks = (golden: unknown): unknown => {
      const g = JSON.parse(JSON.stringify(golden)) as CapperPanels;
      for (const list of [g.hotStreaks, g.coolingOff]) {
        for (const e of list) {
          const s = e.stats as unknown as Record<string, unknown>;
          delete s.longestWinStreak;
          delete s.longestLossStreak;
        }
      }
      return g;
    };
    check("unfiltered output identical to original implementation", JSON.stringify(unfiltered) === JSON.stringify(withoutLongestStreaks(GOLDEN_UNFILTERED)));
    check("sportName=MLB output identical to original implementation", JSON.stringify(sportMlb) === JSON.stringify(withoutLongestStreaks(GOLDEN_SPORT_MLB)));

    const panelHasEntries = (p: typeof unfiltered) =>
      p.hotStreaks.length > 0 && p.coolingOff.length > 0 && p.rising.length > 0 && p.fallingOff.length > 0 && p.bestLast20.length > 0;
    check("fixture exercises hot, cooling, rising, falling-off and best/worst panels", panelHasEntries(unfiltered));
    check(
      "inactive capper is excluded and NFL filter changes the numbers",
      !unfiltered.bestLast20.some((e) => e.name === "Idle Ivan") &&
        JSON.stringify(unfiltered) !== JSON.stringify(sportMlb)
    );

    // Parity against the frozen raw-pick implementation, same rows.
    const legacyUnfiltered = await getCapperPanelsLegacy(userId);
    const legacyMlb = await getCapperPanelsLegacy(userId, { sportName: "MLB" });
    const legacyNfl = await getCapperPanelsLegacy(userId, { sportName: "NFL" });
    const strip = (x: CapperPanels) => withoutLongestStreaks(x);
    check("unfiltered == legacy raw-pick implementation", JSON.stringify(unfiltered) === JSON.stringify(strip(legacyUnfiltered)));
    check("sportName=MLB == legacy", JSON.stringify(sportMlb) === JSON.stringify(strip(legacyMlb)));
    check("sportName=NFL == legacy", JSON.stringify(await getCapperPanels(userId, { sportName: "NFL" })) === JSON.stringify(strip(legacyNfl)));

    // Query shape. The panels must never fetch pick rows: measured from the
    // findMany spy, reset before the legacy calls above.
    const panelPickFetches = seen.slice(0, afterUnfiltered).filter((a) => a?.where && "capperId" in (a.where as object));
    check("unfiltered panels issue no pick.findMany for the history", panelPickFetches.length === 0, `got ${panelPickFetches.length}`);
    const mlbPickFetches = seen.slice(afterUnfiltered, afterMlb).filter((a) => a?.where && "capperId" in (a.where as object));
    check("sportName panels issue no pick.findMany for the history", mlbPickFetches.length === 0, `got ${mlbPickFetches.length}`);

    // Second user: tie / edge cases, compared to the legacy implementation.
    await edgeCases(sportIds);

    // JS streak (computeStats + the shared pick tie-break) vs the SQL streak the
    // /cappers path uses (queryCurrentStreaks: gaps-and-islands over
    // (gameTime, createdAt, id)), for every fixture capper - including Hot Hand,
    // whose MLB and NFL picks tie on gameTime. The JS side is fed the picks in
    // BOTH fetch orders (as returned, and reversed) so the check cannot pass by
    // inheriting whichever row order the table happens to hand back.
    const sqlStreaks = new Map((await queryCurrentStreaks({ userId, windows: ["ALL"] })).map((r) => [r.capperId, r]));
    const allPicks = await originalFindMany({ where: { userId } });
    for (const c of cappers) {
      const mine = allPicks.filter((p) => p.capperId === capperId(c.key));
      const sql = sqlStreaks.get(capperId(c.key));
      for (const [order, ps] of [["as fetched", mine], ["reversed", [...mine].reverse()]] as const) {
        const js = computeStats(ps).currentStreak;
        check(
          `JS currentStreak (${order}) matches SQL streak for ${c.name}`,
          (js.type === "NONE" && !sql) || (!!sql && js.type === sql.type && js.count === sql.count),
          `js=${JSON.stringify(js)} sql=${JSON.stringify(sql)}`
        );
      }
    }

    // Cache keys: distinct per user and per filter, and never the dashboard tag.
    const keys = [
      capperPanelsCacheKey("u1"),
      capperPanelsCacheKey("u2"),
      capperPanelsCacheKey("u1", { sportName: "MLB" }),
      capperPanelsCacheKey("u1", { sportName: "NFL" }),
    ];
        check("cache keys are unique per user and filter", new Set(keys).size === keys.length);
    check("cache keys never equal the dashboard tag", !keys.includes(cacheKeys.dashboard("u1")) && !keys.includes(cacheKeys.dashboard("u2")));
    check("undefined filter and empty filter share a key", capperPanelsCacheKey("u1") === capperPanelsCacheKey("u1", {}));
  } finally {
    (prisma.pick as unknown as { findMany: unknown }).findMany = originalFindMany;
    await prisma.pick.deleteMany({ where: { userId } });
    await prisma.capper.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    if (createdSportIds.length) await prisma.sport.deleteMany({ where: { id: { in: createdSportIds } } });
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
    if (process.exitCode === 2) process.exit(2);
    console.log("\nAll checks passed.");
  });
