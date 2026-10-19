import { AdminTabs } from "@/components/admin/admin-tabs";
import { requireAdminOpsPage } from "@/server/admin-gate";
import { getAdminStatus } from "@/server/data/admin-status";

// The ops console shell: gate, title, tab row. Each page under here ALSO calls
// requireAdminOpsPage (see admin-gate.ts for why the layout alone isn't enough).
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminOpsPage();

  // Red dots per tab, with a one-line reason each: a small cached summary
  // (see server/data/admin-status.ts), read only after the gate passes.
  const alerts = await getAdminStatus();

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
