// Bulk pick import: batched insert + row cap.
//
// createPicksWithEntitlementCheck used to insert with one tx.pick.create per row
// (N statements over the transaction's single connection, default 5 s timeout).
// It now issues one createManyAndReturn and runs under explicit tx bounds; the
// bulk action refuses an over-cap import before writing anything.
//
// Real-database test (no spies), run with DATABASE_URL set:
//   npx tsx src/server/data/bulk-import-batch-insert-acceptance-test.ts
// Exits non-zero on any failed assertion.
//
// 1. Same rows as the old code: LEGACY below is a verbatim copy of the previous
//    insert loop (per-row create, same stamp). The same batch goes through both
//    for two different users; every stored column must match except the
//    columns that are per-insert by nature (id, userId, capperId, timestamps).
// 2. The returned `created` list is in input order.
// 3. createdAt / id ordering inside a batch (informational + one assertion):
//    a batch now shares one createdAt, so within-batch order for the canonical
//    (gameTime, createdAt, id) tie-break falls to id; assert id order == input
//    order so that tie-break is unchanged.
// 4. A 1,000-row import completes well inside the transaction timeout.
// 5. Free-plan limit rejection still inserts nothing (atomic), incl. at scale.
// 6. The row cap refuses cleanly: helper, and the real action with nothing
//    written (dev-auth-bypass user, so no Supabase).
import { prisma } from "@/lib/prisma";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { createPicksWithEntitlementCheck, type PickInsertData } from "@/server/data/subscriptions";
import { FREE_PICK_LIMIT } from "@/lib/entitlements";
import { MAX_IMPORT_ROWS, importRowCapError } from "@/lib/import-limits";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const TAG = `bib-${Date.now()}`;
const GAME_BASE = new Date("2026-06-01T17:00:00.000Z").getTime();

// ---- LEGACY: the previous insert loop, copied verbatim (minus the entitlement check) ----
async function legacyInsert(userId: string, rows: PickInsertData[]) {
  return prisma.$transaction(async (tx) => {
    const sports = await tx.sport.findMany({
      where: { id: { in: Array.from(new Set(rows.map((r) => r.sportId))) } },
      select: { id: true, name: true },
    });
    const sportNameById = new Map(sports.map((s) => [s.id, s.name]));
    const created = await Promise.all(
      rows.map((row) => {
        const sportName = sportNameById.get(row.sportId);
        const stamp = sportName
          ? {
              category: pickCategory({
                betType: row.betType,
                period: row.period ?? "FULL_GAME",
                betDetail: row.betDetail ?? null,
                odds: row.odds,
                line: row.line ?? null,
                sportName,
                pickedSide: row.pickedSide ?? null,
                mlFavoredSide: row.mlFavoredSide ?? null,
                propMarket: row.propMarket ?? null,
              }),
              categoryVersion: PICK_CATEGORY_VERSION,
            }
          : {};
        return tx.pick.create({ data: { ...row, userId, status: "PENDING", ...stamp }, select: { id: true } });
      })
    );
    return { allowed: true as const, created };
  });
}

// Deterministic, varied batch: several sports and bet types, favourites and dogs,
// spreads +/-, totals with and without over/under text (=> null category),
// periods, props, NRFI, ties on gameTime, optional fields present and absent.
function makeRows(n: number, capperId: string, sportIds: { mlb: string; nfl: string }, label: string): PickInsertData[] {
  const rows: PickInsertData[] = [];
  for (let i = 0; i < n; i++) {
    const mlb = i % 2 === 0;
    const sportId = mlb ? sportIds.mlb : sportIds.nfl;
    const base = {
      capperId,
      sportId,
      homeTeam: "Home " + (i % 17),
      awayTeam: "Away " + (i % 13),
      units: 0.5 + (i % 4) * 0.5,
      gameTime: new Date(GAME_BASE + (i % 7) * 3600000), // ties on purpose
    };
    switch (i % 9) {
      case 0:
        rows.push({ ...base, betType: "MONEYLINE", betDetail: `${label}#${i} ML fav`, odds: -150 - (i % 5), pickedSide: "HOME", mlFavoredSide: "HOME" });
        break;
      case 1:
        rows.push({ ...base, betType: "MONEYLINE", betDetail: `${label}#${i} ML dog`, odds: 130 + (i % 5), pickedSide: "AWAY", mlFavoredSide: "HOME" });
        break;
      case 2:
        rows.push({ ...base, betType: "SPREAD", betDetail: `${label}#${i} Home -3.5`, odds: -110, line: -3.5 });
        break;
      case 3:
        rows.push({ ...base, betType: "SPREAD", betDetail: `${label}#${i} Away +2.5`, odds: -105, line: 2.5, sportsbook: "Book" });
        break;
      case 4:
        rows.push({ ...base, betType: "TOTAL", betDetail: `${label}#${i} Over 8.5`, odds: -110, line: 8.5 });
        break;
      case 5:
        rows.push({ ...base, betType: "TOTAL", betDetail: `${label}#${i} Under 47.5`, odds: -115, line: 47.5, period: "FIRST_HALF" });
        break;
      case 6:
        rows.push({ ...base, betType: "TOTAL", betDetail: `${label}#${i} no side text`, odds: -110 }); // null category
        break;
      case 7:
        rows.push({ ...base, betType: "PLAYER_PROP", betDetail: `${label}#${i} Player Anytime TD`, odds: 120, playerName: "Player", propMarket: "TD" });
        break;
      default:
        rows.push({ ...base, betType: "NRFI", betDetail: `${label}#${i} NRFI`, odds: -120, gameNumber: i % 3 === 0 ? 2 : null });
    }
  }
  return rows;
}

const STORED_COLUMNS_TO_COMPARE = [
  "sportId", "leagueId", "homeTeam", "awayTeam", "betType", "betDetail", "odds", "sportsbook", "units", "gameTime", "notes",
  "status", "line", "period", "gradedAt", "gradedViaFuzzyMatch", "pickedSide", "mlFavoredSide", "playerName", "propMarket",
  "gameNumber", "category", "categoryVersion",
] as const;

async function main() {
  const userIds: string[] = [];
  const mkUser = async (suffix: string, plan?: "BASIC") => {
    const u = await prisma.user.create({ data: { supabaseId: `${TAG}-${suffix}`, email: `${TAG}-${suffix}@example.test` } });
    userIds.push(u.id);
    if (plan) await prisma.subscription.create({ data: { userId: u.id, plan, status: "active" } });
    const capper = await prisma.capper.create({ data: { userId: u.id, name: "cap-" + suffix, source: "OTHER" } });
    return { user: u, capper };
  };

  const createdSports: string[] = [];
  const sport = async (name: string) => {
    const existing = await prisma.sport.findFirst({ where: { name } });
    if (existing) return existing.id;
    const s = await prisma.sport.create({ data: { name } });
    createdSports.push(s.id);
    return s.id;
  };

  try {
    const sportIds = { mlb: await sport("MLB"), nfl: await sport("NFL") };
    const A = await mkUser("legacy");
    const B = await mkUser("new");

    // ---- 1. identical stored rows, old vs new ----
    const N = 45;
    const legacyRows = makeRows(N, A.capper.id, sportIds, "L");
    const newRows = makeRows(N, B.capper.id, sportIds, "L"); // same labels, same order, other user/capper
    await legacyInsert(A.user.id, legacyRows);
    const res = await createPicksWithEntitlementCheck(B.user.id, newRows);
    check("normal import allowed", res.allowed === true);
    if (!res.allowed) throw new Error("unexpected rejection");
    check(`normal import returns ${N} created ids`, res.created.length === N, String(res.created.length));

    const load = (userId: string) => prisma.pick.findMany({ where: { userId } });
    const [oldStored, newStored] = await Promise.all([load(A.user.id), load(B.user.id)]);
    const bySeq = (rows: typeof oldStored) => new Map(rows.map((r) => [r.betDetail, r]));
    const oldBy = bySeq(oldStored);
    const newBy = bySeq(newStored);
    check("same number of rows stored", oldStored.length === N && newStored.length === N, `${oldStored.length}/${newStored.length}`);
    let mismatches = 0;
    let stamped = 0;
    let nullCategory = 0;
    for (const [detail, o] of oldBy) {
      const n = newBy.get(detail);
      if (!n) {
        mismatches++;
        continue;
      }
      for (const col of STORED_COLUMNS_TO_COMPARE) {
        if (JSON.stringify(o[col]) !== JSON.stringify(n[col])) {
          mismatches++;
          console.log(`  differs: ${detail} ${col}: old=${JSON.stringify(o[col])} new=${JSON.stringify(n[col])}`);
        }
      }
      if (n.categoryVersion === PICK_CATEGORY_VERSION) stamped++;
      if (n.category === null) nullCategory++;
    }
    check(`every compared column identical for all ${N} rows (${STORED_COLUMNS_TO_COMPARE.length} columns each)`, mismatches === 0, `${mismatches} mismatches`);
    check("every new row is stamped at PICK_CATEGORY_VERSION", stamped === N, `${stamped}/${N}`);
    check("the batch exercises a null category and several distinct categories", nullCategory > 0 && new Set(newStored.map((r) => r.category)).size >= 5, `null=${nullCategory}, distinct=${new Set(newStored.map((r) => r.category)).size}`);

    // ---- 2. created ids come back in input order ----
    const byId = new Map(newStored.map((r) => [r.id, r]));
    const returnedOrder = res.created.map((c) => byId.get(c.id)?.betDetail);
    check("created[] is in input order", JSON.stringify(returnedOrder) === JSON.stringify(newRows.map((r) => r.betDetail)));

    // ---- 3. within-batch tie-break ----
    const distinctCreated = new Set(newStored.map((r) => r.createdAt.getTime())).size;
    const legacyDistinctCreated = new Set(oldStored.map((r) => r.createdAt.getTime())).size;
    console.log(`INFO: distinct createdAt values in a ${N}-row batch: legacy=${legacyDistinctCreated}, new=${distinctCreated}`);
    const canonical = [...newStored].sort(
      (a, b) => a.gameTime.getTime() - b.gameTime.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const inputOrderWithinGameTime = [...newRows]
      .map((r, i) => ({ d: r.betDetail, t: r.gameTime.getTime(), i }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map((x) => x.d);
    check(
      "canonical (gameTime, createdAt, id) order within a batch still follows input order",
      JSON.stringify(canonical.map((r) => r.betDetail)) === JSON.stringify(inputOrderWithinGameTime)
    );

    // ---- 4. large import ----
    const big = await mkUser("big", "BASIC");
    const bigRows = makeRows(1000, big.capper.id, sportIds, "B");
    const t0 = Date.now();
    const bigRes = await createPicksWithEntitlementCheck(big.user.id, bigRows);
    const bigMs = Date.now() - t0;
    check("1,000-row import allowed", bigRes.allowed === true);
    const bigCount = await prisma.pick.count({ where: { userId: big.user.id } });
    check("1,000 rows stored, all stamped", bigCount === 1000 && (await prisma.pick.count({ where: { userId: big.user.id, categoryVersion: PICK_CATEGORY_VERSION } })) === 1000, String(bigCount));
    console.log(`INFO: 1,000-row batch insert (new): ${bigMs} ms`);
    check("1,000-row import finishes far inside the 15 s transaction timeout", bigMs < 10000, `${bigMs} ms`);

    const legacyBig = await mkUser("legacybig", "BASIC");
    const l0 = Date.now();
    await legacyInsert(legacyBig.user.id, makeRows(1000, legacyBig.capper.id, sportIds, "B"));
    console.log(`INFO: 1,000-row batch insert (legacy, per-row creates): ${Date.now() - l0} ms (local DB, ~sub-ms round trips)`);

    // ---- 5. Free-limit rejection is atomic ----
    const free = await mkUser("free");
    const tooMany = makeRows(FREE_PICK_LIMIT + 1, free.capper.id, sportIds, "F");
    const rej = await createPicksWithEntitlementCheck(free.user.id, tooMany);
    check("over the Free limit -> rejected", rej.allowed === false);
    check("...and nothing was inserted", (await prisma.pick.count({ where: { userId: free.user.id } })) === 0);

    // ---- 6. row cap ----
    check(`cap constant is ${MAX_IMPORT_ROWS}; at-cap is accepted`, importRowCapError(MAX_IMPORT_ROWS) === null);
    const msg = importRowCapError(MAX_IMPORT_ROWS + 1);
    check("cap+1 is refused with a clear message", !!msg && msg.includes(String(MAX_IMPORT_ROWS + 1)) && msg.includes("Nothing was imported"), String(msg));

    // The real action, as the dev-bypass user (NODE_ENV/DEV_AUTH_BYPASS are read per call).
    const env = process.env as Record<string, string | undefined>;
    const saved = { NODE_ENV: env.NODE_ENV, DEV_AUTH_BYPASS: env.DEV_AUTH_BYPASS };
    env.NODE_ENV = "development";
    env.DEV_AUTH_BYPASS = "true";
    const marker = `${TAG}-capper-should-not-exist`;
    try {
      // The action module pulls in server/auth.ts, which wraps getCurrentUser in
      // React's server-only cache(); plain Node's React has none, so shim it (identity).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const react = require("react") as { cache?: unknown };
      react.cache ??= <T,>(fn: T) => fn;
      const { bulkImportPicksAction } = await import("@/server/actions/bulk-picks");
      const overCap = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
        capperName: marker,
        sportName: "MLB",
        description: "Home -1.5 #" + i,
        betType: "SPREAD" as const,
        odds: -110,
        hasExplicitOdds: true,
        teamNicknames: [] as string[],
        units: 1,
        period: "FULL_GAME" as const,
      }));
      const before = await prisma.pick.count();
      const out = await bulkImportPicksAction(overCap as never);
      check("action refuses an over-cap import", out.success === false && /limited to/.test((out as { error: string }).error), JSON.stringify(out).slice(0, 200));
      check("...and wrote nothing (no picks, no capper created)", (await prisma.pick.count()) === before && (await prisma.capper.count({ where: { name: marker } })) === 0);
    } finally {
      env.NODE_ENV = saved.NODE_ENV;
      env.DEV_AUTH_BYPASS = saved.DEV_AUTH_BYPASS;
      const dev = await prisma.user.findFirst({ where: { supabaseId: "dev-local-bypass" } });
      if (dev && dev.createdAt.getTime() >= Date.now() - 600000) userIds.push(dev.id);
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (createdSports.length) await prisma.sport.deleteMany({ where: { id: { in: createdSports } } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} assertion(s) failed`);
      process.exit(1);
    }
    console.log("\nAll assertions passed");
  });
