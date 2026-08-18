import { requireUser } from "@/server/auth";
import { getEntitlementsForUser, getSubscriptionForUser } from "@/server/data/subscriptions";
import { BillingSummary } from "@/components/billing/billing-summary";
import { ThemeToggle } from "@/components/settings/theme-toggle";
import { formatEastern } from "@/lib/dates";

export default async function SettingsPage() {
  const user = await requireUser();
  const [entitlements, subscription] = await Promise.all([
    getEntitlementsForUser(user.id),
    getSubscriptionForUser(user.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>

      <div className="mb-6">
        <BillingSummary
          tier={entitlements.tier}
          status={entitlements.status}
          cancelAtPeriodEnd={entitlements.cancelAtPeriodEnd}
          currentPeriodEnd={
            entitlements.currentPeriodEnd
              ? formatEastern(entitlements.currentPeriodEnd, { month: "short", day: "numeric", year: "numeric" })
              : null
          }
          hasStripeCustomer={Boolean(subscription?.stripeCustomerId)}
        />
      </div>

      <div className="mb-6">
        <ThemeToggle />
      </div>
    </div>
  );
}
