import type { MonitorView } from "@/lib/db-monitor";

// Pure half of the ops console's red dots: each tab's rule turns that tab's
// small status read into a one-line reason, or null for no dot. The reads and
// the cache are in src/server/data/admin-status.ts; every number a rule
// compares against is in src/lib/admin-thresholds.ts. The rules themselves
// are listed in docs/design/ops-console.md.

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// DB Monitor: any statement in the top list with a red flag. The view is
// built at the default threshold (never a page's ?threshold=), and an
// expected-heavy read under its ceiling carries no flag, so it doesn't count.
export function dbMonitorAlert(view: MonitorView): string | null {
  const flagged = view.rows.filter((r) => r.flags.length > 0);
  if (flagged.length === 0) return null;
  const top = flagged[0];
  return `${plural(flagged.length, "flagged statement")}; first: ${top.label ?? "Unlabeled"} - ${top.flags[0].reason}`;
}

// A check that threw: still a dot, so a broken status read isn't silent.
export function checkFailedAlert(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).split("\n").filter(Boolean).pop() ?? "unknown error";
  return `Status check failed: ${msg.slice(0, 160)}`;
}
