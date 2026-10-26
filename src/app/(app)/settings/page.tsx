import { requireUser } from "@/server/auth";
import { getEntitlementsForUser, getSubscriptionForUser } from "@/server/data/subscriptions";
import { BillingSummary } from "@/components/billing/billing-summary";
import { ThemeToggle } from "@/components/settings/theme-toggle";
import { BugReportCard } from "@/components/settings/bug-report-card";
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

      <div className="mb-6">
        <BugReportCard />
      </div>

      {/* Data-source attribution. The nflverse credit is a CC-BY-4.0 license
          requirement, not optional - it must name the source, link the
          license, and indicate the data is adapted (we join/derive rather
          than reproduce verbatim). Here rather than on one feature page so it
          stays put whichever pages show the data. */}
      <p className="text-xs text-muted-foreground">
        MLB team stats via the MLB Stats API. NFL team stats derived from{" "}
        <a
          href="https://github.com/nflverse/nflverse-data"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          nflverse
        </a>{" "}
        data, licensed{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          CC-BY-4.0
        </a>
        .
      </p>
    </div>
  );
}
