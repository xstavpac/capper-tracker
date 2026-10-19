import { cache } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { isFeatureEnabledForUser, ADMIN_OPS_CONSOLE_FLAG_KEY } from "@/server/data/feature-flags";

// The one gate for the /admin ops console. The layout, every page under it and
// every admin server action call one of the two functions below - never the
// flag check directly - so a new tab or action can't pick a different gate.
//
// Uncached across requests (the direct isFeatureEnabledForUser read, same as
// /zone-model), so revoking the override closes the console on the next
// request. cache() only shares the answer within ONE request, where the layout
// and the page both ask.
//
// The pages check too, not just the layout: a layout is not re-rendered on
// every navigation between its children, so it can't be the only guard.
const loadAdminOpsUser = cache(async () => {
  const user = await requireUser();
  return (await isFeatureEnabledForUser(ADMIN_OPS_CONSOLE_FLAG_KEY, user.id)) ? user : null;
});

// Layouts and pages: a non-admin gets the same 404 as a route that doesn't exist.
export async function requireAdminOpsPage() {
  const user = await loadAdminOpsUser();
  if (!user) notFound();
  return user;
}

// Server actions: they are public POST endpoints, so each one re-checks.
export async function requireAdminOpsAction() {
  const user = await loadAdminOpsUser();
  if (!user) throw new Error("Not found");
  return user;
}
