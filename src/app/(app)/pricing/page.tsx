import { requireUser } from "@/server/auth";
import { getEntitlementsForUser } from "@/server/data/subscriptions";
import { PricingCards } from "@/components/billing/pricing-cards";

export default async function PricingPage({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
  const user = await requireUser();
  const entitlements = await getEntitlementsForUser(user.id);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Plans &amp; billing</h1>
        <p className="mt-1 text-sm text-gray-500">
          Test mode - no real charges. Upgrades use Stripe Checkout.
        </p>
      </div>

      <PricingCards currentTier={entitlements.tier} checkoutStatus={searchParams.checkout} />
    </div>
  );
}
