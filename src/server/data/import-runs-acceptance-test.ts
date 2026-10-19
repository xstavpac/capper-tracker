// Imports tab against a real database: recordImportRun writes one import_runs
// row (ambiguity log validated, no-matched-game picks kept), and the page's one
// statement and the combined status statement read it back together with the
// skipped lines in the window.
//
// Seeded under its own user: two import runs (one with a fallback pick and an
// ambiguity log with a junk entry), an alerting skipped line, a listed-only
// one, and one older than the window. The local DB is shared, so window
// totals are checked as "at least ours". Everything is deleted by id.
//
// DB-backed (runs when DATABASE_URL is set). Run with:
//   npx tsx src/server/data/import-runs-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { loadImportsView, recordImportRun } from "@/server/data/import-runs";
import { loadAdminStatus } from "@/server/data/admin-status";
import { IMPORT_WINDOW_HOURS } from "@/lib/admin-thresholds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const PREFIX = "__ImportRuns__";
const H = 3600000;

async function main() {
  const now = new Date();
  const userId = `${PREFIX}user`;
  const lineIds = { alert: `${PREFIX}line-alert`, listed: `${PREFIX}line-listed`, old: `${PREFIX}line-old` };
  const fallbackPickId = `${PREFIX}pick-fallback`; // only stored as text in the run row
  let runIds: string[] = [];

  try {
    await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}user@example.invalid` } });

    await recordImportRun({
      userId,
      itemsSubmitted: 5,
      picksInserted: 4,
      skipped: 1,
      fallbackPicks: [{ pickId: fallbackPickId, sport: "KBO", betDetail: "Ir Doosan Bears ML" }],
      ambiguity: [
        { key: "ircardinals", sport: "MLB", method: "schedule", count: 2 },
        { key: "irgiants", sport: "NFL", method: "user", count: 1 },
        { key: "irjunk", sport: "NFL", method: "guess", count: 1 }, // dropped
      ],
    });
    await recordImportRun({ userId, itemsSubmitted: 3, picksInserted: 0, skipped: 3, fallbackPicks: [], ambiguity: "not a log" });
    const runs = await prisma.importRun.findMany({ where: { userId }, orderBy: { itemsSubmitted: "desc" } });
    runIds = runs.map((r) => r.id);
    expect("two runs recorded", runs.length, 2);
    const [first, second] = runs;
    expect(
      "run 1: counts, fallback pick, ambiguity split auto/asked, junk entry dropped",
      [first.itemsSubmitted, first.picksInserted, first.skipped, first.fallbackUnmatched, first.ambiguousAuto, first.ambiguousAsked, (first.ambiguity as unknown[]).length],
      [5, 4, 1, 1, 2, 1, 2]
    );
    // jsonb reorders keys, so compare field by field.
    const stored = (first.fallbackPicks as { pickId: string; sport: string; betDetail: string }[] | null) ?? [];
    expect("run 1: fallback pick stored", stored.map((f) => [f.pickId, f.sport, f.betDetail]), [[fallbackPickId, "KBO", "Ir Doosan Bears ML"]]);
    expect("run 2: no fallback / ambiguity -> SQL NULL, zero counts", [second.fallbackPicks, second.ambiguity, second.fallbackUnmatched, second.ambiguousAuto], [null, null, 0, 0]);

    const line = (id: string, stage: "GAME_UNMATCHED" | "PARSE_SILENT", createdAt: Date) => ({
      id,
      userId,
      capperName: `${PREFIX} Capper`,
      rawText: `${id} raw`,
      guessedSport: "MLB",
      stage,
      reason: stage === "GAME_UNMATCHED" ? "No scheduled game matched" : "Read as a capper header but looks like a pick",
      createdAt,
    });
    await prisma.importSkippedLine.createMany({
      data: [
        line(lineIds.alert, "GAME_UNMATCHED", new Date(now.getTime() - 1 * H)),
        line(lineIds.listed, "PARSE_SILENT", new Date(now.getTime() - 2 * H)),
        line(lineIds.old, "GAME_UNMATCHED", new Date(now.getTime() - (IMPORT_WINDOW_HOURS + 2) * H)),
      ],
    });

    const view = await loadImportsView(new Date());
    expect("window run totals include ours", [view.runs.runs >= 2, view.runs.items >= 8, view.runs.inserted >= 4, view.runs.fallback >= 1, view.runs.ambiguousAuto >= 2, view.runs.ambiguousAsked >= 1], [true, true, true, true, true, true]);
    expect("by stage counts ours", [(view.byStage.find((s) => s.stage === "GAME_UNMATCHED")?.count ?? 0) >= 1, (view.byStage.find((s) => s.stage === "PARSE_SILENT")?.count ?? 0) >= 1], [true, true]);
    const shownIds = view.lines.map((l) => l.id);
    expect("lines: the alerting and the listed line shown, the old one not", [shownIds.includes(lineIds.alert), shownIds.includes(lineIds.listed), shownIds.includes(lineIds.old)], [true, true, false]);
    const alertLine = view.lines.find((l) => l.id === lineIds.alert);
    expect("line row shape: dates parsed, fields carried", [alertLine?.createdAt instanceof Date, alertLine?.rawText, alertLine?.capperName], [true, `${lineIds.alert} raw`, `${PREFIX} Capper`]);
    expect("lines newest first", view.lines.every((l, i) => i === 0 || view.lines[i - 1].createdAt.getTime() >= l.createdAt.getTime()), true);
    expect("fallback pick listed", view.fallbackPicks.some((f) => f.pickId === fallbackPickId && f.sport === "KBO" && f.betDetail === "Ir Doosan Bears ML"), true);
    expect("fallback picks carry no extra fields", Object.keys(view.fallbackPicks.find((f) => f.pickId === fallbackPickId) ?? {}).sort(), ["betDetail", "pickId", "sport"]);
    expect("ambiguity aggregated, junk absent", [view.ambiguity.some((a) => a.key === "ircardinals" && a.method === "schedule" && a.count >= 2), view.ambiguity.some((a) => a.key === "irgiants" && a.method === "user"), view.ambiguity.some((a) => a.key === "irjunk")], [true, true, false]);

    const alerts = await loadAdminStatus();
    expect("combined status statement: imports dot on (ours alone trip it), not a failed check", [!!alerts.imports, (alerts.imports ?? "").startsWith("Status check failed")], [true, false]);
    expect("dot reason names the window", (alerts.imports ?? "").endsWith(`in the last ${IMPORT_WINDOW_HOURS}h`), true);
  } finally {
    await prisma.importSkippedLine.deleteMany({ where: { id: { in: Object.values(lineIds) }, userId } });
    if (runIds.length) await prisma.importRun.deleteMany({ where: { id: { in: runIds }, userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    const left = await prisma.importRun.count({ where: { userId } });
    console.log(`cleanup: seeded rows deleted by id (import runs left: ${left})`);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nImport runs DB checks passed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
