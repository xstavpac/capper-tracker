// PR 1a parity proof: the import pipeline was moved out of the "use server" action
// (actions/bulk-picks.ts) into server/data/bulk-import-core.ts. This runs the SAME fixture text through
//   A) the ORIGINAL bulkImportPicksAction, read out of git at commit fa12b30 (the last commit before the
//      extraction) with only requireUser / next/cache stubbed,
//   B) the extracted importPicksForUser, fed the same items, and
//   C) the new non-interactive orchestrator runCatalogImportForUser, fed the raw text,
// each under its own throwaway user, and asserts identical inserted picks, skipped-line log and ImportRun.
//
// DB-backed and writes fixtures: runs only against a LOCAL database, and skips when the local DB already has a
// real NFL odds snapshot for today. Every row is deleted by id. Run with:
//   npx tsx src/server/data/bulk-import-parity-acceptance-test.ts
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import type { OddsGame } from "@/server/data/odds";

const LEGACY_COMMIT = "fa12b30";
const PREFIX = "__Parity__";
const H = 3600000;

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
let currentUser = "";
stub("../auth", { requireUser: async () => ({ id: currentUser }) });
stub("next/cache", { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn });

const isLocal = (url: string | undefined) => /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url ?? "");

const FIXTURE = [
  "Parity Pete",
  "Chiefs ML",
  "Bills -3 -110",
  "Over 44.5 Lions/Bears",
  "Chiefs ML", // same pick twice in one paste: the in-paste duplicate rule decides
  "zzqq nonsense line 99",
].join("\n");

async function main() {
  if (!isLocal(process.env.DATABASE_URL)) {
    console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures.");
    return;
  }
  const { prisma } = await import("@/lib/prisma");
  const { easternDateKey } = await import("@/lib/dates");
  const todayKey = easternDateKey(new Date());
  if (await prisma.oddsSnapshot.findUnique({ where: { sportKey_fetchDate: { sportKey: "americanfootball_nfl", fetchDate: todayKey } } })) {
    console.log(`SKIP: a real NFL odds snapshot for ${todayKey} exists locally - not overwriting it.`);
    return;
  }

  // The original action, from git, with its imports unchanged (so it resolves the same modules).
  let legacySource: string;
  try {
    legacySource = execFileSync("git", ["show", `${LEGACY_COMMIT}:src/server/actions/bulk-picks.ts`], { encoding: "utf8", maxBuffer: 1 << 26 });
  } catch {
    console.log(`SKIP: commit ${LEGACY_COMMIT} is not available in this checkout (shallow clone?).`);
    return;
  }
  const legacyPath = join(process.cwd(), "src", "server", "actions", "legacy-bulk-picks.generated.ts");
  writeFileSync(legacyPath, legacySource);

  const NOW = Date.now();
  const board = [
    ["Kansas City Chiefs", "Los Angeles Chargers"],
    ["Buffalo Bills", "Miami Dolphins"],
    ["Detroit Lions", "Chicago Bears"],
  ].map(([home, away], i) => ({
    id: `${PREFIX}g${i}`,
    sportKey: "americanfootball_nfl",
    sport_title: "NFL",
    homeTeam: home,
    awayTeam: away,
    commenceTime: new Date(NOW + (3 + i) * H).toISOString(),
    bookmakers: [
      {
        key: "fanduel",
        title: "FanDuel",
        last_update: new Date(NOW).toISOString(),
        markets: [
          { key: "h2h", outcomes: [{ name: home, price: -150 }, { name: away, price: 130 }] },
          { key: "spreads", outcomes: [{ name: home, price: -110, point: -3 }, { name: away, price: -110, point: 3 }] },
          { key: "totals", outcomes: [{ name: "Over", price: -110, point: 44.5 }, { name: "Under", price: -110, point: 44.5 }] },
        ],
      },
    ],
  })) as unknown as OddsGame[];
  const snapId = `${PREFIX}snap`;
  const users = { legacy: `${PREFIX}legacy`, core: `${PREFIX}core`, orch: `${PREFIX}orch` };
  const existingSport = await prisma.sport.findUnique({ where: { name: "NFL" } });
  let createdSportId: string | null = null;

  try {
    await prisma.oddsSnapshot.create({
      data: { id: snapId, sportKey: "americanfootball_nfl", fetchDate: todayKey, data: board as unknown as Prisma.InputJsonValue },
    });
    if (!existingSport) createdSportId = (await prisma.sport.create({ data: { name: "NFL" } })).id;
    for (const id of Object.values(users)) {
      await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });
    }

    const { parseCatalog } = await import("@/lib/parse-catalog");
    const { bulkImportPicksAction: legacyAction } = (await import(legacyPath)) as typeof import("@/server/actions/bulk-picks");
    const { importPicksForUser } = await import("@/server/data/bulk-import-core");
    const { runCatalogImportForUser } = await import("@/server/data/catalog-import-orchestrator");

    const parsed = parseCatalog(FIXTURE, []);
    const items = parsed.picks.map((p) => ({
      capperName: p.capperName,
      sportName: p.sportName,
      description: p.description,
      betType: p.betType,
      odds: p.odds,
      hasExplicitOdds: p.hasExplicitOdds,
      totalSide: p.totalSide,
      teamNicknames: p.teamNicknames,
      units: p.units,
      period: p.period,
      gameNumber: p.gameNumber,
      raw: p.raw,
      overrideDuplicate: false,
    }));
    expect("fixture parses into picks", items.length >= 3, true);

    currentUser = users.legacy;
    const resA = await legacyAction(items, [], []);
    const resB = await importPicksForUser(users.core, items, [], []);
    const resC = await runCatalogImportForUser(users.orch, FIXTURE, todayKey);

    const normalizeResult = (r: unknown) => JSON.stringify(r);
    expect("A and B return the same result", normalizeResult(resB), normalizeResult(resA));
    expect("C imported through the same pipeline", resC.importResult ? normalizeResult(resC.importResult) : null, normalizeResult(resA));

    const picksOf = async (userId: string) =>
      (
        await prisma.pick.findMany({
          where: { userId },
          select: {
            betType: true, betDetail: true, odds: true, homeTeam: true, awayTeam: true, gameTime: true, pickedSide: true,
            line: true, units: true, period: true, oddsSource: true, mlFavoredSide: true,
            capper: { select: { name: true } }, sport: { select: { name: true } },
          },
          orderBy: [{ betDetail: "asc" }, { betType: "asc" }],
        })
      ).map((p) => JSON.stringify(p));
    const a = await picksOf(users.legacy);
    expect("legacy inserted at least one pick", a.length > 0, true);
    expect("B inserted rows identical to A", await picksOf(users.core), a);
    expect("C inserted rows identical to A", await picksOf(users.orch), a);

    const skippedOf = async (userId: string) =>
      (await prisma.importSkippedLine.findMany({ where: { userId }, select: { stage: true, rawText: true, reason: true, capperName: true }, orderBy: [{ rawText: "asc" }, { stage: "asc" }] })).map((s) => JSON.stringify(s));
    const sa = await skippedOf(users.legacy);
    expect("B skipped-line log identical to A", await skippedOf(users.core), sa);
    // C also logs the parse-time unresolved line, which A/B were never given (the form logs that separately);
    // every line A logged is in C's log, and the extra ones are parse-stage only.
    const sc = await prisma.importSkippedLine.findMany({ where: { userId: users.orch }, select: { stage: true, rawText: true, reason: true, capperName: true } });
    const scStrings = sc.map((s) => JSON.stringify(s));
    expect("C log contains every line A logged", sa.every((s) => scStrings.includes(s)), true);
    expect(
      "C's extra lines are parse-stage only",
      sc.filter((s) => !sa.includes(JSON.stringify(s))).every((s) => ["PARSE_SILENT", "PARSE_UNRESOLVED", "PROP_UNSUPPORTED", "RECOVERY_UNRESOLVED"].includes(s.stage)),
      true
    );

    const runOf = async (userId: string) => {
      const r = await prisma.importRun.findMany({
        where: { userId },
        select: { itemsSubmitted: true, picksInserted: true, skipped: true, fallbackUnmatched: true, ambiguousAuto: true, ambiguousAsked: true },
      });
      return r.map((x) => JSON.stringify(x));
    };
    const ra = await runOf(users.legacy);
    expect("one ImportRun for A", ra.length, 1);
    expect("B ImportRun identical to A", await runOf(users.core), ra);
    expect("C ImportRun identical to A", await runOf(users.orch), ra);
  } finally {
    if (existsSync(legacyPath)) unlinkSync(legacyPath);
    const ids = Object.values(users);
    await prisma.importSkippedLine.deleteMany({ where: { userId: { in: ids } } });
    await prisma.importRun.deleteMany({ where: { userId: { in: ids } } });
    await prisma.pick.deleteMany({ where: { userId: { in: ids } } });
    await prisma.capper.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.oddsSnapshot.deleteMany({ where: { id: snapId } });
    if (createdSportId) await prisma.sport.deleteMany({ where: { id: createdSportId } });
    await prisma.$disconnect();
  }
  if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log("ALL PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
