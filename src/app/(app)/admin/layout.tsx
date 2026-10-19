import { AdminTabs } from "@/components/admin/admin-tabs";
import { requireAdminOpsPage } from "@/server/admin-gate";
import type { AdminTabAlerts } from "@/lib/admin-tabs";

// The ops console shell: gate, title, tab row. Each page under here ALSO calls
// requireAdminOpsPage (see admin-gate.ts for why the layout alone isn't enough).
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminOpsPage();

  // Red dots per tab. Each tab's PR adds its own cheap "anything wrong?" read
  // here; none is wired yet, so DB Monitor's flags show on its own page only.
  const alerts: AdminTabAlerts = {};

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Ops console</p>
        <AdminTabs alerts={alerts} />
      </div>
      {children}
    </div>
  );
}
