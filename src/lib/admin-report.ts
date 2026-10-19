// "Copy for Claude" for the ops console tabs: plain text in the DB Monitor
// report's shape (a title line, header lines, then numbered items, each with
// its [FLAG] lines and detail lines indented under it), so every tab's export
// reads the same in a chat or a Claude Code prompt.
//
// No user ids or emails: callers never pass them, and maskIdentifiers below
// is the backstop for anything that slips into free text (bet text, raw
// import lines, error messages). Pick ids go in shortened (shortId).

export type ReportItem = {
  title: string;
  flags?: string[];
  lines?: string[];
};

export type ReportSection = {
  heading?: string;
  items: ReportItem[];
  // Printed instead of the items when there are none.
  empty?: string;
};

export type AdminReport = {
  title: string;
  header: string[];
  sections: ReportSection[];
};

// Emails, cuids (Prisma ids: c + 24 lowercase alphanumerics) and uuids,
// wherever they appear in free text.
const IDENTIFIER = /[^\s@'"<>(),]+@[^\s@'"<>(),]+\.[A-Za-z]{2,}|\bc[a-z0-9]{24}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function maskIdentifiers(text: string): string {
  return text.replace(IDENTIFIER, "<redacted>");
}

// The last 6 characters - enough to find a row again, not a full id.
export function shortId(id: string): string {
  return "…" + id.slice(-6);
}

export function formatAdminReport(report: AdminReport): string {
  const out: string[] = [report.title, ...report.header];
  for (const section of report.sections) {
    out.push("");
    if (section.heading) out.push(`${section.heading}:`);
    if (section.items.length === 0) {
      out.push(`   ${section.empty ?? "(none)"}`);
      continue;
    }
    section.items.forEach((item, i) => {
      const flags = item.flags ?? [];
      out.push(`${i + 1}. ${flags.length ? "[FLAG] " : ""}${item.title}`);
      for (const f of flags) out.push(`   [FLAG] ${f}`);
      for (const l of item.lines ?? []) out.push(`   ${l}`);
    });
  }
  return maskIdentifiers(out.join("\n"));
}
