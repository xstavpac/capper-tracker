import { prisma } from "@/lib/prisma";

// Bug-report reads/writes. Every row query is scoped by id or by userId; the
// admin list is the one cross-user read and is reached only from the admin gate.

export async function recentBugReportActivity(userId: string, since: Date) {
  const where = { userId, createdAt: { gte: since } };
  const [count, latest] = await Promise.all([
    prisma.bugReport.count({ where }),
    prisma.bugReport.findFirst({ where, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  return { count, latestAt: latest?.createdAt ?? null };
}

export async function insertBugReport(row: {
  id: string;
  userId: string;
  description: string;
  pagePath: string | null;
  userAgent: string | null;
  screenshotPath: string | null;
}) {
  await prisma.bugReport.create({ data: row });
}

export const ADMIN_BUG_REPORT_LIMIT = 100;

// Open first, then newest. No image bytes: only the path, to show a "view" button.
export async function listBugReportsForAdmin() {
  return prisma.bugReport.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: ADMIN_BUG_REPORT_LIMIT,
    select: {
      id: true,
      description: true,
      pagePath: true,
      userAgent: true,
      screenshotPath: true,
      status: true,
      createdAt: true,
      user: { select: { email: true } },
    },
  });
}

export async function getBugReportScreenshotPath(id: string): Promise<string | null> {
  const row = await prisma.bugReport.findUnique({ where: { id }, select: { screenshotPath: true } });
  return row?.screenshotPath ?? null;
}

export async function markBugReportResolved(id: string) {
  await prisma.bugReport.update({ where: { id }, data: { status: "RESOLVED", screenshotPath: null } });
}
