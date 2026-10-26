// Bug reports against a real database: the submit flow writes a bug_reports
// row through the real data module (storage faked - no Supabase), the admin
// tab's list reads it back (open first, newest first, path only), the DB-counted
// rate limit trips on the 6th report, the text-only fallback stores a row with
// no path, and resolving clears the path and flips the status. A second user's
// reports never count against the first's limit. Deleting the user removes its
// reports (cascade).
//
// Own users, everything deleted by id. DB-backed (runs when DATABASE_URL is
// set; SKIP otherwise). Run with:
//   npx tsx src/server/data/bug-reports-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { insertBugReport, listBugReportsForAdmin, markBugReportResolved, recentBugReportActivity } from "@/server/data/bug-reports";
import { submitBugReport, type BugReportDeps } from "@/server/bug-reports/submit";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const PREFIX = "__BugReport__";
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP: DATABASE_URL not set");
    return;
  }
  const userA = `${PREFIX}userA`;
  const userB = `${PREFIX}userB`;
  const uploaded: string[] = [];
  const removed: string[] = [];
  let clock = Date.now();
  let seq = 0;
  let configured = true;

  const deps: BugReportDeps = {
    now: () => new Date(clock),
    newId: () => `${PREFIX}rep${++seq}`,
    recentActivity: recentBugReportActivity,
    storageConfigured: () => configured,
    upload: async (path) => void uploaded.push(path),
    remove: async (path) => void removed.push(path),
    insert: insertBugReport,
  };
  const send = (userId: string, extra: Record<string, unknown> = {}) =>
    submitBugReport(deps, { userId, description: "chart is blank", pagePath: "/picks", userAgent: "UA", screenshot: null, ...extra });

  try {
    for (const id of [userA, userB]) {
      await prisma.user.create({ data: { id, supabaseId: `${id}-sb`, email: `${id}@example.invalid` } });
    }

    // 1. A report with a screenshot lands as a row with its server-built path.
    expect("submit with screenshot -> saved", await send(userA, { screenshot: WEBP }), { ok: true, screenshot: "saved" });
    const row1 = await prisma.bugReport.findUnique({ where: { id: `${PREFIX}rep1` } });
    expect("row stored: OPEN, path, text fields", [row1?.status, row1?.screenshotPath, row1?.description, row1?.pagePath, row1?.userId], ["OPEN", `${userA}/${PREFIX}rep1.webp`, "chart is blank", "/picks", userA]);
    expect("the object was uploaded to that path", uploaded, [`${userA}/${PREFIX}rep1.webp`]);

    // 2. The 60 s gap is enforced from the database; after it, a text-only fallback.
    const tooSoon = await send(userA);
    expect("an immediate second report is denied", tooSoon.ok, false);
    clock += 61_000;
    configured = false;
    expect("bucket/key missing -> report saved as text", await send(userA, { screenshot: WEBP }), { ok: true, screenshot: "unavailable" });
    const row2 = await prisma.bugReport.findUnique({ where: { id: `${PREFIX}rep2` } });
    expect("fallback row has no screenshot path", row2?.screenshotPath, null);
    expect("nothing uploaded in the fallback", uploaded.length, 1);
    configured = true;

    // 3. Daily cap: reports 3, 4, 5 go through, the 6th is denied; user B is unaffected.
    for (let i = 3; i <= 5; i++) {
      clock += 61_000;
      expect(`report ${i} ok`, (await send(userA)).ok, true);
    }
    clock += 61_000;
    const sixth = await send(userA);
    expect("6th report in 24 h denied", sixth.ok, false);
    expect("count in the window is 5 and the 6th wrote no row", [(await recentBugReportActivity(userA, new Date(clock - 86_400_000))).count, await prisma.bugReport.count({ where: { userId: userA } })], [5, 5]);
    expect("another user is not limited by A's reports", (await send(userB)).ok, true);
    clock += 24 * 3_600_000 + 1;
    expect("after 24 h the limit resets", (await send(userA)).ok, true);

    // 4. The admin list: open first then newest, path only (no bytes), our user's email.
    await markBugReportResolved(`${PREFIX}rep1`);
    const list = await listBugReportsForAdmin();
    const ours = list.filter((r) => r.id.startsWith(PREFIX));
    expect("admin list has our reports", ours.length > 0, true);
    const statuses = list.map((r) => r.status);
    expect("admin list: every OPEN before any RESOLVED", statuses.indexOf("RESOLVED") === -1 || statuses.lastIndexOf("OPEN") < statuses.indexOf("RESOLVED"), true);
    const r1 = list.find((r) => r.id === `${PREFIX}rep1`);
    expect("resolved report: status RESOLVED, screenshot path cleared", [r1?.status, r1?.screenshotPath], ["RESOLVED", null]);
    const r2 = list.find((r) => r.id === `${PREFIX}rep2`);
    expect("list row carries the sender's email and no image data", [r2?.user.email, Object.keys(r2 ?? {}).sort()], [`${userA}@example.invalid`, ["createdAt", "description", "id", "pagePath", "screenshotPath", "status", "user", "userAgent"]]);
    const openOurs = ours.filter((r) => r.status === "OPEN");
    expect("our open reports are newest-first", openOurs.every((r, i) => i === 0 || openOurs[i - 1].createdAt >= r.createdAt), true);

    // 5. RLS: on, with no policies.
    const rls = await prisma.$queryRaw<{ relrowsecurity: boolean }[]>`SELECT relrowsecurity FROM pg_class WHERE relname = 'bug_reports'`;
    const policies = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_policies WHERE tablename = 'bug_reports'`;
    expect("bug_reports has RLS enabled and no policies", [rls[0]?.relrowsecurity, Number(policies[0]?.n)], [true, 0]);
  } finally {
    for (const id of [userA, userB]) await prisma.user.delete({ where: { id } }).catch(() => {});
  }
  const left = await prisma.bugReport.count({ where: { id: { startsWith: PREFIX } } });
  expect("deleting the users removed their reports (cascade)", left, 0);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failures > 0) {
      console.log(`\n${failures} FAILED`);
      process.exit(1);
    }
    console.log("\nBug report DB checks passed.");
  });
