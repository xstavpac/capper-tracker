import { redirect } from "next/navigation";
import { requireAdminOpsPage } from "@/server/admin-gate";
import { ADMIN_HOME_HREF } from "@/lib/admin-tabs";

// /admin itself has no content: it opens the first tab.
export default async function AdminIndexPage() {
  await requireAdminOpsPage();
  redirect(ADMIN_HOME_HREF);
}
