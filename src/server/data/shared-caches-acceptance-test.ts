// Proof for the shared caches added in front of the layout's feature-flag
// lookups, the /cappers bundle, the capper-detail bundle and the capper roster
// with pick counts.
//
// What can be proven without a Next request context (cachedByTag just runs its
// callback under bare tsx):
//   1. The flag snapshot gives the same answer as isFeatureEnabledForUser for
//      every flag state x user, and the snapshot loader is ONE findMany.
//   2. The cache keys carry every input that changes a result (a key that
//      ignored a filter would serve one filter's page for another).
//   3. Each cached read is tagged with the user's dashboard tag, uncacheable
//      inputs (search text, a pinned `now`) bypass the cache, and the layout
//      uses the snapshot while the gated routes keep the direct check.
//   4. Every action that creates, renames, merges, deletes or favorites a
//      capper, or changes a pick, revalidates that tag.
//
// Pure: the prisma singleton's featureFlag methods are swapped for spies. Run with:
//   npx tsx src/server/data/shared-caches-acceptance-test.ts
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import {
  getNavFeatureFlags,
  isEnabledInSnapshot,
  isFeatureEnabledForUser,
  loadFeatureFlagSnapshot,
} from "@/server/data/feature-flags";
import { cappersPageCacheParams, type CappersPageQuery } from "@/server/data/cappers-page-aggregates";
import { capperPageCacheParams } from "@/server/data/capper-detail";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

type FlagRow = { key: string; enabled: boolean; overrides: { userId: string; enabled: boolean }[] };
const FLAGS: FlagRow[] = [
  { key: "off_no_overrides", enabled: false, overrides: [] },
  { key: "off_admin_on", enabled: false, overrides: [{ userId: "admin", enabled: true }] },
  { key: "off_admin_override_disabled", enabled: false, overrides: [{ userId: "admin", enabled: false }] },
  { key: "on_globally", enabled: true, overrides: [] },
  { key: "on_globally_admin_override_disabled", enabled: true, overrides: [{ userId: "admin", enabled: false }] },
  { key: "off_two_users", enabled: false, overrides: [{ userId: "admin", enabled: true }, { userId: "tester", enabled: true }] },
];
const USERS = ["admin", "tester", "nobody"];

const ff = (prisma as unknown as { featureFlag: Record<string, unknown> }).featureFlag;
const original = { findUnique: ff.findUnique, findMany: ff.findMany };
let findUniqueCalls = 0;
let findManyCalls = 0;
let lastFindManyArgs: unknown = null;

// The direct path: findUnique({ where: { key }, include: { userOverrides: { where: { userId } } } }).
ff.findUnique = async (args: { where: { key: string }; include: { userOverrides: { where: { userId: string } } } }) => {
  findUniqueCalls++;
  const flag = FLAGS.find((f) => f.key === args.where.key);
  if (!flag) return null;
  const userId = args.include.userOverrides.where.userId;
  return { key: flag.key, enabled: flag.enabled, userOverrides: flag.overrides.filter((o) => o.userId === userId) };
};
// The snapshot path: findMany({ select: { key, enabled, userOverrides: { where: { enabled: true }, select: { userId } } } }).
ff.findMany = async (args: { select: { userOverrides: { where: { enabled: boolean } } } }) => {
  findManyCalls++;
  lastFindManyArgs = args;
  const onlyEnabled = args.select.userOverrides.where.enabled;
  return FLAGS.map((f) => ({
    key: f.key,
    enabled: f.enabled,
    userOverrides: f.overrides.filter((o) => o.enabled === onlyEnabled).map((o) => ({ userId: o.userId })),
  }));
};

async function main() {
  // ---- 1. Snapshot parity with the direct check ----
  {
    const snapshot = await loadFeatureFlagSnapshot();
    expect("snapshot loader is one findMany", findManyCalls, 1);
    expect(
      "snapshot loader asks only for enabled overrides, and only their user ids",
      (lastFindManyArgs as { select: { userOverrides: unknown } }).select.userOverrides,
      { where: { enabled: true }, select: { userId: true } }
    );
    let mismatches = 0;
    let n = 0;
    for (const key of [...FLAGS.map((f) => f.key), "no_such_flag"]) {
      for (const userId of USERS) {
        n++;
        if (isEnabledInSnapshot(snapshot, key, userId) !== (await isFeatureEnabledForUser(key, userId))) mismatches++;
      }
    }
    expect(`snapshot answer === direct answer across ${n} flag x user combinations`, mismatches, 0);
    expect("unknown flag fails closed", isEnabledInSnapshot(snapshot, "no_such_flag", "admin"), false);
    expect("override grants only that user", [isEnabledInSnapshot(snapshot, "off_admin_on", "admin"), isEnabledInSnapshot(snapshot, "off_admin_on", "nobody")], [true, false]);
    expect("a disabled override grants nothing", isEnabledInSnapshot(snapshot, "off_admin_override_disabled", "admin"), false);
    expect("global on wins for everyone", USERS.map((u) => isEnabledInSnapshot(snapshot, "on_globally", u)), [true, true, true]);
    expect("the snapshot is plain JSON", JSON.parse(JSON.stringify(snapshot)), snapshot);

    // The layout's call: N keys, one snapshot read, results in key order.
    const before = [findManyCalls, findUniqueCalls];
    const nav = await getNavFeatureFlags(["off_admin_on", "on_globally", "no_such_flag"], "admin");
    expect("getNavFeatureFlags: one result per key, in order", nav, [true, true, false]);
    expect("getNavFeatureFlags: one snapshot read, no per-flag query", [findManyCalls - before[0], findUniqueCalls - before[1]], [1, 0]);
  }

  // ---- 2. Cache keys carry every input ----
  {
    const base: CappersPageQuery = { userId: "u1", window: "ALL", league: undefined, min: 0, sort: "roi", fav: false, q: "", page: 1 };
    const variants: Partial<CappersPageQuery>[] = [
      { window: "LAST_30" },
      { league: "MLB" },
      { min: 10 },
      { sort: "netUnits" as CappersPageQuery["sort"] },
      { fav: true },
      { page: 2 },
    ];
    const baseKey = cappersPageCacheParams(base);
    expect(
      "/cappers key changes with window, league, min, sort, fav and page",
      variants.map((v) => cappersPageCacheParams({ ...base, ...v }) !== baseKey),
      variants.map(() => true)
    );
    expect("/cappers key is stable for equal filters", cappersPageCacheParams({ ...base }), baseKey);
    expect(
      "/cappers key: different users never share an entry",
      cacheKeys.cappersPage("u1", baseKey) === cacheKeys.cappersPage("u2", baseKey),
      false
    );

    const p = { sport: undefined as string | undefined, window: "ALL" as const, recentLimit: 10 };
    const pk = capperPageCacheParams(p);
    expect(
      "capper page key changes with sport, window and recent limit",
      [
        capperPageCacheParams({ ...p, sport: "MLB" }) !== pk,
        capperPageCacheParams({ ...p, window: "LAST_30" as never }) !== pk,
        capperPageCacheParams({ ...p, recentLimit: 20 }) !== pk,
      ],
      [true, true, true]
    );
    expect(
      "capper page key: different cappers and users never share an entry",
      [cacheKeys.capperPage("u1", "c1", pk) === cacheKeys.capperPage("u1", "c2", pk), cacheKeys.capperPage("u1", "c1", pk) === cacheKeys.capperPage("u2", "c1", pk)],
      [false, false]
    );
  }

  // ---- 3. Source: tags, bypasses, and who uses which flag read ----
  const src = (p: string) => readFileSync(p, "utf8");
  {
    const cappersPage = src("src/server/data/cappers-page-aggregates.ts");
    const loader = cappersPage.slice(cappersPage.indexOf("async function loadCappersPageBundle"), cappersPage.indexOf("export async function getCappersPageData"));
    expect("/cappers bundle is tagged with the user's dashboard tag", /cacheKeys\.dashboard\(q\.userId\)/.test(loader), true);
    expect("/cappers bundle: a search or a pinned now is not cached", /if \(q\.q !== "" \|\| q\.now\) return run\(\);/.test(loader), true);

    const detail = src("src/server/data/capper-detail.ts");
    const fn = detail.slice(detail.indexOf("export async function getCapperPageData"), detail.indexOf("function queryCapperPageBundle"));
    expect("capper bundle is tagged with the user's dashboard tag", /cacheKeys\.dashboard\(userId\)/.test(fn), true);
    expect("capper bundle: a pinned now is not cached", /const \{ bundle, nowMs \} = now\s*\?\s*await load\(\)/.test(fn), true);
    expect("capper bundle is mapped with the instant it was built for", /capperPageFromBundle\(bundle, params, new Date\(nowMs\)\)/.test(fn), true);

    const cappers = src("src/server/data/cappers.ts");
    const roster = cappers.slice(cappers.indexOf("export async function getCappersWithPickCounts"), cappers.indexOf("async function loadCappersWithPickCounts"));
    expect("capper roster is tagged with the user's dashboard tag", /cacheKeys\.dashboard\(userId\)/.test(roster), true);

    const layout = src("src/app/(app)/layout.tsx");
    expect("layout reads flags from the shared snapshot only", [/getNavFeatureFlags\(/.test(layout), /isFeatureEnabledForUser/.test(layout)], [true, false]);
    for (const page of ["src/app/(app)/zone-model/page.tsx", "src/app/(app)/admin/import-skipped-lines/page.tsx"]) {
      const s = src(page);
      expect(`${page}: the gate itself stays the direct, uncached check`, [/isFeatureEnabledForUser\(/.test(s), /getNavFeatureFlags/.test(s)], [true, false]);
    }
  }

  // ---- 4. Every capper / pick mutation revalidates the tag these reads carry ----
  {
    const actions = src("src/server/actions/cappers.ts");
    const names = ["createCapperAction", "mergeCappersAction", "renameCapperAction", "deleteCapperAction", "toggleFavoriteCapperAction"];
    for (let i = 0; i < names.length; i++) {
      const start = actions.indexOf("export async function " + names[i]);
      const next = actions.indexOf("export async function ", start + 10);
      const body = actions.slice(start, next < 0 ? undefined : next);
      expect(`${names[i]} revalidates the dashboard tag`, /revalidatePickStats\(user\.id\)/.test(body), true);
    }
    const bulk = src("src/server/actions/bulk-picks.ts");
    for (const name of ["bulkImportPicksAction", "bulkImportParlaysAction"]) {
      const start = bulk.indexOf("export async function " + name);
      const next = bulk.indexOf("\nexport ", start + 10);
      const body = bulk.slice(start, next < 0 ? undefined : next);
      expect(`${name} revalidates the dashboard tag`, /revalidateTag\(cacheKeys\.dashboard\(user\.id\)\)/.test(body), true);
    }
    const picks = src("src/server/actions/picks.ts");
    expect(
      "pick create / status / delete actions revalidate the dashboard tag",
      (picks.match(/revalidatePickStats\(user\.id\)/g) ?? []).length >= 3,
      true
    );
    expect(
      "the grade-picks cron revalidates the dashboard tag per changed user",
      /revalidateTag\(cacheKeys\.dashboard\(userId\)\)/.test(src("src/app/api/cron/grade-picks/route.ts")),
      true
    );
  }

  ff.findUnique = original.findUnique;
  ff.findMany = original.findMany;
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
  process.exit(0);
}

main();
